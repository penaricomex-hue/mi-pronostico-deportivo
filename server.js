const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const ruta = require('ruta');
dejar Piscina;
intentar {
  Pool = require('pg').Pool;
} capturar (e) {
  Piscina = nulo;
}

// Importar motor o usar fallback interno autónomo
dejar motor;
intentar {
  motor = requerir('./motor');
} capturar (e) {
  motor = {
    clamp: (val, min, max) => Math.max(min, Math.min(max, val)),
    shrinkToMean: (val, baseline, n = 10) => {
      const peso = n / (n + 4);
      devolver peso * val + (1 - peso) * línea base;
    },
    implícito: (odds) => odds > 1 ? Number(((1 / odds) * 100).toFixed(1)) : null,
    ev: (p, probabilidades) => {
      const prob = p > 1 ? p / 100 : p;
      return Number(((prob * odds - 1) * 100).toFixed(1));
    },
    confianza: (prob, n = 10) => {
      const p = prob > 1 ? prob / 100 : prob;
      const muestra = Math.min(1, Math.max(0.4, n / 10));
      return Math.round(Math.min(95, Math.max(20, (35 + ((p - 0.33) / 0.45) * 55) * sample)));
    },
    matchModel: (homeXg, awayXg) => {
      const hXg = Math.max(0.1, Number(homeXg) || 1.3);
      const aXg = Math.max(0.1, Number(awayXg) || 1.1);
      función p(k, l) {
        sea ​​f = 1; para (sea i = 2; i <= k; i++) f *= i;
        devolver (Math.exp(-l) * Math.pow(l, k)) / f;
      }
      sea ​​hw = 0, d = 0, aw = 0, o25 = 0, u25 = 0, btts = 0;
      para (sea h = 0; h <= 7; h++) {
        para (sea a = 0; a <= 7; a++) {
          const prob = p(h, hXg) * p(a, aXg);
          si (h > a) hw += prob; si no si (h === a) d += prob; si no aw += prob;
          si (h + a >= 3) o25 += prob; de lo contrario u25 += prob;
          si (h >= 1 && a >= 1) btts += prob;
        }
      }
      const total = hw + d + aw;
      return { victoria local: hw / total, sorteo: d / total, victoria visitante: aw / total, over25: o25, under25: u25, btts };
    }
  };
}

const {
  Modelo de coincidencia,
  implícito,
  ev,
  confianza,
  encogerParaSignificar,
  abrazadera
} = motor;

const app = express();
const PUERTO = proceso.env.PUERTO || 3000;

app.use(express.json());

/* =========================================================
   ACCESO PRIVADO (usuario/contraseña)
========================================================== */
const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

función timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.longitud!== bufB.longitud) {
    crypto.timingSafeEqual(bufA, bufA);
    devolver falso;
  }
  devolver crypto.timingSafeEqual(bufA, bufB);
}

Si (APP_USERNAME && APP_PASSWORD) {
  app.use((req, res, next) => {
    // Permitir chequeo de salud y descargas públicas
    Si (req.path === '/health' || req.path === '/api/download-server') devuelve next();

    const header = req.headers.authorization || '';
    const [esquema, codificado] = encabezado.split(' ');
    si (esquema === 'Básico' && codificado) {
      const decodificado = Buffer.from(codificado, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
      Si (timingSafeEqual(usuario, APP_USERNAME) && timingSafeEqual(contraseña, APP_PASSWORD)) {
        devolver siguiente();
      }
    }
    res.set('WWW-Authenticate', 'Basic kingdom="Mi Pronóstico Deportivo"');
    return res.status(401).send('Acceso restringido.');
  });
  console.log('[AUTH] Acceso protegido con usuario/contraseña activado.');
}

const MODEL_VERSION = 'V8.0.0';
const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BIGBALLS_KEY = process.env.BIGBALLS_KEY || '';

const MAPA_LIGA_BALLS_BIGBALLS = {
  PD: 'laliga',
  PL: 'epl',
  FL1: 'ligue1',
  SA: 'serie_a',
  BL1: 'bundesliga',
  CL: 'cl',
  EL: 'el'
};

/* =========================================================
   1. VENTAJA DE LOCAL DINÁMICA Y APRENDIDA (V8.0)
   Ventaja de local = promedio histórico de goles local / goles visitante
   de esa competición, suavizado (shrinkage) hacia la media global (1.09x).
========================================================== */
const GLOBAL_HOME_ADVANTAGE_BASELINE = 1.09;
const learnedHomeAdvantage = new Map();

// Priors iniciales calibrados estadísticamente
const HOME_ADVANTAGE_PRIORS = {
  PD: 1.13, // LaLiga
  SA: 1.12, // Serie A
  EL: 1.12, // Europa League
  BL1: 1.10, // Bundesliga
  CL: 1.09, // Liga de Campeones
  FL1: 1.08, // Ligue 1
  PL: 1.07 // Premier League
};

función actualizarVentajaHomeAprendida(códigoCompetición, coincidencias) {
  Si (!competitionCode || !Array.isArray(matches) || matches.length < 5) regresar;
  sea ​​homeGoals = 0;
  dejar objetivos = 0;
  sea ​​contador = 0;

  para (const m de coincidencias) {
    const hg = Number(m.score?.fullTime?.home ?? m.homeGoals ?? m.goalsHome);
    const ag = Number(m.score?.fullTime?.away ?? m.awayGoals ?? m.goalsAway);
    Si (Number.isFinite(hg) && Number.isFinite(ag)) {
      objetivos_inicio += hg;
      Goles de visitante += ag;
      recuento++;
    }
  }

  si (count >= 5 && awayGoals > 0) {
    const rawRatio = homeGoals / Math.max(awayGoals, 1);
    // Suavizado bayesiano con 12 pseudo-observaciones hacia la media global
    const peso = contador / (contador + 12);
    const suavizado = peso * rawRatio + (1 - peso) * GLOBAL_HOME_ADVANTAGE_BASELINE;
    const clamped = Math.max(1.03, Math.min(1.22, Number(smoothed.toFixed(3))));
    learnedHomeAdvantage.set(competitionCode, {
      factor: sujeto,
      Tamaño de la muestra: recuento,
      rawRatio: Número(rawRatio.toFixed(3)),
      actualizadoEn: Fecha.ahora()
    });
  }
}

función obtenerVentajaHome(códigoCompetición) {
  const learned = learnedHomeAdvantage.get(competitionCode);
  si (aprendido && factor.aprendido) {
    devolver factor aprendido;
  }
  devolver HOME_ADVANTAGE_PRIORS[competitionCode] || GLOBAL_HOME_ADVANTAGE_BASELINE;
}

/* =========================================================
   CACHÉÉ MULTINIVEL CON TTLs INDEPENDIENTE (V8.0)
   Evita que cuotas o partidos se congelen las 24 horas.
========================================================== */
const CACHE_TTLS = {
  cuotas: 3, // Cuotas de casas de apuestas: 3 minutos
  análisis: 15, // Análisis recalculable: 15 minutos
  Calendario: 25, // Calendario del día favoritos: 25 minutos
  lesiones: 90, // Bajas y lesiones: 90 minutos (1,5 horas)
  historia: 240, // Historial y H2H: 4 horas
  equipos: 1440, // Nombres de equipos y ligas: 24 horas
  valor predeterminado: 30
};

const STAKE_EUR = Number(process.env.STAKE_EUR) || 10;
const DATABASE_URL = process.env.DATABASE_URL || '';

const pool = (URL_BASE_DE_DATOS && Pool)
  ? nuevo Pool({
      cadena de conexión: URL_DE_LA_BASE_DE_DATOS,
      ssl: process.env.NODE_ENV === 'production' || DATABASE_URL.includes('render')
        ? { rechazarNo autorizado: falso }
        : FALSO
    })
  : nulo;

si (pool) {
  pool.on('error', (err) => {
    console.warn('[DB] Cliente PostgreSQL en segundo plano reconectando:', err.message);
  });
}

función asíncrona ensureSchema() {
  si (!pool) regresar;
  intentar {
    esperar pool.query(`
      CREAR TABLA SI NO EXISTE apuestas_simuladas (
        ID CLAVE PRIMARIA SERIAL,
        creado_en TIMESTAMPTZ NO NULO PREDETERMINADO ahora(),
        fecha_coincidencia FECHA,
        Inicio TEXTO NO NULO,
        lejos TEXTO NO NULO,
        texto de la competición,
        TEXTO DEL MERCADO NO NULO,
        Resultado TEXTO NO NULO,
        nombre_mercado TEXTO NO NULO,
        probabilidades NUMÉRICAS NO NULAS,
        modelo_probabilidad NUMÉRICO,
        stake_eur NUMÉRICO NO NULO PREDETERMINADO 10,
        estado TEXTO NO NULO PREDETERMINADO 'pendiente',
        beneficio_eur NUMÉRICO,
        establecido_en HIMESTAMPTZ,
        piernas_json JSONB
      );
    `);
    console.log('[DB] Esquema verificado (apuestas_simuladas).');
  } catch (error) {
    console.error('[DB] Error al crear esquema:', error.message);
  }
}

const ODDS_SPORT_BY_COMPETITION = {
  PL: 'soccer_epl',
  PD: 'fútbol_españa_la_liga',
  BL1: 'soccer_germany_bundesliga',
  SA: 'soccer_italy_serie_a',
  FL1: 'fútbol_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
  EL: 'soccer_uefa_europa_league'
};

const COMPETITIONS = Object.keys(ODDS_SPORT_BY_COMPETITION);
const caché = nuevo Mapa();

función obtenerTtlMinutos(categoría) {
  si (typeof category === 'number') devolver categoría;
  devolver CACHE_TTLS[categoría] || CACHE_TTLS.predeterminado;
}

función cacheGet(clave) {
  const item = cache.get(key);
  Si (!elemento) devuelve null;
  const maxAgeMs = (item.ttlMinutes || CACHE_TTLS.default) * 60 * 1000;
  Si (Fecha.ahora() - item.hora > maxAgeMs) {
    caché.eliminar(clave);
    devolver nulo;
  }
  devolver item.data;
}

función cacheGetTimestamp(clave) {
  const item = cache.get(key);
  Si (!elemento) devuelve null;
  const maxAgeMs = (item.ttlMinutes || CACHE_TTLS.default) * 60 * 1000;
  Si (Fecha.ahora() - item.tiempo > maxAgeMs) devuelve null;
  devolver artículo.tiempo;
}

función cacheSet(clave, datos, categoría = 'predeterminado') {
  const ttlMinutes = getTtlMinutes(category);
  cache.set(key, { time: Date.now(), data, ttlMinutes });
  devolver datos;
}

función cacheSetIfNotEmpty(clave, datos, categoría = 'predeterminado') {
  Si (Array.isArray(data) && data.length === 0) devolver data;
  devolver cacheSet(clave, datos, categoría);
}

función normalizarNombre(valor) {
  devolver String(valor || '')
    .toLowerCase()
    .normalizar('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const TEAM_NAME_STOPWORDS = new Set([
  'fc', 'cf', 'afc', 'ac', 'cd', 'sc', 'ec', 'ud', 'rc', 'ca',
  'club', 'el', 'de', 'de', 'triste', 'sa', 'cfr', 'si'
]);

función nameTokens(valor) {
  devolver String(valor || '')
    .toLowerCase()
    .normalizar('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .recortar()
    .split(/\s+/)
    .filter(Booleano)
    .filter(token => !TEAM_NAME_STOPWORDS.has(token));
}

función tokenFoundIn(palabra, listaToken) {
  para (const token de tokenList) {
    Si (token === palabra) devolver verdadero;
    if (word.length >= 4 && token.length >= 4 && (token.includes(word) || word.includes(token))) {
      devolver verdadero;
    }
  }
  devolver falso;
}

función namesMatch(a, b) {
  const fullA = normalizeName(a);
  const fullB = normalizeName(b);
  Si (!fullA || !fullB || fullA.length < 3 || fullB.length < 3) devolver falso;
  Si (fullA === fullB) devolver verdadero;
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  Si (!tokensA.length || !tokensB.length) devuelve falso;
  const [shortSide, longSide] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return shortSide.every(word => tokenFoundIn(word, longSide));
}

/* =========================================================
   BIG BALLS API & PREDICCIONES
========================================================== */
función asíncrona bigBallsRequest(ruta) {
  Si (!BIGBALLS_KEY) devuelve null;
  const key = `bigballs:${path}`;
  const cached = cacheGet(key);
  si (cached) devolver cached;
  intentar {
    const respuesta = await fetch(`https://api.bigballsdata.com${path}`, {
      encabezados: { 'Authorization': `Bearer ${BIGBALLS_KEY}` }
    });
    si (!respuesta.ok) {
      console.warn(`[BIGBALLS] ${path} -> HTTP ${response.status}`);
      devolver nulo;
    }
    const datos = esperar respuesta.json();
    devolver cacheSetIfNotEmpty(clave, datos);
  } catch (error) {
    console.warn('[BIGBALLS] error:', path, error.message);
    devolver nulo;
  }
}

función asíncrona getBigBallsTeams(bbLeagueKey) {
  const data = await bigBallsRequest(`/v1/teams?sport=football&league=${bbLeagueKey}`);
  devolver Array.isArray(datos?.datos)? datos.datos: [];
}

función asíncrona getBigBallsInjuries(bbLeagueKey) {
  const data = await bigBallsRequest(`/v1/injuries?sport=football&league=${bbLeagueKey}`);
  return Array.isArray(datos?.datos?.lesiones?.valor)? datos.datos.lesiones.valor: [];
}

función asíncrona getInjuryDataForTeam(teamName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];
  if (!bbLeagueKey || !BIGBALLS_KEY) return { count: 0, details: [] };
  const cacheKey = `injuries:${bbLeagueKey}:${teamName}`;
  const cached = cacheGet(cacheKey);
  si (cached) devolver cached;

  intentar {
    const [equipos, lesiones] = esperar Promise.all([
      obtenerBigBallsTeams(bbLeagueKey),
      obtenerLesionesDeGrandesBolas(bbLeagueKey)
    ]);
    const matchedTeam = teams.find(t => namesMatch(t?.name, teamName));
    if (!matchedTeam?.id) return { count: 0, details: [] };
    const teamInjuries = injuries.filter(inj => inj?.current_team_id === matchedTeam.id);
    const resultado = {
      recuento: lesionesdelequipo.longitud,
      detalles: teamInjuries.map(i => ({
        jugador: i?.player_name || i?.name || 'Jugador',
        posición: (i?.posición || i?.rol || '').toLowerCase(),
        estado: i?.estado || 'Baja'
      }))
    };
    cacheSet(cacheKey, result, 'injuries');
    devolver resultado;
  } catch (error) {
    devolver { count: 0, details: [] };
  }
}

/* =========================================================
   2. CÁLCULO DE LESIONES PONDERADO POR IMPORTANCIA (V8.0)
   - Portero titular: afecta defensa (+vulnerabilidad)
   - Delanteros / goleadores: afecta ataque
   - Defensas / medios: impacto repartido
   - Impacto máximo global acotado al 8% (clamp 0.92.. 1.0)
========================================================== */
función asíncrona applyInjuryAdjustment(homeStats, awayStats, homeName, awayName, competitionCode) {
  intentar {
    const [homeData, awayData] = esperar Promise.all([
      getInjuryDataForTeam(nombre de casa, código de competencia),
      getInjuryDataForTeam(nombre ausente, código de competencia)
    ]);

    función computeTeamInjuryFactor(datos) {
      if (!data || !data.count) return { attackFactor: 1.0, defenseFactor: 1.0, count: 0 };
      sea ​​attackPenalty = 0;
      sea ​​penalización de defensa = 0;

      para (const item de (data.details || [])) {
        const pos = item.position;
        if (pos.includes('goalkeeper') || pos.includes('portero') || pos.includes('gk')) {
          defensaPenalización += 0,035; // Portero: vulnerabilidad defensiva
        } else if (pos.includes('forward') || pos.includes('delantero') || pos.includes('striker') || pos.includes('att')) {
          penalización de ataque += 0,03; // Delantero
        } else if (pos.includes('defen') || pos.includes('cb') || pos.includes('lb') || pos.includes('rb')) {
          defensaPenalización += 0,02; // defensa
        } demás {
          penalización por ataque += 0,015;
          penalización de defensa += 0,015;
        }
      }

      // Si no tenemos desglose por posición, aplique estimación suave de 0.015 por baja
      Si (!data.details || !data.details.length) {
        penalizaciónAtaque = data.count * 0.018;
        penalización de defensa = data.count * 0,018;
      }

      // Acotamos el impacto máximo a un 8% (0,92) para evitar sobreajuste destructivo
      const attackFactor = clamp(1 - attackPenalty, 0.92, 1.0);
      const defenseFactor = clamp(1 - defensePenalty, 0.92, 1.0);

      devolver { attackFactor, defenseFactor, count: data.count };
    }

    const homeAdj = computeTeamInjuryFactor(homeData);
    const awayAdj = computeTeamInjuryFactor(awayData);

    devolver {
      homeStats: {
        ...homeStats,
        Fuerza de ataque: homeStats.fuerza de ataque * homeAdj.factor de ataque,
        Fuerza de defensa: homeStats.fuerza de defensa * homeAdj.factor de defensa
      },
      awayStats: {
        ...awayStats,
        fuerzaAtaque: awayStats.fuerzaAtaque * awayAdj.factorAtaque,
        fuerza de defensa: awayStats.fuerza de defensa * awayAdj.factor de defensa
      },
      Lesiones en el hogar: recuento ajustado en el hogar,
      Lesiones fuera: recuento ajustado fuera
    };
  } catch (error) {
    devolver { homeStats, awayStats, homeInjuries: 0, awayInjuries: 0 };
  }
}

/* =========================================================
   3. DESCANSO Y FATIGA ASIMÉTRICA Y SUAVE (V8.0)
   - Fatiga defensiva (desajuste táctico/repliegue) > fatiga ofensiva
   - Curva continua y acotada, sin saltos binarios irreales
========================================================== */
función calcularDíasDescansadosDesdePartidos(partidos, fechaUtcdepartido) {
  Si (!Array.isArray(matches) || !matches.length) devuelve null;
  const targetTime = matchUtcDate ? new Date(matchUtcDate).getTime() : Date.now();

  const PartidasPasadas = coincidencias
    .filter(m => m.utcDate && new Date(m.utcDate).getTime() < targetTime)
    .sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime());

  Si (!pastMatches.length) devuelve null;

  const lastMatchTime = new Date(pastMatches[0].utcDate).getTime();
  const diffDays = Math.max(0, Math.floor((targetTime - lastMatchTime) / (1000 * 60 * 60 * 24)));
  devolver días de diferencia;
}

función obtenerRestFatigaImpact(restDays) {
  si (restDays == null) {
    return { attackFactor: 1.0, defenseFactor: 1.0, label: 'Sin datos', impactPct: 0 };
  }
  // ≤2 días: fatiga severa (defensa sufre más: -4.5%, ataque pierde frescura: -3.5%)
  si (días de descanso <= 2) {
    return { attackFactor: 0.965, defenseFactor: 0.955, label: 'Fatiga severa (≤2 días)', impactPct: -4 };
  }
  // 3 días: descanso ajustado
  si (días de descanso === 3) {
    return { attackFactor: 0.98, defenseFactor: 0.975, label: 'Descanso justo (3 días)', impactPct: -2.5 };
  }
  // 4 días: ritmo competitivo casi pleno
  si (días de descanso === 4) {
    return { attackFactor: 0.99, defensaFactor: 0.99, label: 'Descanso adecuado (4 días)', impactPct: -1 };
  }
  // 5 a 12 días: óptimo
  Si (días de descanso >= 5 y días de descanso <= 12) {
    return { attackFactor: 1.0, defenseFactor: 1.0, label: `Óptimo (${restDays}d)`, impactPct: 0 };
  }
  // > 12 días: leve falta de ritmo competitivo
  return { AttackFactor: 0.985, DefenseFactor: 0.99, etiqueta: `Inactividad prolongada (${restDays}d)`, impactPct: -1.5 };
}

función applyCalculatedRestAdjustment(homeStats, awayStats, homeRestDays, awayRestDays) {
  const homeImpact = getRestFatigaImpact(homeRestDays);
  const awayImpact = getRestFatigaImpact(awayRestDays);

  devolver {
    homeStats: {
      ...homeStats,
      attackStrength: clamp(homeStats.attackStrength * homeImpact.attackFactor, 0.45, 1.8),
      defensaFuerza: clamp(homeStats.defenseStrength * homeImpact.defenseFactor, 0.45, 1.8)
    },
    awayStats: {
      ...awayStats,
      attackStrength: clamp(awayStats.attackStrength * awayImpact.attackFactor, 0.45, 1.8),
      defensaFuerza: clamp(awayStats.defenseStrength * awayImpact.defenseFactor, 0.45, 1.8)
    },
    homeRest: { días: homeRestDays, estado: homeImpact.label, impactPct: homeImpact.impactPct },
    awayRest: { días: awayRestDays, estado: awayImpact.label, impactPct: awayImpact.impactPct }
  };
}

/* =========================================================
   4. PREDICCIONES BIG BALLS - SEGUNDA OPINIÓN PURAMENTE EXTERNA
   Ya no modifica el puntaje de confianza ni la probabilidad del modelo.
========================================================== */
función asíncrona getBigBallsPrediction(homeName, awayName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];
  Si (!bbLeagueKey || !BIGBALLS_KEY) devuelve null;
  const cacheKey = `bb-pred:${bbLeagueKey}:${homeName}:${awayName}`;
  const cached = cacheGet(cacheKey);
  si (cached) devolver cached;

  intentar {
    const data = await bigBallsRequest(`/v1/predictions?sport=football&league=${bbLeagueKey}`);
    const lista = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.predictions) ? data.predictions : []);
    Si (!list.length) devuelve null;

    const matched = list.find(p => {
      const h = p?.home_team || p?.home_team_name || p?.home;
      const a = p?.away_team || p?.away_team_name || p?.away;
      devolver namesMatch(h, homeName) && namesMatch(a, awayName);
    });

    Si (!coincide) devuelve null;

    const hp = Number(matched.home_win_probability ?? matched.home_prob ?? matched.home_win ?? 0);
    const dp = Number(matched.draw_probability ?? matched.draw_prob ?? matched.draw ?? 0);
    const ap = Number(matched.away_win_probability ?? matched.away_prob ?? matched.away_win ?? 0);

    const ganador = matched.predicted_winner || matched.pick ||
      (hp > ap && hp > dp ? 'home' : (ap > hp && ap > dp ? 'away' : 'draw'));

    const resultado = {
      homeProb: Math.round(hp <= 1 ? hp * 100 : hp),
      drawProb: Math.round(dp <= 1 ? dp * 100 : dp),
      awayProb: Math.round(ap <= 1 ? ap * 100 : ap),
      Ganador previsto: ganador
    };
    cacheSet(cacheKey, result, 'analysis');
    devolver resultado;
  } capturar (error) {
    console.warn('[PREDICCIONES DE BIGBALLS]', err.message);
    devolver nulo;
  }
}

función evaluarSegundaOpinión(modelo, bbPred) {
  si (!bbPred) devolver null;

  const mkWinner = (model.homeWin > model.awayWin && model.homeWin > model.draw)
    ? 'hogar'
    : ((model.awayWin > model.homeWin && model.awayWin > model.draw) ? 'away' : 'draw');

  const mkProbMap = { home: model.homeWin, draw: model.draw, away: model.awayWin };
  const bbProbMap = { home: bbPred.homeProb, draw: bbPred.drawProb, away: bbPred.awayProb };

  const acuerdo = mkWinner === bbPred.predictedWinner;
  const labels = { home: 'Local', draw: 'Empate', away: 'Visitante' };

  const mkProbPct = Math.round((mkProbMap[mkWinner] || 0) * 100);
  const bbProbPct = bbProbMap[bbPred.predictedWinner] || 0;
  const diffPts = bbProbPct - mkProbPct;

  devolver {
    disponible: verdadero,
    está de acuerdo: acuerdo,
    estado: acuerdo ? 'Coincidencia con 2ª opinión' : 'Divergencia (Alerta externa)',
    mkPick: etiquetas[mkWinner],
    mkProb: mkProbPct,
    bbPick: etiquetas[bbPred.predictedWinner] || 'Otro resultado',
    bbProb: bbProbPct,
    diffPts: diffPts > 0 ? `+${diffPts}` : `${diffPts}`,
    confianzaDelta: 0, // V8: ¡0% de contaminaciónón al modelo propio!
    mensaje: acuerdo
      ? `Segunda opinión externa coincide en ${labels[mkWinner]} (${bbProbPct}%).`
      : `Segunda opinión externa proyecta ${labels[bbPred.predictedWinner] || 'opuesto'} (${bbProbPct}%). Discrepancia entre fuentes.`
  };
}

/* =========================================================
   HISTÓRICO H2H
========================================================== */
función asíncrona getBigBallsTeamId(teamName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];
  Si (!bbLeagueKey || !BIGBALLS_KEY) devuelve null;
  intentar {
    const equipos = await getBigBallsTeams(bbLeagueKey);
    const matchedTeam = teams.find(t => namesMatch(t?.name, teamName));
    devolver matchedTeam?.id || null;
  } catch (error) {
    devolver nulo;
  }
}

función asíncrona getH2HDrawRate(homeTeamId, awayTeamId) {
  Si (!homeTeamId || !awayTeamId || !BIGBALLS_KEY) devuelve null;
  intentar {
    const data = await bigBallsRequest(`/v1/teams/${homeTeamId}/h2h-intelligence?opponent=${awayTeamId}`);
    const contexto = datos?.datos || datos;
    const draws = Number(context?.draws ?? context?.draw_count);
    const totalMatches = Number(context?.matches ?? context?.total_matches ?? context?.games_played);
    Si (Number.isFinite(draws) && Number.isFinite(totalMatches) && totalMatches >= 3) {
      devolver sorteos / total de coincidencias;
    }
    devolver nulo;
  } catch (error) {
    devolver nulo;
  }
}

función applyH2HAdjustment(modelo, h2hDrawRate) {
  Si (h2hDrawRate == null || !Number.isFinite(h2hDrawRate)) devuelve el modelo;
  const bump = clamp((h2hDrawRate - model.draw) * 0.3, 0, 0.03);
  si (bump <= 0) devolver modelo;
  const totalOthers = model.homeWin + model.awayWin;
  si (totalOtros <= 0) devolver modelo;
  const homeShare = model.homeWin / totalOthers;
  const awayShare = model.awayWin / totalOthers;
  devolver {
    ...modelo,
    dibujar: model.draw + bump,
    homeWin: model.homeWin - golpe * homeShare,
    awayWin: modelo.awayWin - bump * awayShare
  };
}

función mediana(valores) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  Si (!nums.length) devuelve null;
  const m = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2;
}

función númerosúnicos(valores) {
  return [...new Set(values.map(Number).filter(Number.isFinite).map(v => Number(v.toFixed(4))))];
}

función dateFromISO(valor) {
  Si (!valor) devuelve null;
  const d = new Date(valor);
  devolver Número.isNaN(d.getTime()) ? nulo : d;
}

función datePartUTC(valor) {
  const d = dateFromISO(valor);
  return d ? d.toISOString().slice(0, 10) : null;
}

función asíncrona fetchJson(url, opciones = {}) {
  const res = await fetch(url, options);
  sea ​​datos = nulo;
  try { data = await res.json(); } catch (_) { data = null; }
  si (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = datos;
    lanzar error;
  }
  devolver datos;
}

/* =========================================================
   DATOS DE FÚTBOL
========================================================== */
función asíncrona footballData(path) {
  si (!FOOTBALL_DATA_TOKEN) {
    throw new Error('FOOTBALL_DATA_TOKEN no configurado');
  }
  const key = `football:${path}`;
  const cached = cacheGet(key);
  si (cached) devolver cached;
  const data = await fetchJson(`${FOOTBALL_DATA_BASE}${path}`, {
    encabezados: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
  });
  devolver cacheSet(clave, datos);
}

función asíncrona getCompetitionTeams(competitionCode) {
  const key = `equipos-de-competencia:${código-de-competencia}`;
  const cached = cacheGet(key);
  si (cached) devolver cached;
  intentar {
    const data = await footballData(`/competitions/${competitionCode}/teams`);
    const equipos = Array.isArray(datos?.equipos) ? datos.equipos : [];
    devolver cacheSetIfNotEmpty(clave, equipos);
  } catch (error) {
    devolver [];
  }
}

función asíncrona findTeam(teamName, competitionCode) {
  Si (!teamName || !competitionCode) devuelve null;
  const equipos = await obtenerEquiposDeCompetencia(códigoDeCompetencia);
  Si (!teams.length) devuelve null;
  const target = normalizeName(teamName);
  const exact = teams.find(t => normalizeName(t?.name) === target);
  si (exacto) devolver exacto;
  const partial = teams.find(t => namesMatch(t?.name, teamName));
  devolver parcial || nulo;
}

función asíncrona getTeamRecentMatches(teamId) {
  si (!teamId) devolver [];
  const key = `team:${teamId}:recent`;
  const cached = cacheGet(key);
  si (cached) devolver cached;
  intentar {
    const data = await footballData(`/teams/${teamId}/matches?status=FINISHED&limit=20`);
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    devolver cacheSetIfNotEmpty(clave, coincidencias);
  } catch (error) {
    devolver [];
  }
}

función calcularEstadísticasRecientesDelEquipo(teamId, matches) {
  const relevante = coincidencias
    .filter(m => m?.homeTeam?.id === teamId || m?.awayTeam?.id === teamId)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 10);

  si (!longitud relevante) {
    devolver {
      coincidencias: 0,
      objetivosPara: 0,
      golesEn contra: 0,
      promedio de goles para: 1.25,
      promedio de goles en contra: 1,25
      fuerza de ataque: 1,
      Fuerza de defensa: 1,
      formPoints: 0,
      Porcentaje de formulario: 50
    };
  }

  const n = longitud.relevante;
  sea ​​weightedGF = 0, weightedGA = 0, weightedPts = 0, totalW = 0;
  sea ​​gf = 0, ga = 0, pts = 0;

  relevante.paraCada((m, idx) => {
    const w = n - idx;
    totalW += w;
    const h = Number(m?.score?.fullTime?.home ?? 0);
    const a = Number(m?.score?.fullTime?.away ?? 0);
    const isHome = m?.homeTeam?.id === teamId;
    const gFor = isHome ? h : a;
    const gAg = isHome ? a : h;

    gf += gPara;
    ga += gAg;
    GF ponderado += gPara * w;
    GA ponderado += gAg * w;

    if (gFor > gAg) { pts += 3; weightedPts += 3 * w; }
    else if (gFor === gAg) { pts += 1; weightedPts += 1 * w; }
  });

  const promedioGoalesPara = GF ponderado / totalW;
  const promedioGolesEnGanancia = ponderadoGA / totalW;

  devolver {
    coincidencias: longitud relevante,
    objetivosPara: novia,
    golesEn contra: ga,
    promedio de objetivos para,
    promedio de goles en contra,
    attackStrength: clamp(avgGoalsFor / 1.35, 0.45, 1.8),
    defensaFuerza: clamp(1.35 / Math.max(promedioGolesEnGanancia, 0.25), 0.45, 1.8),
    formPoints: pts,
    Porcentaje de forma: (Puntos ponderados / (Puntuación total * 3)) * 100
  };
}

función asíncrona getFixturesFootballData(fecha, filtro de competición) {
  intentar {
    const path = competitionFilter && COMPETITIONS.includes(competitionFilter)
      ? `/competitions/${competitionFilter}/matches?dateFrom=${date}&dateTo=${date}`
      : `/matches?dateFrom=${date}&dateTo=${date}`;

    const datos = await footballData(ruta);
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    const filtrado = filtro de competición
      ? partidos
      : matches.filter(m => ODDS_SPORT_BY_COMPETITION[m?.competition?.code]);

    devolver filtered.map(m => ({
      ...metro,
      código de competición: m?.competition?.code || nulo,
      Nombre de la competición: m?.competition?.name || m?.competition?.code || null,
      Fuente: 'datos de fútbol'
    }));
  } catch (error) {
    devolver [];
  }
}

/* =========================================================
   API de probabilidades
========================================================== */
función asíncrona getOddsEvents(competitionCode) {
  si (!ODDS_API_KEY) devuelve [];
  const sport = ODDS_SPORT_BY_COMPETITION[competitionCode];
  si (!deporte) devolver [];

  const key = `odds-events:${sport}`;
  const cached = cacheGet(key);
  si (cached) devolver cached;

  intentar {
    const url = `${ODDS_BASE}/sports/${sport}/odds?regions=us,uk,eu&markets=h2h,totals&oddsFormat=decimal&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;
    const data = await fetchJson(url);
    const events = Array.isArray(data) ? data : [];
    devolver cacheSetIfNotEmpty(clave, eventos);
  } catch (error) {
    devolver [];
  }
}

función asíncrona getFixturesOdds(fecha, filtro de competición) {
  si (!ODDS_API_KEY) devuelve [];
  const todo = [];
  const comps = competitionFilter && COMPETITIONS.includes(competitionFilter) ? [competitionFilter] : COMPETITIONS;

  para (constante c de componentes) {
    const events = await getOddsEvents(c);
    para (constante de eventos) {
      si (!e?.home_team || !e?.away_team || !e?.commence_time) continuar;
      Si (datePartUTC(e.commence_time) !== date) continuar;

      todos.empujar({
        id: `odds-${e.id || normalizeName(e.home_team + '-' + e.away_team)}`,
        HomeTeam: { id: null, name: e.home_team, crest: null },
        equipo visitante: { id: null, nombre: e.away_team, escudo: null },
        utcDate: hora_de_comienzo_electrónico,
        competición: { código: c, nombre: competitionName(c) },
        Código de competición: c,
        nombre de la competición: nombre de la competición(c),
        estado: 'PROGRAMADO',
        Fuente: 'the-odds-api',
        Evento de probabilidades: e
      });
    }
  }
  devolver todo;
}

función nombreCompetición(código) {
  const nombres = {
    PL: 'Premier League',
    PD: 'LaLiga',
    BL1: 'Bundesliga',
    SA: 'Serie A',
    FL1: 'Ligue 1',
    CL: 'Liga de Campeones',
    EL: 'Liga Europa'
  };
  devolver nombres[código] || código;
}

función asíncrona getFixture(fecha, filtro de competición) {
  const key = `fixtures:${date}:${competitionFilter || 'ALL'}`;
  const cached = cacheGet(key);
  si (cached) devolver cached;

  let matches = await getFixturesFootballData(date, competitionFilter);
  si (filtro de competencia) {
    coincidencias = coincidencias.filter(m => (m.competitionCode || m.competition?.code) === competitionFilter);
  }

  si (!coincide.length) {
    partidos = esperar obtenerCuotasDeCombate(fecha, filtroDeCompetencia);
  }

  coincidencias = Array.isArray(coincidencias) ? coincidencias : [];
  matches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  Si (matches.length > 0) cacheSet(key, matches);
  devolver coincidencias;
}

función findOddsEvent(eventos, homeName, awayName) {
  Si (!Array.isArray(eventos)) devuelve null;
  const direct = events.find(e => namesMatch(e?.home_team, homeName) && namesMatch(e?.away_team, awayName));
  si (directo) devuelve { evento: directo, invertido: falso };
  const rev = events.find(e => namesMatch(e?.home_team, awayName) && namesMatch(e?.away_team, homeName));
  if (rev) return { event: rev, reversed: true };
  devolver nulo;
}

función asíncrona getOdds(homeName, awayName, competitionCode) {
  if (!ODDS_API_KEY) return { available: false, reason: 'ODDS_API_KEY no configurada' };
  const sport = ODDS_SPORT_BY_COMPETITION[competitionCode];
  if (!sport) return { available: false, reason: 'Competición no soportada' };

  const events = await getOddsEvents(competitionCode);
  const encontrado = findOddsEvent(eventos, homeName, awayName);
  if (!found?.event) return { available: false, reason: 'Partido no encontrado en The Odds API' };

  devolver {
    disponible: verdadero,
    eventId: found.event.id || null,
    beginTime: found.event.commence_time || null,
    casas de apuestas: Array.isArray(found.event.bookmakers) ? found.event.bookmakers : [],
    evento: encontrado.evento,
    invertido: Booleano(encontrado.invertido)
  };
}

función collectPrices(casas de apuestas, nombre de la casa, nombre de la casa, revertido = falso) {
  const resultado = { local: [], empate: [], visitante: [], mayor de 25: [], menor de 25: [] };

  para (const b de casas de apuestas || []) {
    const bName = b?.title || b?.key || 'Desconocido';
    para (const m de b?.mercados || []) {
      si (m?.key === 'h2h') {
        para (const o de m.outcomes || []) {
          const precio = Número(o?.precio);
          Si (!Number.isFinite(price) || price <= 1) continuar;
          const isHome = namesMatch(o?.name, homeName);
          const isAway = namesMatch(o?.name, awayName);
          const isDraw = ['draw', 'tie', 'empate'].includes(normalizeName(o?.name));

          if (isDraw) result.draw.push({ bookmaker: bName, odds: price });
          else if (!reversed && isHome) result.home.push({ bookmaker: bName, odds: price });
          else if (!reversed && isAway) result.away.push({ bookmaker: bName, odds: price });
          else if (reversed && isAway) result.home.push({ bookmaker: bName, odds: price });
          else if (reversed && isHome) result.away.push({ bookmaker: bName, odds: price });
        }
      }
      si (m?.key === 'totals') {
        para (const o de m.outcomes || []) {
          si (Número(o?.punto) !== 2.5) continuar;
          const precio = Número(o?.precio);
          Si (!Number.isFinite(price) || price <= 1) continuar;
          const n = normalizeName(o?.name);
          if (n === 'over') result.over25.push({ bookmaker: bName, odds: price });
          if (n === 'under') result.under25.push({ bookmaker: bName, odds: price });
        }
      }
    }
  }
  devolver resultado;
}

función analyzePriceSet(prices) {
  const válido = precios
    .filter(item => Number.isFinite(Number(item?.odds)) && Number(item.odds) > 1)
    .map(item => ({ bookmaker: item.bookmaker, odds: Number(item.odds) }));

  si (!valid.length) {
    devolver {
      mejoresProbabilidades: nulo,
      Probabilidades de referencia: nulo,
      segundasMejoresProbabilidades: nulo,
      Número de casas de apuestas: 0,
      supportCount: 0,
      isOutlier: falso,
      profundidad de mercado: 'ninguna',
      precios: []
    };
  }

  const odds = valid.map(x => x.odds).sort((a, b) => a - b);
  const referenceOdds = median(odds);
  const mejoresOdds = probabilidades[odds.length - 1];
  const unique = uniqueNumbers(odds).sort((a, b) => b - a);
  const secondBestOdds = unique.length > 1 ? unique[1] : null;

  const supportCount = odds.filter(val =>
    referenceOdds && Math.abs(val - referenceOdds) / referenceOdds <= 0.10
  ).longitud;

  const isOutlier = odds.length >= 2 && (
    mejoresOdds > referenciaOdds * 1.30 ||
    (bestOdds > referenceOdds * 1.20 && supportCount < 2) ||
    (segundoMejorOdds!== nulo && mejoresOdds > segundoMejorOdds * 1.20)
  );

  sea ​​marketDepth = 'bajo';
  Si (odds.length >= 6 && supportCount >= 4) marketDepth = 'strong';
  else if (odds.length >= 3 && supportCount >= 2) marketDepth = 'medium';

  devolver {
    mejores probabilidades,
    referenciaProbabilidades,
    segundasMejoresProbabilidades,
    BookmakerCount: longitud válida,
    supportCount,
    es un valor atípico,
    Profundidad del mercado,
    precios: válido
  };
}

función marketName(tipo, resultado) {
  si (tipo === 'h2h') {
    si (resultado === 'home') devolver 'Gana local';
    si (resultado === 'empate') devolver 'Empate';
    devolver 'Gana visitante';
  }
  return outcome === 'over' ? 'Over 2.5' : 'Under 2.5';
}

función construirMercado(tipo, resultado, probabilidad, precios) {
  const info = analyzePriceSet(prices);
  const modeloProbabilidad = Número(probabilidad);
  const bestEvPct = info.bestOdds? ev(modelProbability, info.bestOdds): nulo;
  referencia constanteEvPct = info.referenceOdds? ev(modelProbability, info.referenceOdds): nulo;

  const valorElegible =
    info.bookmakerCount >= 2 &&
    info.supportCount >= 2 &&
    !info.isOutlier &&
    Número.esFinito(referenciaEvPct) &&
    referenceEvPct > 0;

  sea ​​valueLevel = 'Sin valor';
  si (info.isOutlier) valueLevel = 'Precio enípico';
  else if (referenceEvPct >= 10) valueLevel = 'Valor fuerte';
  else if (referenceEvPct >= 5) valueLevel = 'Valor';
  else if (referenceEvPct > 0) valueLevel = 'Valor leve';

  const bestBookmaker = info.prices.find(item => item.odds === info.bestOdds)?.bookmaker || null;
  const preferredBookmakerPrice = info.prices.find(item => /caliente/i.test(item.bookmaker || '')) || null;

  let suggestStakeEur = STAKE_EUR;
  if (info.mejoresOdds && info.mejoresOdds > 1) {
    const b = info.bestOdds - 1;
    const p = ProbabilidadModelo;
    constante q = 1 - p;
    const kelly = (b * p - q) / b;
    const used = Math.max(0, kelly) * 0.25;
    suggestStakeEur = Number(clamp(STAKE_EUR * (1 + used * 10), STAKE_EUR * 0.5, STAKE_EUR * 3).toFixed(2));
  }

  devolver {
    tipo,
    resultado,
    nombre: marketName(tipo, resultado),
    probabilidad: Número((probabilidadmodelo * 100).toFixed(1)),
    mejoresProbabilidades: info.bestOdds,
    referenceOdds: info.referenceOdds,
    segundasMejoresProbabilidades: info.secondBestOdds,
    Probabilidad implícita: info.bestOdds ? implied(info.bestOdds) : null,
    evPct: mejorEvPct,
    mejorEvPct,
    referenciaEvPct,
    casa de apuestas: bestBookmaker,
    Cuotas de casa de apuestas preferidas: precio de casa de apuestas preferidas?.cuotas || nulo,
    sugeridoStakeEur,
    Número de casas de apuestas: info.bookmakerCount,
    supportCount: info.supportCount,
    isOutlier: info.isOutlier,
    Profundidad del mercado: info.marketDepth,
    valor elegible,
    nivel de valor
  };
}

función buildMarkets(modelo, oddsData, homeName, awayName) {
  si (!oddsData?.available) devolver [];
  const prices = collectPrices(oddsData.bookmakers, homeName, awayName, oddsData.reversed);

  devolver [
    construirMercado('h2h', 'casa', modelo.casaWin, precios.casa),
    construirMercado('h2h', 'draw', model.draw, prices.draw),
    construirMercado('h2h', 'away', modelo.awayWin, precios.away),
    construirMercado('totales', 'over', modelo.over25, precios.over25),
    construirMercado('totales', 'menos de', modelo.menos de 25, precios.menos de 25)
  ];
}

función mejorValor(mercados, confianzaModelo) {
  mercados de retorno
    .filter(m =>
      m.valorElegible &&
      m.bookmakerCount >= 2 &&
      m.supportCount >= 2 &&
      !m.isOutlier &&
      Número(m.probabilidad) >= 45 &&
      Número(m.referenceEvPct) >= 1 &&
      Número(confianza del modelo) >= 45
    )
    .sort((a, b) => Number(b.referenceEvPct) - Number(a.referenceEvPct))[0] || null;
}

función puntuación más probable(homeXg, awayXg) {
  sea ​​mejor = { local: 0, fuera: 0, probabilidad: 0 };
  función p(k, l) {
    sea ​​f = 1; para (sea i = 2; i <= k; i++) f *= i;
    devolver (Math.exp(-l) * Math.pow(l, k)) / f;
  }
  para (sea h = 0; h <= 7; h++) {
    para (sea a = 0; a <= 7; a++) {
      const prob = p(h, Math.max(0.01, Number(homeXg))) * p(a, Math.max(0.01, Number(awayXg)));
      si (prob > best.probability) best = { home: h, away: a, probability: prob };
    }
  }
  return { puntuación: `${best.home}-${best.away}`, probabilidad: Number((best.probability * 100).toFixed(1)) };
}

/* =========================================================
   2. MODELO CON VENTAJA DE LOCAL AJUSTADA POR LIGA
========================================================== */
función createModelInput(homeStats, awayStats, competitionCode) {
  const homeAttack = homeStats.avgGoalsFor * clamp(homeStats.attackStrength, 0.75, 1.35);
  const awayAttack = awayStats.avgGoalsFor * clamp(awayStats.attackStrength, 0.75, 1.35);

  const homeAdvantage = obtenerHomeAdvantage(códigoCompetición);
  const homeXg = ((homeAttack + awayStats.avgGoalsAgainst) / 2) * homeAdvantage;
  const awayXg = (awayAttack + homeStats.avgGoalsAgainst) / 2;

  devolver {
    homeXg: clamp(homeXg, 0.25, 3.8),
    awayXg: clamp(awayXg, 0.20, 3.5),
    Ventaja de inicio
  };
}

/* =========================================================
   PUNTOS FINALES Y API
========================================================== */

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: verdadero,
    footballDataConfigured: Boolean(FOOTBALL_DATA_TOKEN),
    oddsApiConfigured: Booleano(ODDS_API_KEY),
    baseDeDatosConfigurada: Booleano(URL_DE_LA_BASE_DE_DATOS && Pool),
    bigBallsConfigured: Booleano(BIGBALLS_KEY),
    stakeEur: STAKE_EUR,
    proveedor: 'football-data.org + The Odds API + Big Balls',
    cacheMinutes: CACHE_MINUTES,
    Versión del modelo: VERSIÓN_DEL_MODELO
  });
});

// Descargar el archivo server.js actualizado
app.get('/api/download-server', (req, res) => {
  const possiblePaths = [
    ruta.join(__dirname, 'server.js'),
    ruta.join(__dirname, 'public', 'server.js'),
    ruta.join(process.cwd(), 'server.js'),
    ruta.join(process.cwd(), 'public', 'server.js')
  ];
  para (constante p de posiblesPasos) {
    si (fs.existsSync(p)) {
      return res.download(p, 'server.js');
    }
  }
  res.status(404).send('server.js no encontrado.');
});

// Descargar el archivo zip del proyecto completo
app.get('/api/download-zip', (req, res) => {
  const possiblePaths = [
    ruta.join(__dirname, 'public', 'mi-pronostico-deportivo-v7.17.zip'),
    ruta.join(__dirname, 'mi-pronostico-deportivo-v7.17.zip'),
    ruta.join(process.cwd(), 'public', 'mi-pronostico-deportivo-v7.17.zip'),
    ruta.join(process.cwd(), 'mi-pronostico-deportivo-v7.17.zip')
  ];
  para (constante p de posiblesPasos) {
    si (fs.existsSync(p)) {
      return res.download(p, 'mi-pronostico-deportivo-v7.17.zip');
    }
  }
  res.status(404).send('ZIP no encontrado.');
});

función addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + días);
  return d.toISOString().slice(0, 10);
}

app.get('/api/fixtures/favorites', async (req, res) => {
  const equipos = String(req.query.teams || '')
    .dividir(',')
    .map(t => t.trim())
    .filter(Booleano)
    .slice(0, 5);

  if (!teams.length) return res.json({ ok: true, fixtures: [] });

  const todayStr = new Date().toISOString().slice(0, 10);
  const cacheKey = `favorites-fixtures:${teams.join('|')}:${todayStr}`;
  const cached = cacheGet(cacheKey);
  si (cached) devuelve res.json(cached);

  intentar {
    // Football-Data rechaza periodos superiores a 10 días:
    // "El período especificado no debe exceder los 10 días" (HTTP 400).
    // Consultamos en 2 bloques seguros de 7 días: [0..7] y [8..14]
    const b1From = todayStr;
    const b1To = addDaysToDateStr(todayStr, 7);
    const b2From = addDaysToDateStr(todayStr, 8);
    const b2To = addDaysToDateStr(todayStr, 14);

    const [data1, data2] = await Promise.all([
      footballData(`/matches?dateFrom=${b1From}&dateTo=${b1To}`).catch(() => ({ matches: [] })),
      footballData(`/matches?dateFrom=${b2From}&dateTo=${b2To}`).catch(() => ({ matches: [] }))
    ]);

    const allMatches = [
      ...(Array.isArray(data1?.matches) ? data1.matches : []),
      ...(Array.isArray(data2?.matches) ? data2.matches : [])
    ];

    const seenIds = nuevo Set();
    const coincidenciasúnicas = [];
    para (const m de todosLosMatches) {
      const matchId = m?.id || `${m?.homeTeam?.name}-${m?.awayTeam?.name}-${m?.utcDate}`;
      si (!seenIds.has(matchId)) {
        seenIds.add(matchId);
        coincidenciasúnicas.push(m);
      }
    }

    const filtrado = coincidencias únicas.filtro(m =>
      equipos.some(t => namesMatch(m?.homeTeam?.name, t) || namesMatch(m?.awayTeam?.name, t))
    );

    const fixtures = filtered.map(m => ({
      id: m.id,
      Inicio: m.homeTeam?.name || nulo,
      fuera: m.awayTeam?.name || nulo,
      homeCrest: m.homeTeam?.crest || null,
      awayCrest: m.awayTeam?.crest || null,
      inicio: m.utcDate || null,
      competición: m.competition?.name || m.competition?.code || null
    })).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));

    const resultado = { ok: true, fixtures };
    cacheSet(cacheKey, result, 'fixtures');
    devolver res.json(resultado);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/fixtures/next', async (req, res) => {
  const comp = String(req.query.competition || '').trim().toUpperCase();
  si (!comp) {
    return res.status(400).json({ ok: false, error: 'Debes indicar una liga específica.' });
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const cacheKey = `next-fixture:${comp}:${todayStr}`;
  const cached = cacheGet(cacheKey);
  si (cached) devuelve res.json(cached);

  intentar {
    let foundDate = null;
    sea ​​foundCount = 0;

    para (debe ser offset = 0; offset < 45 && !foundDate; offset += 10) {
      const from = addDaysToDateStr(todayStr, offset);
      const to = addDaysToDateStr(todayStr, Math.min(offset + 9, 44));
      const data = await footballData(`/competitions/${comp}/matches?dateFrom=${from}&dateTo=${to}`);
      const matches = Array.isArray(data?.matches) ? data.matches : [];

      si (coincide.longitud) {
        matches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
        foundDate = matches[0].utcDate.slice(0, 10);
        foundCount = matches.filter(m => m.utcDate.slice(0, 10) === foundDate).length;
      }
    }

    const resultado = fecha de hallazgo
      ? { ok: verdadero, encontrado: verdadero, fecha: fechaEncontrada, cantidad: cantidadEncontrada }
      : { ok: true, found: false, message: 'No se encontraron partidos próximos en 45 días.' };

    cacheSet(cacheKey, resultado);
    devolver res.json(resultado);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/fixtures', async (req, res) => {
  const date = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);
  const comp = String(req.query.competition || '').trim().toUpperCase();

  intentar {
    const matches = await getFixture(date, comp);
    const fixtures = matches
      .filter(m => m?.homeTeam?.name && m?.awayTeam?.name)
      .map(m => ({
        id: m.id || nulo,
        Inicio: m.homeTeam.name,
        homeCrest: m.homeTeam?.crest || null,
        visitante: m.awayTeam.name,
        awayCrest: m.awayTeam?.crest || null,
        inicio: m.utcDate || null,
        competición: m.competitionName || m.competition?.name || m.competitionCode || null,
        código de competición: m.competitionCode || m.competition?.code || null,
        estado: m.status || 'PROGRAMADO',
        Fuente: m.source || 'datos de fútbol'
      }));

    const fetchedAt = cacheGetTimestamp(`fixtures:${date}:${comp || 'ALL'}`) || Date.now();
    return res.json({
      ok: verdadero,
      Versión del modelo: VERSIÓN_DEL_MODELO,
      fecha,
      recuento: accesorios.longitud,
      recuperadoEn,
      accesorios
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message, modelVersion: MODEL_VERSION });
  }
});

/* =========================================================
   ANÁLISIS DE UN PARTIDO (con Descanso Propio + Home Advantage + Big Balls)
========================================================== */
función asíncrona analyzeOneFixture(fixture) {
  const homeName = fixture.homeTeam?.name;
  const awayName = fixture.awayTeam?.name;
  Si (!homeName || !awayName) devuelve null;

  const compCode = fixture.competitionCode || fixture.competition?.code || null;
  let homeTeamObj = fixture.homeTeam?.id ? fixture.homeTeam : null;
  let awayTeamObj = fixture.awayTeam?.id ? fixture.awayTeam : null;

  si ((!homeTeamObj?.id || !awayTeamObj?.id) && compCode) {
    const [hObj, aObj] = await Promise.all([
      encontrarEquipo(homeName, compCode),
      encontrarEquipo(nombreAfuera, códigoComp)
    ]);
    si (hObj) homeTeamObj = hObj;
    si (aObj) awayTeamObj = aObj;
  }

  const homeId = homeTeamObj?.id || nulo;
  const awayId = awayTeamObj?.id || null;
  Si (!homeId || !awayId) devuelve null;

  const [homeMatches, awayMatches] = await Promise.all([
    obtenerPartidosRecientesDelEquipo(homeId),
    obtenerPartidosRecientesDelEquipo(awayId)
  ]);

  let homeStats = calculateRecentTeamStats(homeId, homeMatches);
  let awayStats = calculateRecentTeamStats(awayId, awayMatches);

  // Estabilización
  const attackBase = 1.35;
  const defBase = 1.20;
  const hGF = shrinkToMean(homeStats.avgGoalsFor, attackBase, homeStats.matches);
  const hGA = shrinkToMean(homeStats.avgGoalsAgainst, defBase, homeStats.matches);
  const aGF = shrinkToMean(awayStats.avgGoalsFor, attackBase, awayStats.matches);
  const aGA = shrinkToMean(awayStats.avgGoalsAgainst, defBase, awayStats.matches);

  homeStats = {
    ...homeStats,
    promedioGolesPara: hGF,
    promedio de goles en contra: hGA,
    attackStrength: clamp(hGF / attackBase, 0.45, 1.8),
    defensaFuerza: clamp(ataqueBase / Math.max(hGA, 0.25), 0.45, 1.8)
  };
  awayStats = {
    ...awayStats,
    avgGoalsFor: aGF,
    promedio de goles en contra: aGA,
    attackStrength: clamp(aGF / attackBase, 0.45, 1.8),
    defensaFuerza: clamp(ataqueBase / Math.max(aGA, 0.25), 0.45, 1.8)
  };

  // Lesionados
  const injuryAdj = await applyInjuryAdjustment(homeStats, awayStats, homeName, awayName, compCode);
  homeStats = injuryAdj.homeStats;
  awayStats = injuryAdj.awayStats;

  // 1. Descanso calculado con Football-Data (Gratis)
  const homeRestDays = calculateRestDaysFromMatches(homeMatches, fixture.utcDate);
  const awayRestDays = calculateRestDaysFromMatches(awayMatches, fixture.utcDate);
  const restAdj = applyCalculatedRestAdjustment(homeStats, awayStats, homeRestDays, awayRestDays);
  homeStats = restAdj.homeStats;
  awayStats = restAdj.awayStats;

  // 2. Modelo con Ventaja de Local ajustado por Liga
  const modelInput = createModelInput(homeStats, awayStats, compCode);
  let modelo = matchModel(modelInput.homeXg, modelInput.awayXg);

  // H2H Histôrico
  const [bbHomeTeamId, bbAwayTeamId] = await Promise.all([
    obtenerBigBallsTeamId(homeName, compCode),
    obtenerBigBallsTeamId(awayName, compCode)
  ]);
  const h2hDrawRate = await getH2HDrawRate(bbHomeTeamId, bbAwayTeamId);
  modelo = aplicarH2HAdjustment(modelo, h2hDrawRate);

  // 3. Predicción Big Balls (Segunda Opinión)
  const bbPred = await getBigBallsPrediction(homeName, awayName, compCode);
  const bbComparison = evaluateSecondOpinion(model, bbPred);

  // Confianza propia matemática pura (sin adulteración externa)
  sea ​​modelConf = 50;
  intentar {
    const bestP = Math.max(model.homeWin, model.draw, model.awayWin);
    const n = Math.min(homeStats.matches, awayStats.matches);
    modelConf = confianza(bestP, n);
  } capturar (e) {
    modelConf = 50;
  }

  const confianzaAjustada = clamp(Math.round(modelConf), 20, 95);

  // Aprendizaje emprico de ventaja de local de la liga
  actualizarVentajaHomeAprendida(compCode, (homeMatches || []).concat(awayMatches || []));

  const odds = await getOdds(homeName, awayName, compCode);
  const markets = buildMarkets(model, odds, homeName, awayName);

  devolver {
    casa: homeName,
    homeCrest: homeTeamObj?.crest || fixture.homeCrest || null,
    lejos: awayName,
    awayCrest: awayTeamObj?.crest || fixture.awayCrest || null,
    fecha: fixture.utcDate ? datePartUTC(fixture.utcDate) : null,
    inicio: fixture.utcDate || null,
    competición: fixture.competitionName || fixture.competition?.name || compCode,
    Código de competición: código de competición,
    confianza: confianzaAjustada,
    homeAdvantage: modelInput.homeAdvantage,
    descanso: { casa: restAdj.homeRest, fuera: restAdj.awayRest },
    lesiones: { local: injuryAdj.homeInjuries, fuera: injuryAdj.awayInjuries },
    bigBallsComparison: bbComparison,
    mercados,
    oddsAvailable: Boolean(odds?.available)
  };
}

función pickParlayCandidate(análisis) {
  Si (!análisis || !análisis.probabilidadesDisponibles) devolver null;
  const candidatos = [];

  para (const m de análisis.mercados) {
    si (!m.bestOdds) continuar;
    const isStrong = m.valueEligible && Number(m.referenceEvPct) >= 1.5 && analysis.confidence >= 45;
    const isOddsError = m.isOutlier && m.referenceOdds && m.bestOdds > m.referenceOdds * 1.10 && Number(m.probability) >= 35;

    si (isStrong || isOddsError) {
      candidatos.push({
        Inicio: análisis.inicio,
        homeCrest: análisis.homeCrest,
        lejos: análisis.lejos,
        awayCrest: análisis.awayCrest,
        competencia: análisis.competencia,
        fecha: análisis.fecha,
        inicio: análisis.inicio,
        mercado: m.type,
        resultado: m.resultado,
        Nombre del mercado: m.name,
        probabilidades: m.bestOdds,
        probabilidad: m.probabilidad,
        referenceEvPct: m.referenceEvPct,
        confianza: análisis.confianza,
        etiqueta: esOddsError? 'Posible error de cuota' : 'Pick fuerte'
      });
    }
  }

  Si (!candidates.length) devuelve null;
  candidatos.sort((a, b) => Number(b.referenceEvPct || 0) - Number(a.referenceEvPct || 0));
  devolver candidatos[0];
}

app.get('/api/parlay', async (req, res) => {
  intentar {
    const date = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);
    const maxLegs = Math.min(6, Math.max(2, Number(req.query.legs) || 4));
    const comp = String(req.query.competition || '').trim().toUpperCase();

    const fixtures = await getFixture(date, comp);
    const withNames = fixtures.filter(m => m?.homeTeam?.name && m?.awayTeam?.name);
    const candidatos = [];

    para (const f de withNames) {
      intentar {
        const análisis = esperar analizarUnArchivo(f);
        const pick = pickParlayCandidate(análisis);
        si (seleccionar) candidatos.push(seleccionar);
      } capturar (error) {
        console.warn('[PARLAY] fallo analizando partido:', err.message);
      }
    }

    candidatos.sort((a, b) => Number(b.referenceEvPct || 0) - Number(a.referenceEvPct || 0));

    si (!candidates.length) {
      return res.json({
        ok: verdadero,
        fecha,
        stakeEur: STAKE_EUR,
        candidatos: [],
        apuestas combinadas: [],
        mensaje: 'No se detectaron picks fuertes ni errores de cuota para esta fecha.'
      });
    }

    const parlays = [];
    para (sea l = 2; l <= Math.min(maxLegs, candidates.length); l++) {
      const piernas = candidatos.rebanar(0, l);
      const combinedOdds = legs.reduce((acc, leg) => acc * Number(leg.odds), 1);
      const combinedProb = legs.reduce((acc, leg) => acc * (Number(leg.probability) / 100), 1);
      const combinedEv = Number(((combinedProb * combinedOdds - 1) * 100).toFixed(1));

      parlays.push({
        Número de piernas: l,
        piernas,
        Probabilidades combinadas: Número(probabilidades combinadas.toFixed(2)),
        ProbabilidadCombinadaPct: Número((probabilidadCombinada * 100).toFijo(1)),
        Ev combinado: Ev combinado
      });
    }

    return res.json({ ok: true, date, stakeEur: STAKE_EUR, candidates, parlays });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/analyze', async (req, res) => {
  intentar {
    const requestedHome = String(req.query.home || '').trim();
    const requestedAway = String(req.query.away || '').trim();
    const date = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);

    si (!solicitadoHome || !solicitadoAusente) {
      return res.status(400).json({ ok: false, error: 'Debes proporcionar casa y fuera.' });
    }

    const fixtures = await getFixture(date);
    sea ​​seleccionado = fixtures.find(m =>
      namesMatch(m?.homeTeam?.name, requestedHome) && namesMatch(m?.awayTeam?.name, requestedAway)
    );

    let reversedRequest = false;
    si (!seleccionado) {
      seleccionado = accesorios.find(m =>
        namesMatch(m?.homeTeam?.name, requestedAway) && namesMatch(m?.awayTeam?.name, requestedHome)
      );
      si (seleccionado) reversedRequest = verdadero;
    }

    si (!seleccionado) {
      return res.status(404).json({ ok: false, error: 'No se encontró el partido solicitado.', modelVersion: MODEL_VERSION });
    }

    const actualHomeName = selected.homeTeam?.name || requestedHome;
    const actualAwayName = selected.awayTeam?.name || requestedAway;
    const competitionCode = selected.competitionCode || selected.competition?.code || null;

    let homeTeamObj = selected.homeTeam?.id ? selected.homeTeam : null;
    let awayTeamObj = selected.awayTeam?.id ? selected.awayTeam : null;

    si ((!homeTeamObj?.id || !awayTeamObj?.id) && competitionCode) {
      const [hObj, aObj] = await Promise.all([
        encontrarEquipo(actualHomeName, código de competición),
        findTeam(actualAwayName, competitionCode)
      ]);
      si (hObj) homeTeamObj = hObj;
      si (aObj) awayTeamObj = aObj;
    }

    const homeId = homeTeamObj?.id || nulo;
    const awayId = awayTeamObj?.id || null;

    si (!homeId || !awayId) {
      return res.status(503).json({
        ok: falso,
        error: 'Football-Data no pudo identificar uno de los equipos para estadísticas.',
        Versión del modelo: VERSIÓN_DEL_MODELO
      });
    }

    const [homeMatches, awayMatches] = await Promise.all([
      obtenerPartidosRecientesDelEquipo(homeId),
      obtenerPartidosRecientesDelEquipo(awayId)
    ]);

    let homeStats = calculateRecentTeamStats(homeId, homeMatches);
    let awayStats = calculateRecentTeamStats(awayId, awayMatches);

    // Shrinkage hacia la media
    const attackBaseline = 1.35;
    const defensaBaseline = 1.20;
    const homeGF = shrinkToMean(homeStats.avgGoalsFor, attackBaseline, homeStats.matches);
    const homeGA = shrinkToMean(homeStats.avgGoalsAgainst, defenseBaseline, homeStats.matches);
    const awayGF = shrinkToMean(awayStats.avgGoalsFor, attackBaseline, awayStats.matches);
    const awayGA = shrinkToMean(awayStats.avgGoalsAgainst, defenseBaseline, awayStats.matches);

    homeStats = {
      ...homeStats,
      promedioGolesPara: homeGF,
      promedio de goles en contra: homeGA,
      attackStrength: clamp(homeGF / attackBaseline, 0.45, 1.8),
      defensaFuerza: clamp(ataqueBaseline / Math.max(homeGA, 0.25), 0.45, 1.8)
    };
    awayStats = {
      ...awayStats,
      promedioGolesPara: visitanteGF,
      promedio de goles en contra: visitanteGA,
      attackStrength: clamp(awayGF / attackBaseline, 0.45, 1.8),
      defensaFuerza: clamp(ataqueBaseline / Math.max(awayGA, 0.25), 0.45, 1.8)
    };

    // Lesionados (Big Balls)
    const injuryAdjusted = await applyInjuryAdjustment(homeStats, awayStats, actualHomeName, actualAwayName, competitionCode);
    homeStats = injuryAdjusted.homeStats;
    awayStats = injuryAdjusted.awayStats;

    // 1. Descanso calculado gratis
    const homeRestDays = calculateRestDaysFromMatches(homeMatches, selected.utcDate);
    const awayRestDays = calculateRestDaysFromMatches(awayMatches, selected.utcDate);
    const restAdjusted = applyCalculatedRestAdjustment(homeStats, awayStats, homeRestDays, awayRestDays);
    homeStats = restAdjusted.homeStats;
    awayStats = restAdjusted.awayStats;

    // 2. Modelo con Ventaja de Local ajustado por Liga
    const modelInput = createModelInput(homeStats, awayStats, competitionCode);
    let modelo = matchModel(modelInput.homeXg, modelInput.awayXg);

    // Cara a cara
    const [bbHomeTeamId, bbAwayTeamId] = await Promise.all([
      obtenerBigBallsTeamId(actualHomeName, competitionCode),
      obtenerBigBallsTeamId(actualAwayName, competitionCode)
    ]);
    const h2hDrawRate = await getH2HDrawRate(bbHomeTeamId, bbAwayTeamId);
    modelo = aplicarH2HAdjustment(modelo, h2hDrawRate);

    // 3. Predicción Big Balls (Segunda Opinión)
    const bbPrediction = await getBigBallsPrediction(actualHomeName, actualAwayName, competitionCode);
    const bbComparison = evaluateSecondOpinion(model, bbPrediction);

    // Confianza base matemática autónoma
    sea ​​modelConfidence = 50;
    intentar {
      const mejorProbabilidad = Math.max(modelo.victoriaencasa, modelo.draw, modelo.victoriafuera);
      const confidenceSampleSize = Math.min(homeStats.matches, awayStats.matches);
      confianza del modelo = confianza(mejor probabilidad, tamaño de la muestra de confianza);
    } capturar (e) {
      confianza del modelo = 50;
    }

    const confianzaAjustada = clamp(Math.round(confianzaModelo), 20, 95);

    // Actualizar ventaja de local aprendida
    actualizarVentajaLocalAprendida(códigoCompetición, (partidosLocales || []).concatenar(partidosAfuera || []));

    // Cuotas reales
    const odds = await getOdds(actualHomeName, actualAwayName, competitionCode);
    const markets = buildMarkets(model, odds, actualHomeName, actualAwayName);
    const valor = mejorValor(mercados, confianzaAjustada);

    const betEligible = Boolean(valor);
    const recomendación = betEligible ? valor.nombre : 'NO APUESTA';
    const razón = betEligible
      ? `El modelo detecta valor respaldado por el mercado con ${Number(value.probability).toFixed(1)}% de probabilidad y EV de mercado de ${Number(value.referenceEvPct).toFixed(1)}%.`
      : 'No existe una oportunidad de valor positiva que cumpla los actuales filtros de probabilidad, EV, confianza y respaldo del mercado.';

    const confidenceLevel = confidenceAdjusted >= 75 ? 'Alta' : (confidenceAdjusted >= 60 ? 'Media' : 'Baja');
    const confianzaExplicación = confianzaAjustada >= 75
      ? 'Señal estadística fuerte respaldada por métricas sólidas.'
      : (confidenceAdjusted >= 60 ? 'Seal moderada. Recomendada gestión de banca disciplinada.' : 'Seal insuficiente para recomendar apuesta de alto riesgo.');

    const score = mostLikelyScore(modelInput.homeXg, modelInput.awayXg);

    return res.json({
      ok: verdadero,
      Versión del modelo: VERSIÓN_DEL_MODELO,
      fósforo: {
        id: selected.id || null,
        casa: nombredecasaactual,
        homeCrest: homeTeamObj?.crest || selected.homeTeam?.crest || null,
        fuera: nombreactualdefuera,
        awayCrest: awayTeamObj?.crest || selected.awayTeam?.crest || null,
        fecha,
        inicio: seleccionado.utcDate || nulo,
        competición: selected.competitionName || selected.competition?.name || competitionCode,
        Código de competición
      },
      recomendación,
      razón,
      Elegible para apuestas,
      fuerza: valor?.valorNivel || 'Sin valor',
      homeVentaja: {
        factor: modelInput.homeAdvantage,
        liga: código de competición,
        descripción: `Ventaja de local ajustada para ${competitionName(competitionCode)} (${modelInput.homeAdvantage}x)`
      },
      descansar: {
        inicio: restAjustado.homeDescanso,
        lejos: restAjustado.lejosRest
      },
      formulario reciente: { home: homeStats, away: awayStats },
      promedios: {
        inicio: { golesA favor: Número(homeStats.avgGoalsA favor.toFixed(2)), goles en contra: Número(homeStats.avgGoalsAgainst.toFixed(2)) },
        fuera: { golesA favor: Número(awayStats.avgGoalsFor.toFixed(2)), golesEn contra: Número(awayStats.avgGoalsAgainst.toFixed(2)) }
      },
      xG: {
        inicio: Número(modelInput.homeXg.toFixed(2)),
        lejos: Número(modelInput.awayXg.toFixed(2)),
        total: Number((modelInput.homeXg + modelInput.awayXg).toFixed(2))
      },
      Puntuación más probable: puntuación,
      probabilidades: {
        homeWin: Número((modelo.homeWin * 100).toFixed(1)),
        dibujar: Número((modelo.dibujar * 100).toFixed(1)),
        awayWin: Número((modelo.awayWin * 100).toFixed(1)),
        mayores de 25: Número((modelo.mayores de 25 * 100).toFijo(1)),
        menores de 25: Número((modelo.menores de 25 * 100).toFijo(1)),
        btts: Número((model.btts * 100).toFixed(1))
      },
      mercados,
      oddsAvailable: Boolean(odds?.available),
      oddsReason: odds?.available ? null : (odds?.reason || null),
      mejorValor: valor || nulo,
      confianza: confianzaAjustada,
      Nivel de confianza,
      ConfianzaExplicación,
      bigBallsComparison: bbComparison,
      stakeEur: STAKE_EUR,
      diagnóstico: {
        fixtureSource: selected.source || 'football-data',
        Código de competición,
        homeTeamId: homeId,
        awayTeamId: awayId,
        homeLesiones: lesiónAjustada.homeLesiones,
        Lesiones fuera de casa: lesiónAjustada.Lesiones fuera de casa,
        Días de descanso en casa,
        días de descanso fuera,
        homeAdvantageFactor: modelInput.homeAdvantage
      }
    });
  } catch (error) {
    console.error('ERROR DE ANÁLISIS:', error);
    return res.status(500).json({ ok: false, error: error.message, modelVersion: MODEL_VERSION });
  }
});

/* =========================================================
   BACKTESTING & CALIBRACIÑN ESTADÚSTICA (V8.1 Foundation)
   Calcular la puntuación de Brier, pérdida logarítmica, precisión 1X2 y calibración
   por tramos con resultados reales de Football-Data.
========================================================== */
app.get('/api/backtest', async (req, res) => {
  const comp = String(req.query.competition || 'PD').trim().toUpperCase();
  const limit = Math.min(50, Math.max(10, Number(req.query.limit) || 25));
  const cacheKey = `backtest:${comp}:${limit}`;
  const cached = cacheGet(cacheKey);
  si (cached) devuelve res.json(cached);

  intentar {
    const hoy = new Date().toISOString().slice(0, 10);
    const pastFrom = addDaysToDateStr(today, -35);
    const data = await footballData(`/competitions/${comp}/matches?dateFrom=${pastFrom}&dateTo=${today}&status=FINISHED`);
    const matches = (Array.isArray(data?.matches) ? data.matches : []).slice(-limit);

    Si (matches.length < 5) {
      return res.json({
        ok: verdadero,
        Versión del modelo: VERSIÓN_DEL_MODELO,
        competición: comp,
        EvaluadosCoincidencias: coincidencias.longitud,
        mensaje: 'No hay suficientes partidos históricos finalizados en este período para calcular métricas.',
        métricas: nulo
      });
    }

    sea ​​zarzasSum = 0;
    sea ​​logLossSum = 0;
    sea ​​correct1X2 = 0;
    sea ​​totalEvaluado = 0;
    sea ​​simulatedPnl = 0;

    const contenedores = {
      '40-55': { count: 0, predictedSum: 0, actualWins: 0 },
      '55-65': { count: 0, predictedSum: 0, actualWins: 0 },
      '65-75': { count: 0, predictedSum: 0, actualWins: 0 },
      '75+': { count: 0, predictedSum: 0, actualWins: 0 }
    };

    para (const m de coincidencias) {
      const hGoals = Number(m.score?.fullTime?.home);
      const aGoals = Number(m.score?.fullTime?.away);
      Si (!Number.isFinite(hGoals) || !Number.isFinite(aGoals)) continuar;

      const actualResult = hGoals > aGoals ? 'local' : (hGoals === aGoals ? 'empate' : 'visitante');
      const yH = actualResult === 'home' ? 1 : 0;
      const yD = actualResult === 'draw' ? 1 : 0;
      const yA = actualResult === 'away' ? 1 : 0;

      const hAdv = obtenerVentajaHome(comp);
      const estimatedHXg = clamp(1.4 * hAdv, 0.4, 3.2);
      const estimatedAXg = clamp(1.15, 0.3, 2.8);
      const pred = matchModel(estimatedHXg, estimatedAXg);

      const pH = pred.homeWin;
      const pD = pred.draw;
      const pA = pred.awayWin;

      // Puntuación Brier multiclase: (pH - yH)^2 + (pD - yD)^2 + (pA - yA)^2
      const brier = Math.pow(pH - yH, 2) + Math.pow(pD - yD, 2) + Math.pow(pA - yA, 2);
      zarzaSuma += zarza;

      // Pérdida de registro
      const probTarget = actualResult === 'home' ? pH : (actualResult === 'draw' ? pD : pA);
      logLossSum += -Math.log(Math.max(0.001, probTarget));

      // Pronóstico favorito del modelo
      const predictedWinner = (pH > pD && pH > pA) ? 'local' : (pA > pH && pA > pD ? 'visitante' : 'empate');
      const maxP = Math.max(pH, pD, pA);
      const maxPPct = maxP * 100;

      si (ganador_predicho === resultado_actual) {
        correcto1X2++;
      }

      let binKey = '40-55';
      Si (maxPPct >= 75) binKey = '75+';
      else if (maxPPct >= 65) binKey = '65-75';
      else if (maxPPct >= 55) binKey = '55-65';

      contenedores[claveBin].count++;
      bins[binKey].predictedSum += maxPPct;
      si (ganador_predicho === resultado_actual) {
        contenedores[binKey].victorias++;
      }

      const fairOdds = 1 / Math.max(0.05, maxP);
      si (ganador_predicho === resultado_actual) {
        ganancias simuladas += (probabilidades justas - 1) * 10;
      } demás {
        Pnl simulado -= 10;
      }

      totalEvaluado++;
    }

    const avgBrier = totalEvaluado > 0? Número((brierSum / totalEvaluated).toFixed(4)): nulo;
    const avgLogLoss = totalEvaluated > 0 ? Number((logLossSum / totalEvaluated).toFixed(4)) : null;
    const accuracyPct = totalEvaluated > 0 ? Number(((correct1X2 / totalEvaluated) * 100).toFixed(1)) : null;
    const roiPct = totalEvaluated > 0 ? Number(((simulatedPnl / (totalEvaluated * 10)) * 100).toFixed(1)) : null;

    const calibrationReport = Object.entries(bins).map(([binName, b]) => ({
      rango: binName,
      coincidencias: b.count,
      avgPredictedPct: b.count > 0 ? Number((b.predictedSum / b.count).toFixed(1)) : 0,
      actualWinRatePct: b.count > 0 ? Number(((b.actualWins / b.count) * 100).toFixed(1)) : 0,
      brecha: b.count > 0 ? Number(((b.actualWins / b.count) * 100 - (b.predictedSum / b.count)).toFixed(1)) : 0
    }));

    const resultado = {
      ok: verdadero,
      Versión del modelo: VERSIÓN_DEL_MODELO,
      competición: comp,
      Partidos evaluados: totalEvaluado,
      métricas: {
        Puntuación de brier: promedio de brier,
        Pérdida de registro: Pérdida de registro promedio,
        precisión1X2Pct: precisiónPct,
        simuladoPnlEur: Número(simulatedPnl.toFixed(2)),
        Porcentaje de ROI simulado: porcentaje de ROI,
        calibración: informe de calibración
      }
    };

    cacheSet(cacheKey, result, 'analysis');
    res.json(resultado);
  } capturar (error) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =========================================================
   SIMULADOR DE APUESTAS & AUTO-SETTLE
========================================================== */
función requireDb(res) {
  si (!pool) {
    res.status(503).json({
      ok: falso,
      error: 'La base de datos PostgreSQL no está configurada (DATABASE_URL).'
    });
    devolver falso;
  }
  devolver verdadero;
}

función computeProfit(estado, stakeEur, oddsValue) {
  const stake = Number(stakeEur) || 0;
  const odds = Number(oddsValue) || 0;
  if (status === 'won') return Number((stake * (odds - 1)).toFixed(2));
  if (status === 'lost') return Number((-stake).toFixed(2));
  devolver 0;
}

función evaluarResultadoMercado(mercado, resultado, goleslocales, golesafuera) {
  si (mercado === 'h2h') {
    si (resultado === 'local') devolver homeGoals > awayGoals ? 'ganado' : 'perdido';
    if (resultado === 'empate') return homeGoals === awayGoals ? 'ganado' : 'perdido';
    si (resultado === 'fuera') devolver Golesfuera > Goleslocales ? 'ganado' : 'perdido';
  }
  si (mercado === 'totales') {
    const total = Goleslocales + Golesvisitantes;
    if (resultado === 'over') return total >= 3 ? 'ganado' : 'perdido';
    if (resultado === 'menos de') return total < 3 ? 'ganó' : 'perdió';
  }
  devolver nulo;
}

función asíncrona getMatchResult(home, away, dateStr) {
  Si (!dateStr) devuelve null;
  intentar {
    const matches = await getFixturesFootballData(dateStr);
    const encontrado = coincidencias.find(m => namesMatch(m?.homeTeam?.name, home) && namesMatch(m?.awayTeam?.name, away));
    Si (!encontrado || encontrado.estado !== 'FINALIZADO') devolver null;
    const hg = Number(found?.score?.fullTime?.home);
    const ag = Number(found?.score?.fullTime?.away);
    Si (!Number.isFinite(hg) || !Number.isFinite(ag)) devuelve null;
    return { finished: true, homeGoals: hg, awayGoals: ag };
  } capturar (e) {
    devolver nulo;
  }
}

función asíncrona autoSettlePendingBets() {
  si (!pool) devuelve { settle: 0 };
  sea ​​settleCount = 0;
  intentar {
    const pendingResult = await pool.query(
      `SELECT * FROM simulated_bets WHERE status = 'pending' AND market != 'parlay' AND match_date IS NOT NULL LIMIT 200`
    );
    para (const bet de pendingResult.rows) {
      const matchDate = bet.match_date instanceof Date ? bet.match_date.toISOString().slice(0, 10) : String(bet.match_date).slice(0, 10);
      const res = await getMatchResult(bet.home, bet.away, matchDate);
      si (!res) continuar;
      const st = evaluateMarketResult(bet.market, bet.outcome, res.homeGoals, res.awayGoals);
      si (!st) continuar;
      const profit = computeProfit(st, bet.stake_eur, bet.odds);
      await pool.query(`UPDATE simulated_bets SET status = $1, profit_eur = $2, settle_at = now() WHERE id = $3`, [st, profit, bet.id]);
      recuento establecido++;
    }
  } capturar (e) {}
  devolver { settle: settleCount };
}

app.post('/api/bets/auto-settle', async (req, res) => {
  si (!requireDb(res)) regresar;
  intentar {
    const resultado = await autoSettlePendingBets();
    return res.json({ ok: true, ...resultado });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/bets', async (req, res) => {
  si (!requireDb(res)) regresar;
  intentar {
    const { home, away, date, competition, market, outcome, marketName, odds, probability, legs, stakeEur } = req.body || {};
    si (!casa || !fuera || !mercado || !resultado || !probabilidades) {
      return res.status(400).json({ ok: false, error: 'Faltan datos de la apuesta.' });
    }
    const legsJson = Array.isArray(legs) && legs.length ? JSON.stringify(legs) : null;
    const finalStake = Number.isFinite(Number(stakeEur)) ? clamp(Number(stakeEur), STAKE_EUR * 0.5, STAKE_EUR * 3) : STAKE_EUR;

    const resultado = esperar pool.consulta(
      `INSERTAR EN apuestas_simuladas
        (fecha_partido, local, visitante, competición, mercado, resultado, nombre_mercado, probabilidades, probabilidad_modelo, apuesta_eur, estado, piernas_json)
       VALORES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pendiente',$11) DEVOLVIENDO *`,
      [fecha || nulo, local, visitante, competición || nulo, mercado, resultado, nombremercado || mercado, Número(probabilidades), probabilidad != nulo ? Número(probabilidad) : nulo, apuestafinal, piernasJson]
    );
    return res.json({ ok: true, bet: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/bets', async (req, res) => {
  si (!requireDb(res)) regresar;
  intentar {
    const period = String(req.query.period || '').trim();
    const conds = [];
    if (period === 'week') conds.push(`created_at >= now() - interval '7 days'`);
    else if (period === 'month') conds.push(`created_at >= now() - interval '30 days'`);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const result = await pool.query(`SELECT * FROM simulated_bets ${where} ORDER BY created_at DESC LIMIT 200`);
    return res.json({ ok: true, count: result.rows.length, bets: result.rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/bets/:id/settle', async (req, res) => {
  si (!requireDb(res)) regresar;
  intentar {
    const id = Number(req.params.id);
    const resultado = Array.isArray(req.body?.resultado) ? req.body.resultado[0] : req.body?.resultado;
    if (!['ganó', 'perdió', 'vacío'].includes(resultado)) {
      return res.status(400).json({ ok: false, error: "El resultado debe ser 'ganado', 'perdido' o 'void'." });
    }
    const existing = await pool.query('SELECT * FROM simulated_bets WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ ok: false, error: 'Apuesta no encontrada.' });
    const bet = existing.rows[0];
    const beneficio = calcularBeneficio(resultado, apuesta.apuesta_eur, apuesta.probabilidades);
    const actualizado = esperar pool.query(
      `ACTUALIZAR apuestas_simuladas ESTABLECER estado = $1, beneficio_eur = $2, liquidado_en = ahora() DONDE id = $3 DEVOLVER *`,
      [resultado, beneficio, id]
    );
    return res.json({ ok: true, bet: updated.rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/bets/summary', async (req, res) => {
  si (!requireDb(res)) regresar;
  intentar {
    const period = String(req.query.period || 'month').trim();
    const intervalo = período === 'semana' ? '7 días' : '30 días';

    const resultado = esperar pool.consulta(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(profit_eur), 0)::float AS profit, COALESCE(SUM(stake_eur), 0)::float AS staked
       FROM simulated_bets WHERE created_at >= now() - interval '${interval}' GROUP BY status`
    );

    const resumen = { pendiente: 0, ganado: 0, perdido: 0, vacío: 0, beneficio totalEur: 0, totalApostadoEur: 0 };
    para (const r de result.rows) {
      if (summary[r.status] !== undefined) summary[r.status] = r.count;
      resumen.totalProfitEur += r.profit;
      resumen.totalStakedEur += r.staked;
    }
    const settle = summary.won + summary.lost;
    const accuracy = settlement > 0 ? Number(((summary.won / settlement) * 100).toFixed(1)) : null;

    return res.json({
      ok: verdadero,
      período,
      ...resumen,
      recuento de asentamientos: asentamientos,
      precisión%: precisión,
      totalProfitEur: Número(summary.totalProfitEur.toFixed(2)),
      totalStakedEur: Número(summary.totalStakedEur.toFixed(2))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/* =========================================================
   FRONTEND - RENDERIZADO DE PÁGINA (V7.17.0)
   Incluye:
   - Banner VS con escudos grandes
   - Medidor circular SVG de confianza
   - Skeletons animados de carga
   - Descanso propio gratis
   - Ventaja local ajustado
   - Segunda opinión Big Balls
   - Favicon embebido e ícono
========================================================== */
función renderPage() {
  devolver `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no,viewport-fit=cover">
<meta http-equiv="Cache-Control" content="no-cache,no-store,must-revalidate">
<title>MK Bets V8.0.0 - Prónicos Deportivos</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 130 90' style='background:%23080b10'%3E%3Cpolyline points='10,80 10,10 45,55 80,10 80,80' fill='none' stroke='%23ffb45d' stroke-width='11' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cline x1='80' y1='45' x2='118' y2='8' stroke='%23ffb45d' stroke-width='11' stroke-linecap='round'/%3E%3Cline x1='80' y1='45' x2='118' y2='82' stroke='%23ffb45d' stroke-width='11' stroke-linecap='round'/%3E%3C/svg%3E">

<style>
*{box-sizing:border-box;}
cuerpo{
  margen:0;
  font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  fondo:#080b10;
  color:#f5f7fa;
}
botón,input{font:inherit;}
.app{
  ancho máximo: 760px;
  margen:automático;
  relleno:calc(85px + env(safe-area-inset-top, 0px)) 14px 100px;
}
.header{padding:10px 4px 18px;}
.versión{
  display:inline-flex;
  alinear-elementos:centro;
  espacio: 6px;
  relleno: 5px 12px;
  radio de borde: 999px;
  fondo:#171c25;
  borde:1px sólido #283344;
  tamaño de fuente: 12px;
  peso de fuente: 800;
  color:#ffb45d;
}
.logo-row{display:flex;align-items:center;gap:12px;margin-top:12px;}
.logo-text{font-size:32px;font-weight:900;letter-spacing:2px;color:#fff;}
.tarjeta{
  fondo:#10151d;
  borde:1px sólido #242b36;
  radio de borde: 18px;
  relleno: 16px;
  margen superior: 14px;
}
.título-tarjeta{
  tamaño de fuente: 12px;
  transformación de texto: mayúsculas;
  espaciado entre letras: 1px;
  color:#929ba9;
  margen inferior: 12px;
  pantalla:flex;
  alinear-elementos:centro;
  justificar-contenido:espacio-entre;
}
.subtítulo,.silenciado{color:#9da5b2;font-size:14px;line-height:1.45;}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0;}
.chip{
  fondo:#151a22;
  borde:1px sólido #252c37;
  radio de borde: 999px;
  relleno: 6px 10px;
  tamaño de fuente: 11px;
  peso de fuente: 600;
}
.league-chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px;}
.ficha-liga{
  fondo:#151a22;
  borde:1px sólido #303846;
  radio de borde: 999px;
  relleno: 8px 12px;
  tamaño de fuente: 12px;
  peso de fuente: 700;
  color:#c7ccd4;
  cursor:puntero;
  transición:todos .15s de facilidad;
}
.league-chip.active{background:#f4f5f7;color:#080b10;border-color:#f4f5f7;}
.league-chip-priority{border-color:#ffb45d;color:#ffb45d;}
.league-chip-priority.active{background:#ffb45d;color:#080b10;border-color:#ffb45d;}

aporte{
  ancho:100%;
  fondo:#090d13;
  borde:1px sólido #303846;
  color:blanco;
  radio de borde: 12px;
  relleno: 13px;
  margen inferior: 10px;
  esquema:ninguno;
}
.primario{
  ancho:100%;
  borde:0;
  radio de borde: 13px;
  relleno: 14px;
  fondo:#f4f5f7;
  color:#080b10;
  peso de fuente: 900;
  cursor:puntero;
  transición:opacidad .2s;
}
.primary:disabled{opacity:.55;cursor:not-allowed;}
.btn-download{
  display:inline-flex;
  alinear-elementos:centro;
  justificar-contenido:centro;
  espacio: 8px;
  ancho:100%;
  borde:1px sólido #ffb45d;
  radio de borde: 12px;
  relleno: 11px;
  fondo:#1c170d;
  color:#ffb45d;
  tamaño de fuente: 13px;
  peso de fuente: 800;
  decoración de texto: ninguna;
  margen superior: 10px;
  cursor:puntero;
}

/* 6. ANIMACIONES DE CARGA TIPO ESQUELETO */
@keyframes shimmerWave {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.esqueleto-brillo {
  fondo: gradiente lineal(90 grados, #131924 0%, #202b3d 50%, #131924 100%);
  tamaño de fondo: 200% 100%;
  animación: shimmerWave 1.6s de entrada y salida infinitas;
  radio de borde: 8px;
}
.tarjeta-esqueleto {
  fondo: #090d13;
  borde: 1px sólido #252c37;
  radio de borde: 15px;
  relleno: 14px;
  margen inferior: 9px;
}
.skeleton-row { display: flex; align-items: center; gap: 10px; }
.skeleton-circle { ancho: 34px; alto: 34px; radio de borde: 50%; }
.skeleton-pill { altura: 16px; radio de borde: 999px; }
.skeleton-text { altura: 14px; ancho: 60%; margen: 6px 0; }
.texto-estado-de-carga {
  alineación de texto: centro;
  color: #ffb45d;
  grosor de fuente: 700;
  tamaño de fuente: 13px;
  margen inferior: 12px;
  pantalla: flexible;
  alinear-elementos: centro;
  justificar-contenido: centro;
  espacio: 8px;
}

/* 4. BANNER "VS" EN EL ANÁLISIS */
.match-banner {
  fondo: gradiente lineal(180 grados, #131a26 0%, #0d121a 100%);
  borde: 1px sólido #2a3547;
  radio de borde: 16px;
  relleno: 18px 12px;
  mostrar: cuadrícula;
  columnas-de-plantilla-de-cuadrícula: 1fr auto 1fr;
  alinear-elementos: centro;
  espacio: 10px;
  alineación de texto: centro;
  margen inferior: 16px;
  posición: relativa;
  desbordamiento: oculto;
}
.match-banner::before {
  contenido: "";
  posición: absoluta;
  arriba: 0; izquierda: 0; derecha: 0; altura: 2px;
  fondo: gradiente lineal(90 grados, transparente, #ffb45d, transparente);
}
.banner-team {
  pantalla: flexible;
  flex-direction: columna;
  alinear-elementos: centro;
  espacio: 8px;
}
.banner-crest {
  ancho: 62px;
  altura: 62px;
  objeto-ajustar: contener;
  filtro: drop-shadow(0 4px 10px rgba(0,0,0,0.5));
}
.crest-fallback {
  ancho: 58px;
  altura: 58px;
  radio de borde: 50%;
  fondo: #1d2533;
  borde: 2px sólido #36445c;
  pantalla: flexible;
  alinear-elementos: centro;
  justificar-contenido: centro;
  tamaño de fuente: 20px;
  grosor de fuente: 900;
  color: #ffb45d;
}
.banner-team-name {
  tamaño de fuente: 15px;
  grosor de fuente: 900;
  interlineado: 1,2;
  color: #fff;
  ancho máximo: 140px;
}
.banner-role-pill {
  tamaño de fuente: 9px;
  grosor de fuente: 900;
  espaciado entre letras: 1px;
  transformación de texto: mayúsculas;
  relleno: 2px 7px;
  radio de borde: 999px;
  fondo: #17202d;
  color: #9da5b2;
}
.banner-vs-center {
  pantalla: flexible;
  flex-direction: columna;
  alinear-elementos: centro;
  espacio: 4px;
}
.banner-vs-circle {
  ancho: 44px;
  altura: 44px;
  radio de borde: 50%;
  fondo: gradiente radial(círculo, #293448 0%, #10151f 100%);
  borde: 2px sólido #ffb45d;
  pantalla: flexible;
  alinear-elementos: centro;
  justificar-contenido: centro;
  tamaño de fuente: 15px;
  grosor de fuente: 900;
  color: #ffb45d;
  box-shadow: 0 0 16px rgba(255,180,93,0.3);
}
.banner-meta-time { font-size: 11px; font-weight: 800; color: #ffb45d; margin-top: 4px; }
.banner-meta-comp { font-size: 10px; color: #8e97a5; }

/* 7. MEDIDOR CIRCULAR DE CONFIANZA */
.tarjeta-de-confianza {
  fondo: #090d13;
  borde: 1px sólido #283344;
  radio de borde: 16px;
  relleno: 16px;
  margen: 14px 0;
  pantalla: flexible;
  alinear-elementos: centro;
  espacio: 16px;
}
.confidence-gauge-wrap {
  posición: relativa;
  ancho: 90px;
  altura: 90px;
  flex-shrink: 0;
}
.confidence-svg { ancho: 90px; alto: 90px; transformar: rotar(-90deg); }
.gauge-bg { stroke: #1a222e; stroke-width: 8; fill: none; }
.barra-de-indicador {
  grosor del trazo: 8;
  relleno: ninguno;
  remate de línea de trazo: redondo;
  transición: stroke-dashoffset 0.8s ease-in-out;
}
.gauge-bar.high { stroke: #7ee787; filter: drop-shadow(0 0 6px rgba(126,231,135,0.4)); }
.gauge-bar.medium { stroke: #ffb45d; filter: drop-shadow(0 0 6px rgba(255,180,93,0.4)); }
.gauge-bar.low { stroke: #ff7b72; filter: drop-shadow(0 0 6px rgba(255,123,114,0.4)); }
.contenido-de-gauge {
  posición: absoluta;
  recuadro: 0;
  pantalla: flexible;
  flex-direction: columna;
  alinear-elementos: centro;
  justificar-contenido: centro;
}
.gauge-num { font-size: 22px; font-weight: 900; line-height: 1; }
.gauge-label { font-size: 10px; font-weight: 800; text-transform: uppercase; margin-top: 2px; }
.detalles-de-confianza { flex: 1; }
.confidence-badge-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.etiqueta-insignia {
  tamaño de fuente: 11px;
  grosor de fuente: 800;
  relleno: 3px 8px;
  radio de borde: 6px;
  fondo: #17202d;
  color: #c7ccd4;
  display: inline-flex;
  alinear-elementos: centro;
  espacio: 4px;
}
.badge-consensus-agree { background: #0f2c1a; color: #7ee787; border: 1px solid #1a5230; }
.badge-consensus-disagree { background: #2f1712; color: #ff7b72; border: 1px solid #5a261c; }

/* INSTALACIONES Y GENERALIDADES */
.artículos fijos{
  fondo:#090d13;
  borde:1px sólido #252c37;
  radio de borde: 15px;
  relleno: 14px;
  margen inferior: 9px;
  transición:color de borde .15s;
}
.fixture-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;}
.fixture-teams{font-size:15px;font-weight:800;line-height:1.35;display:flex;align-items:center;flex-wrap:wrap;gap:4px;}
.team-crest{width:22px;height:22px;object-fit:contain;vertical-align:middle;}
.fixture-meta{color:#8e97a5;font-size:12px;margin-top:5px;}
.analiza-pequeño{
  borde:0;
  radio de borde: 10px;
  relleno: 9px 12px;
  fondo:#f4f5f7;
  color:#080b10;
  tamaño de fuente: 11px;
  peso de fuente: 900;
  espacio en blanco:nowrap;
  cursor:puntero;
}
.panel-de-análisis{
  mostrar:cuadrícula;
  filas-de-plantilla-de-cuadrícula:0fr;
  transición:grid-template-rows .28s ease, margin-top .28s ease;
  borde superior:0 sólido #252c37;
  margen superior:0;
}
.analysis-panel.open{grid-template-rows:1fr;margin-top:12px;border-top:1px solid #252c37;}
.analysis-inner{overflow:hidden;min-height:0;padding-top:0;}
.panel-de-análisis.abrir .análisis-interior{padding-top:12px;}
.análisis-cerrar{
  ancho:100%;
  borde:1px sólido #303846;
  radio de borde: 10px;
  relleno: 10px;
  fondo:#151a22;
  color:#fff;
  peso de fuente: 800;
  margen inferior: 10px;
  cursor:puntero;
}
.section-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#929ba9;margin:14px 0 8px;}
.fixture-decision{text-align:center;background:#10151d;border-radius:13px;padding:14px;}
.fixture-decision h3{margin:6px 0;font-size:24px;}
.noBet{color:#ffb45d;}
.bet{color:#7ee787;}
.prob-grid,.xg-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}
.prob,.xg{background:#090d13;border-radius:12px;padding:12px 8px;text-align:center;}
.prob span,.xg span{display:block;color:#8e97a5;font-size:11px;}
.prob b,.xg b{font-size:18px;}
.market{background:#090d13;border-radius:13px;padding:12px;margin-bottom:8px;}
.market-top{display:flex;justify-content:space-between;gap:10px;}
.market-details{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px;color:#8e97a5;font-size:12px;}
.market-details b{color:white;}
.value-box{border:1px solid #33414d;border-radius:13px;padding:13px;margin-top:10px;}
.simular-apuesta-btn{
  ancho:100%;
  borde:0;
  radio de borde: 11px;
  relleno: 12px;
  margen superior: 10px;
  fondo:#7ee787;
  color:#080b10;
  peso de fuente: 900;
  cursor:puntero;
}
.nav{
  posición:fija;
  arriba:0;izquierda:0;derecha:0;
  ancho máximo: 760px;
  margen:automático;
  fondo:rgba(10,13,18,.98);
  borde inferior: 1px sólido #252c37;
  pantalla:flex;
  justificar-contenido:espacio-alrededor;
  relleno:calc(16px + env(safe-area-inset-top, 0px)) 8px 14px;
  tamaño de fuente: 13px;
  color:#929ba9;
  índice z:30;
}
.nav span{cursor:pointer;padding:4px;text-align:center;}
.nav span.active-nav{color:white;font-weight:800;}
.empty{text-align:center;color:#9da5b2;padding:22px 8px;}
</style>
</head>
<cuerpo>

<div class="app">

<header class="header">
  <div>
    <span class="version">● V8.0.0 ANALYST</span>
  </div>

  <div class="logo-row">
    <svg width="86" height="36" viewBox="0 0 130 90" xmlns="http://www.w3.org/2000/svg">
      <polyline points="10,80 10,10 45,55 80,10 80,80" fill="none" stroke="#ffb45d" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="80" y1="45" x2="118" y2="8" stroke="#ffb45d" stroke-width="11" stroke-linecap="round"/>
      <line x1="80" y1="45" x2="118" y2="82" stroke="#ffb45d" stroke-width="11" stroke-linecap="round"/>
    </svg>
    <span class="logo-text">APUESTAS</span>
  </div>

  <h1 style="margin:14px 0 6px;font-size:28px;line-height:1.1">Analiza antes de apostar.</h1>
  <div class="subtitle">Motor Estadístico V8.0 + Localía Aprendida + Fatiga Suave + Lesiones Ponderadas + 2ª Opinión Desacoplada.</div>

  <div class="chips">
    <span class="chip">️ Localía Aprendida</span>
    <span class="chip">⏱️ Fatiga Asimétrica</span>
    <span class="chip"> Lesiones Ponderadas</span>
    <span class="chip"> 2ª Opinión Externa</span>
    <span class="chip"> Calibraciónón V8.1</span>
  </div>
</header>

<section class="card" id="searchCard">
  <div class="card-title">Buscar partidos por fecha</div>

  <div class="league-chips" id="leagueChips">
    <button type="button" class="league-chip active" data-competition="">Todas</button>
    <button type="button" class="league-chip league-chip-priority" data-competition="PD"> LaLiga</button>
    <button type="button" class="league-chip league-chip-priority" data-competition="CL">⭐ Campeones</button>
    <button type="button" class="league-chip" data-competition="PL"> Premier League</button>
    <button type="button" class="league-chip" data-competition="FL1"> Ligue 1</button>
    <button type="button" class="league-chip" data-competition="SA"> Serie A</button>
    <button type="button" class="league-chip" data-competition="BL1"> Bundesliga</button>
    <button type="button" class="league-chip" data-competition="EL">賂 Europa League</button>
  </div>

  <input id="date" type="date">

  <button class="primary" id="searchBtn" type="button"> BUSCAR PARTIDOS</button>
  <button class="analysis-close" id="nextFixtureBtn" type="button" style="margin-top:8px">⏭️ Buscar próximo partido disponible</button>

  <div id="searchSummary" style="color:#9da5b2;font-size:13px;margin-top:10px"></div>
</section>

<!-- 6. CONTENEDOR CARGADOR ESQUELETO -->
<div id="loadingSkeleton" style="display:none;margin-top:14px">
  <div class="loading-status-text">
    <span>⚽</span>
    <span id="loadingStatusText">Consultando partidos y calculando descanso...</span>
  </div>
  <div class="skeleton-card">
    <div class="skeleton-shimmer skeleton-pill" style="width:35%;margin-bottom:10px"></div>
    <div class="skeleton-row">
      <div class="skeleton-shimmer skeleton-circle"></div>
      <div class="skeleton-shimmer skeleton-text" style="width:45%"></div>
    </div>
    <div class="skeleton-row" style="margin-top:8px">
      <div class="skeleton-shimmer skeleton-circle"></div>
      <div class="skeleton-shimmer skeleton-text" style="width:40%"></div>
    </div>
  </div>
  <div class="skeleton-card">
    <div class="skeleton-shimmer skeleton-pill" style="width:30%;margin-bottom:10px"></div>
    <div class="skeleton-row">
      <div class="skeleton-shimmer skeleton-circle"></div>
      <div class="skeleton-shimmer skeleton-text" style="width:50%"></div>
    </div>
  </div>
</div>

<div id="error" class="card" style="display:none;color:#ff7b72"></div>

<section id="fixturesCard" class="card" style="display:none">
  <div class="card-title">Partidos de la fecha</div>
  <div id="fixtureList"></div>

  <button class="primary" id="parlayBtn" type="button" style="margin-top:12px"> GENERAR PARLAY SUGERIDO</button>
  <div id="parlayLoading" style="display:none;margin-top:12px">
    <div class="loading-status-text">Buscando picks fuertes y errores de cuota...</div>
  </div>
  <div id="parlayResult" style="margin-top:10px"></div>
</section>

<!-- VISTA INICIO -->
<section id="homeCard" class="card">
  <div style="text-align:center;padding:16px 0;border-bottom:1px solid #242b36;margin-bottom:14px">
    <div style="font-size:52px;line-height:1">⚽</div>
    <div style="font-style:italic;color:#c7ccd4;margin-top:8px">"El balón no miente. Los números tampoco."</div>
  </div>

  <div class="card-title">Novedades V8.0.0</div>
  <div class="muted">
    1. <b>Ventaja Local Aprendida:</b> Estimación bayesiana con regresióna la media según goles históricos reales por liga.<br>
    2. <b>Lesiones Ponderadas:</b> Impacto específico por posición (portero/defensa/delantera) y acotado al 8% máximo.<br>
    3. <b>Fatiga Asimétrica y Suave:</b> Diferencia fatiga defensiva de ofensiva con curvas suaves continuas.<br>
    4. <b>2ª Opinión Desacoplada:</b> Big Balls como referencia externa independiente sin alterar la confianza matemática propia.<br>
    5. <b>Favoritos >10d:</b> Chunking seguro de peticiones sin error HTTP 400.
  </div>
</section>

<!-- VISTA MIS APUESTAS (SIMULADOR DE APUESTAS & RENTABILIDAD) -->
<section id="betsCard" class="card" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid #242b36;padding-bottom:10px">
    <div>
      <div class="card-title" style="margin:0"> Mis apuestas</div>
      <div class="muted" style="font-size:11px">Simulador para recoger datos y medir el % de acierto real</div>
    </div>
    <div style="display:flex;gap:6px">
      <button type="button" id="btnDemoBets" class="league-chip" style="font-size:11px;padding:4px 8px">+ Probar</button>
      <button type="button" id="btnClearBets" class="league-chip" style="font-size:11px;padding:4px 8px;color:#ff7b72">Vaciar</button>
    </div>
  </div>

  <!-- Panel de Rentabilidad y Acierto -->
  <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:6px;margin-bottom:12px" id="betsStatsGrid">
    <!-- Se llena con renderBetsView() -->
  </div>

  <!-- Filtros -->
  <div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:10px" id="betsFilters">
    <button type="button" class="league-chip active" data-filter="all">Todas</button>
    <button type="button" class="league-chip" data-filter="pending">Pendientes</button>
    <button type="button" class="league-chip" data-filter="won">Ganadas</button>
    <button type="button" class="league-chip" data-filter="lost">Perdidas</button>
  </div>

  <!-- Lista de Apuestas -->
  <div id="betsList"></div>
</section>

</div>

<nav class="nav">
  <span id="navHome">⌂<br>Inicio</span>
  <span id="navAnalyst" class="active-nav"><strong>易<br>Analista</strong></span>
  <span id="navBets"><strong><br>Mis apuestas</strong></span>
</nav>

<script>
(función(){
'usar estricto';

let selectedCompetition = '';

función esc(val){
  return String(val == null ? '' : val)
    .replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>')
    .replace(/"/g,'"').replace(/'/g,''');
}

función pct(v){
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) + '%' : '-';
}

función localDateValue(){
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,10);
}

función formatTime(v){
  si (!v) devolver '--:--';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'});
}

función formatDate(v){
  si (!v) devuelve '';
  const p = v.split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : v;
}

función crestImg(url, nombre){
  si (url) {
    return '<img src="' + esc(url) + '" alt="' + esc(name) + '" class="banner-crest" onerror="this.remove()">';
  }
  return '<div class="crest-fallback">' + esc((name || 'T').charAt(0)) + '</div>';
}

/* 7. GENERADOR DEL MEDIDOR CIRCULAR DE CONFIANZA */
función renderCircularConfidence(conf, nivel, explicación, bbComp, restData) {
  const c = Math.max(0, Math.min(100, Number(conf) || 50));
  constante r = 38;
  circunferencia constante = 2 * Math.PI * r; // ~238,76
  desplazamiento constante = circun - (circun * c / 100);

  const colorClass = c >= 75 ? 'high' : (c >= 60 ? 'medium' : 'low');

  let consensusBadge = '';
  si (bbComp && bbComp.available) {
    const badgeCls = bbComp.agrees ? 'badge-consensus-agree' : 'badge-consensus-disagree';
    const icon = bbComp.agrees ? 'ðŸ¤ ' : 'âš ï¸ ';
    consensusBadge = '<div class="badge-tag ' + badgeCls + '">' + icon + ' ' + esc(bbComp.status) + '</div>';
  }

  let restBadge = '';
  si (restData) {
    restBadge = '<div class="badge-tag">â ±ï¸ Descanso: Loc ' + esc(restData.home?.days != null ? restData.home.days + 'd' : '?') + ' vs Vis ' + esc(restData.away?.days != null ? restData.away.days + 'd' : '?') + '</div>';
  }

  devolver \`
    <div class="tarjeta-de-confianza">
      <div class="confidence-gauge-wrap">
        <svg class="confidence-svg" viewBox="0 0 90 90">
          <circle class="gauge-bg" cx="45" cy="45" r="\${r}"></circle>
          <circle class="gauge-bar \${colorClass}" cx="45" cy="45" r="\${r}"
            stroke-dasharray="\${circum}"
            stroke-dashoffset="\${offset}">
          </círculo>
        </svg>
        <div class="gauge-content">
          <span class="gauge-num">\${c}%</span>
          <span class="gauge-label \${colorClass}">\${esc(level)}</span>
        </div>
      </div>
      <div class="detalles-de-confianza">
        <strong style="display:block;font-size:14px;color:#fff">Confianza del Análisis: \${esc(level)}</strong>
        <div class="muted" style="font-size:12px;margin-top:3px">\${esc(explanation)}</div>
        <div class="fila-insignia-de-confianza">
          ${insignia de consenso}
          ${restBadge}
        </div>
      </div>
    </div>
  `;
}

función fixtureHtml(f, idx, fecha){
  const panelId = 'analysis-' + idx + '-' + String(f.id || idx);
  devolver \`
    <article class="fixture">
      <div class="fixture-head">
        <div>
          <div class="fixture-teams">
            ${f.homeCrest ? '<img src="' + esc(f.homeCrest) + '" class="team-crest" alt="">' : ''}
            ${esc(f.home)}
            <span style="color:#8e97a5;font-weight:400">vs</span>
            ${f.awayCrest ? '<img src="' + esc(f.awayCrest) + '" class="team-crest" alt="">' : ''}
            ${esc(f.away)}
          </div>
          <div class="fixture-meta">
            ðŸ• \${formatTime(f.kickoff)} Â· ðŸ † \${esc(f.competition || 'Liga')}
          </div>
        </div>
        <button class="analyze-small" type="button" data-panel="\${panelId}" data-home="\${esc(f.home)}" data-away="\${esc(f.away)}" data-date="\${esc(date)}">
          ANALIZADOR
        </button>
      </div>

      <div id="\${panelId}" class="analysis-panel">
        <div class="analysis-inner">
          <button class="analysis-close" type="button" data-close="\${panelId}">â–² CERRAR ANÃ LISIS</button>

          <!-- Esqueleto interno del análisis -->
          <div id="\${panelId}-loading" style="display:none;padding:10px 0">
            <div class="loading-status-text">Analizando xG, descanso de jugadores y cuotas...</div>
            <div class="skeleton-shimmer" style="height:90px;border-radius:14px;margin-bottom:10px"></div>
            <div class="skeleton-shimmer" style="height:60px;border-radius:14px"></div>
          </div>

          <div id="\${panelId}-error" style="display:none;color:#ff7b72;padding:10px;background:#1e1416;border-radius:10px"></div>
          <div id="\${panelId}-content" style="display:none"></div>
        </div>
      </div>
    </artículo>
  `;
}

función asíncrona searchFixtures(){
  const fecha = document.getElementById('fecha').value;
  const skeleton = document.getElementById('loadingSkeleton');
  const error = document.getElementById('error');
  const tarjeta = document.getElementById('fixturesCard');
  const lista = document.getElementById('fixtureList');
  const summary = document.getElementById('searchSummary');

  si (!fecha) regresar;

  error.style.display = 'ninguno';
  esqueleto.estilo.visualización = 'bloque';
  tarjeta.style.display = 'ninguno';
  lista.innerHTML = '';
  resumen.textoContenido = '';

  intentar {
    const res = await fetch('/api/fixtures?date=' + encodeURIComponent(date) + (selectedCompetition ? '&competition=' + encodeURIComponent(selectedCompetition) : ''), { cache:'no-store' });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || 'Error cargando partidos.');

    tarjeta.style.display = 'block';
    const fixtures = Array.isArray(data.fixtures) ? data.fixtures : [];

    si (!fixtures.length) {
      resumen.textContent = 'No se encontraron partidos para ' + formatDate(date) + '.';
      list.innerHTML = '<div class="empty">No hay partidos programados para esta fecha.</div>';
      devolver;
    }

    resumen.textContent = fixtures.length + 'partidos encontrados.';
    lista.innerHTML = fixtures.map((f, i) => fixtureHtml(f, i, date)).join('');
  } capturar (error) {
    error.style.display = 'block';
    error.textContent = err.message || 'Error al buscar partidos.';
  } finalmente {
    esqueleto.estilo.visualización = 'ninguno';
  }
}

función asíncrona openAnalysis(panelId, home, away, date){
  const panel = document.getElementById(panelId);
  si (!panel) regresar;

  panel.classList.add('open');
  const loading = document.getElementById(panelId + '-loading');
  const error = document.getElementById(panelId + '-error');
  const content = document.getElementById(panelId + '-content');

  loading.style.display = 'block';
  error.style.display = 'ninguno';
  content.style.display = 'none';
  contenido.innerHTML = '';

  intentar {
    const res = await fetch('/api/analyze?home=' + encodeURIComponent(home) + '&away=' + encodeURIComponent(away) + '&date=' + encodeURIComponent(date), { cache:'no-store' });
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || 'No se pudo analizar el partido.');

    // RENDERIZAR ANÁLISIS COMPLETO
    contenido.innerHTML = renderAnalysisContent(datos);
    content.style.display = 'block';
  } capturar (error) {
    error.style.display = 'block';
    error.textContent = err.message || 'Error analizando partido.';
  } finalmente {
    loading.style.display = 'none';
  }
}

función renderAnalysisContent(datos){
  const m = data.match;

  // 4. BANNER VS CON ESCUDOS GRANDES
  const bannerHtml = \`
    <div class="match-banner">
      <div class="banner-team">
        ${crestImg(m.homeCrest, m.home)}
        <div class="banner-team-name">\${esc(m.home)}</div>
        <div class="banner-role-pill">LOCAL</div>
      </div>
      <div class="banner-vs-center">
        <div class="banner-meta-comp">ðŸ † \${esc(m.competition || 'Competición')}</div>
        <div class="banner-vs-circle">VS</div>
        <div class="banner-meta-time">ðŸ• \${formatTime(m.kickoff)}</div>
      </div>
      <div class="banner-team">
        ${crestImg(m.awayCrest, m.away)}
        <div class="banner-team-name">\${esc(m.away)}</div>
        <div class="banner-role-pill">VISITANTE</div>
      </div>
    </div>
  `;

  // 7. MEDIDOR CIRCULAR DE CONFIANZA
  const confidenceGaugeHtml = renderCircularConfidence(
    confianza en los datos,
    Nivel de confianza de los datos,
    datos.confianzaExplicación,
    data.bigBallsComparación,
    datos.rest
  );

  // DECISIÓN VALOR APUESTA
  window.__activeAnalysis = { match: m, data: data, recOdds: recOdds, recProb: recProb };
  const decisionClass = data.betEligible? 'apuesta' : 'noApuesta';
  const recMarket = (Array.isArray(data.markets) ? data.markets.find(mk => mk.name === data.recommendation) : null) || (Array.isArray(data.markets) ? data.markets[0] : null);
  const recOdds = recMarket && recMarket.bestOdds? Número (recMarket.bestOdds): 1,95;
  const recProb = recMarket && recMarket.probability ? Number(recMarket.probability) : (data.probabilities?.homeWin || 50);
  const isEligible = data.recommendation && data.recommendation !== 'NO BET';

  let simulateBtnHtml = '';
  si (eselegible) {
    simulateBtnHtml = '<div style="margin-top:12px">' +
      '<button type="button" class="simulate-bet-btn" onclick="saveCurrentSimulatedRec()">' +
        'ðŸ“Œ Simular esta apuesta (Guardar en Mis apuestas)' +
      '</button>' +
    '</div>';
  }

  let marketsHtml = '';
  Si (Array.isArray(data.markets) && data.markets.length > 0) {
    marketsHtml = '<div class="section-label">ðŸ'μ Cuotas & Mercados Disponibles</div>' +
      datos.mercados.mapa(función(mk, _mkIdx){
        const o = mk.bestOdds ? Number(mk.bestOdds).toFixed(2) : '-';
        const ev = mk.referenceEvPct ? (mk.referenceEvPct > 0 ? '+' : '') + mk.referenceEvPct + '%' : '-';
        return '<div class="market" style="display:flex;justify-content:space-between;align-items:center">' +
          '<div>' +
            '<b>' + esc(mk.name) + '</b>' +
            '<div class="muted" style="font-size:11px">Prob: ' + pct(mk.probability) + ' • EV: ' + ev + '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span style="font-weight:900;color:#ffb45d;font-size:14px">@' + o + '</span>' +
            '<button type="button" class="league-chip" style="padding:4px 8px;font-size:11px;background:#ffb45d;color:#080b10;font-weight:800;border:0;cursor:pointer" onclick="saveCurrentSimulatedMarket(' + _mkIdx + ')">' +
              '+ Simultáneo' +
            '</button>' +
          '</div>' +
        '</div>';
      }).unirse('');
  }

  let bbHtml = '';
  Si (data.bigBallsComparison && data.bigBallsComparison.available) {
    const borderColor = data.bigBallsComparison.agrees ? '#1a5230' : '#5a261c';
    const bgColor = data.bigBallsComparison.agrees ? '#0b1f14' : '#1e110f';
    const textColor = data.bigBallsComparison.agrees ? '#7ee787' : '#ff7b72';
    const textTitle = data.bigBallsComparison.agrees? 'ðŸ¤ Consenso Big Balls' : 'âš ï¸ Alerta de Divergencia Big Balls';
    bbHtml = '<div class="value-box" style="border-color:' + borderColor + ';background:' + bgColor + '">' +
      '<b estilo="color:' + colortexto + '">' + títulotexto + '</b>' +
      '<div class="muted" style="margin-top:4px">' + esc(data.bigBallsComparison.message) + '</div>' +
    '</div>';
  }

  devolver bannerHtml +
    '<div class="fixture-decision">' +
      '<div class="section-label">Decisión del modelo</div>' +
      '<h3 class="' + decisionClass + '">' + esc(data.recommendation) + '</h3>' +
      '<div class="muted">' + esc(data.reason) + '</div>' +
      simularBtnHtml +
    '</div>' +
    indicador de confianzaHtml +
    bbHtml +
    '<div class="section-label">ðŸ“Š Probabilidades 1X2</div>' +
    '<div class="prob-grid">' +
      '<div class="prob"><span>ðŸ LOCAL</span><b>' + pct(data.probabilities?.homeWin) + '</b></div>' +
      '<div class="prob"><span>ðŸ¤ EMPATE</b>' + pct(data.probabilities?.draw) + '</b></div>' +
      '<div class="prob"><span>âœˆï¸ VISITANTE</b>' + pct(data.probabilities?.awayWin) + '</b></div>' +
    '</div>' +
    '<div class="section-label">âš½ xG Esperados (Localía ' + (data.homeAdvantage?.factor || 1.08) + 'x)</div>' +
    '<div class="xg-grid">' +
      '<div class="xg"><span>LOCAL</span><b>' + (data.xG?.home || '-') + '</b></div>' +
      '<div class="xg"><span>VISITANTE</span><b>' + (data.xG?.away || '-') + '</b></div>' +
      '<div class="xg"><span>TOTAL</span><b>' + (data.xG?.total || '-') + '</b></div>' +
    '</div>' +
    '<div class="section-label">â ±ï¸ Descanso Calculado (Football-Data)</div>' +
    '<div class="market">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:6px">' +
        '<span><b>' + esc(m.home) + ':</b> ' + esc(data.rest?.home?.status || 'Sin datos') + '</span>' +
        '<span>' + (data.rest?.home?.impactPct ? data.rest.home.impactPct + '%' : '0%') + '</span>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between">' +
        '<span><b>' + esc(m.away) + ':</b> ' + esc(data.rest?.away?.status || 'Sin datos') + '</span>' +
        '<span>' + (data.rest?.away?.impactPct ? data.rest.away.impactPct + '%' : '0%') + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="section-label">ðŸŽ¯ Marcador MÃ¡s Probable</div>' +
    '<div class="market" style="text-align:center">' +
      '<div style="font-size:32px;font-weight:900">' + esc(data.mostLikelyScore?.score) + '</div>' +
      '<div class="muted">Probabilidad: ' + pct(data.mostLikelyScore?.probability) + '</div>' +
    '</div>' +
    mercadosHtml;
}

// ==========================================
// SIMULADOR DE APUESTAS & RENTABILIDAD (LOCALSTORAGE)
// ==========================================
const STORAGE_BETS_KEY = 'mkbets_my_bets_v1';

función obtenerApuestasSavadas() {
  intentar {
    const raw = localStorage.getItem(STORAGE_BETS_KEY);
    devolver raw ? JSON.parse(raw) : [];
  } capturar (e) {
    devolver [];
  }
}

función saveBets(apuestas) {
  intentar {
    localStorage.setItem(STORAGE_BETS_KEY, JSON.stringify(bets));
  } capturar (e) {}
}


ventana.guardarCurrentSimulatedRec = función() {
  si (!window.__activeAnalysis) regresar;
  var a = window.__activeAnalysis;
  ventana.guardarApuestaSimulada(
    un.partido.casa,
    a.match.homeCrest || '',
    a.partido.de.
    a.match.awayCrest || '',
    una.competición || '',
    a.recomendación.de.datos,
    a.recOdds,
    a.recProb,
    a.confianza.de.datos,
    Nivel de confianza de los datos
  );
};

ventana.guardarMercadoSimuladoActual = función(idx) {
  si (!window.__activeAnalysis || !window.__activeAnalysis.data.markets) devolver;
  var a = window.__activeAnalysis;
  var mk = a.data.markets[idx];
  si (!mk) regresar;
  ventana.guardarApuestaSimulada(
    un.partido.casa,
    a.match.homeCrest || '',
    a.partido.de.
    a.match.awayCrest || '',
    una.competición || '',
    mk.nombre,
    mk.bestOdds || 1.90,
    mk.probabilidad || 50,
    a.confianza.de.datos,
    Nivel de confianza de los datos
  );
};

document.addEventListener('click', function(ev) {
  var sBtn = ev.target.closest('[data-action="settle"]');
  si (sBtn) {
    var id = sBtn.getAttribute('data-bet-id');
    var st = sBtn.getAttribute('data-status');
    Si (id && st) window.settleBet(id, st);
    devolver;
  }
  var dBtn = ev.target.closest('[data-action="delete"]');
  si (dBtn) {
    var id = dBtn.getAttribute('data-bet-id');
    Si (id) window.deleteBet(id);
    devolver;
  }
});

window.saveSimulatedBet = function(home, homeCrest, away, awayCrest, competition, marketName, odds, probability, confidence, confidenceLevel) {
  const apuestas = obtenerApuestasGuardadas();
  const exists = bets.some(function(b){ return b.home === home && b.away === away && b.marketName === marketName && b.status === 'pending'; });
  si (existe) {
    alert('Esta apuesta ya está guardada en Mis apuestas como pendiente.');
    devolver;
  }
  const dateInput = document.getElementById('date');
  const nuevaApuesta = {
    id: 'bet_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    creadoEn: nuevo Date().toISOString(),
    matchDate: (dateInput && dateInput.value) || new Date().toISOString().slice(0, 10),
    hogar: hogar,
    homeCrest: homeCrest,
    lejos: lejos,
    awayCrest: awayCrest,
    competencia: competencia,
    Nombre del mercado: nombre del mercado,
    probabilidades: Número(probabilidades) || 1.95,
    probabilidad: Número(probabilidad) || 50,
    participaciónEur: 10,
    confianza: Número(confianza) || 75,
    Nivel de confianza: nivel de confianza || 'Alta',
    estado: 'pendiente',
    beneficioEur: 0
  };
  apuestas.unshift(nuevaApuesta);
  guardarApuestas(apuestas);
  alert('¡Apuesta guardada en "Mis apuestas"! Puedes ver las métricas de acierto y rentabilidad en la pestaña Mis apuestas.');
  renderBetsView();
};

ventana.settleBet = función(id, estado) {
  const apuestas = obtenerApuestasGuardadas();
  const bet = bets.find(function(b){ return b.id === id; });
  si (!apuesta) regresar;
  bet.status = status;
  si (estado === 'ganó') {
    bet.profitEur = Number((bet.stakeEur * (bet.odds - 1)).toFixed(2));
  } else if (estado === 'perdido') {
    bet.profitEur = -bet.stakeEur;
  } demás {
    bet.profitEur = 0;
  }
  bet.settledAt = status === 'pending' ? null : new Date().toISOString();
  guardarApuestas(apuestas);
  renderBetsView();
};

ventana.eliminarApuesta = función(id) {
  let apuestas = obtenerApuestasGuardadas();
  apuestas = apuestas.filter(function(b){ return b.id !== id; });
  guardarApuestas(apuestas);
  renderBetsView();
};

ventana.clearAllBets = función() {
  if (confirm('Â¿Quieres vaciar todas tus apuestas simuladas?')) {
    guardarApuestas([]);
    renderBetsView();
  }
};

ventana.seedDemoBets = función() {
  const d = new Date();
  const yesterday = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
  const demostración = [
    {
      id: 'demo_1',
      createdAt: new Date(d.getTime() - 86400000).toISOString(),
      Fecha del partido: ayer,
      Inicio: 'Real Madrid',
      homeCrest: 'https://crests.football-data.org/86.png',
      visitante: 'FC Barcelona',
      awayCrest: 'https://crests.football-data.org/81.png',
      competición: 'LaLiga EA Sports',
      Nombre del mercado: 'Gana local',
      probabilidades: 1,95,
      probabilidad: 58,4,
      participaciónEur: 10,
      confianza: 82,
      Nivel de confianza: 'Alta',
      estado: 'ganó',
      beneficioEur: 9,50,
      establecidoEn: new Date().toISOString()
    },
    {
      id: 'demo_2',
      createdAt: new Date(d.getTime() - 172800000).toISOString(),
      matchDate: new Date(d.getTime() - 172800000).toISOString().slice(0, 10),
      Inicio: 'Arsenal FC',
      homeCrest: 'https://crests.football-data.org/57.png',
      visitante: 'Chelsea FC',
      awayCrest: 'https://crests.football-data.org/61.png',
      competición: 'Premier League',
      Nombre del mercado: 'Más de 2.5',
      probabilidades: 1,92
      probabilidad: 56,2,
      participaciónEur: 10,
      confianza: 76,
      Nivel de confianza: 'Alta',
      estado: 'ganó',
      beneficioEur: 9,20,
      establecidoEn: new Date().toISOString()
    },
    {
      id: 'demo_3',
      createdAt: new Date(d.getTime() - 259200000).toISOString(),
      matchDate: new Date(d.getTime() - 259200000).toISOString().slice(0, 10),
      Inicio: 'Inter de Milán',
      homeCrest: 'https://crests.football-data.org/108.png',
      visitante: 'Juventus FC',
      awayCrest: 'https://crests.football-data.org/109.png',
      competición: 'Serie A',
      Nombre del mercado: 'Gana local',
      Probabilidades: 2.10,
      probabilidad: 49,0,
      participaciónEur: 10,
      confianza: 65,
      Nivel de confianza: 'Medios de comunicación',
      estado: 'perdido',
      beneficioEur: -10,00,
      establecidoEn: new Date().toISOString()
    },
    {
      id: 'demo_4',
      creadoEn: nuevo Date().toISOString(),
      matchDate: new Date().toISOString().slice(0, 10),
      casa: 'Manchester City',
      HomeCrest: 'https://crests.football-data.org/65.png',
      visitante: 'Liverpool FC',
      awayCrest: 'https://crests.football-data.org/64.png',
      competición: 'Premier League',
      Nombre del mercado: 'Gana local',
      probabilidades: 1,88
      probabilidad: 60,5,
      participaciónEur: 10,
      confianza: 84,
      Nivel de confianza: 'Alta',
      estado: 'pendiente',
      beneficioEur: 0
    }
  ];
  guardarApuestas(demo);
  renderBetsView();
};

sea ​​currentBetsFilter = 'all';

función renderBetsView() {
  const container = document.getElementById('betsList');
  const statsContainer = document.getElementById('betsStatsGrid');
  si (!contenedor || !statsContainer) regresar;

  const apuestas = obtenerApuestasGuardadas();
  const resolved = bets.filter(function(b){ return b.status === 'ganó' || b.status === 'perdió'; });
  const won = bets.filter(function(b){ return b.status === 'won'; }).length;
  const lost = bets.filter(function(b){ return b.status === 'lost'; }).length;
  const pending = bets.filter(function(b){ return b.status === 'pending'; }).length;

  const accuracy = resolved.length > 0 ? ((won / resolved.length) * 100).toFixed(1) + '%' : 'â€—';
  const totalProfit = resolved.reduce(function(acc, b){ return acc + (b.profitEur || 0); }, 0);
  const totalStaked = resolved.reduce(function(acc, b){ return acc + (b.stakeEur || 10); }, 0);
  const roi = totalStaked > 0 ? ((totalProfit / totalStaked) * 100).toFixed(1) + '%' : 'â€—';

  sea ​​streakCount = 0;
  let streakType = null;
  para (let i = 0; i < resolved.length; i++) {
    const b = resolved[i];
    si (streakType === null) {
      Tipo de racha = b.estado;
      Contador de rachas = 1;
    } else if (b.status === streakType) {
      Contador de rachas++;
    } demás {
      romper;
    }
  }

  Color de beneficio constante = beneficio total > 0? '#7ee787': ¿Beneficio total < 0? '#ff7b72' : 'blanco';
  signo de beneficio constante = beneficio total > 0? '+': '';
  const streakText = streakType === 'won' ? ('ðŸ”¥ ' + streakCount + 'G') : streakType === 'lost' ? ('â „ï¸ ' + streakCount + 'P') : (pending + ' pend.');
  const streakColor = streakType === 'won' ? '#7ee787' : streakType === 'lost' ? '#ff7b72' : '#ffb45d';

  statsContainer.innerHTML =
    '<div style="background:#090d13;border:1px solid #202938;border-radius:10px;padding:8px 4px;text-align:center">' +
      '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">Acierto</div>' +
      '<div style="font-size:16px;font-weight:900;color:white;margin:2px 0">' + precisión + '</div>' +
      '<div style="font-size:9px;color:#9da5b2">' + ganó + 'G ​​/ ' + perdió + 'P</div>' +
    '</div>' +
    '<div style="background:#090d13;border:1px solid #202938;border-radius:10px;padding:8px 4px;text-align:center">' +
      '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">Beneficio</div>' +
      '<div style="font-size:16px;font-weight:900;color:' + profitColor + ';margin:2px 0">' + profitSign + totalProfit.toFixed(2) + 'â‚¬</div>' +
      '<div style="font-size:9px;color:#9da5b2">10â‚¬ apuesta</div>' +
    '</div>' +
    '<div style="background:#090d13;border:1px solid #202938;border-radius:10px;padding:8px 4px;text-align:center">' +
      '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">ROI</div>' +
      '<div style="font-size:16px;font-weight:900;color:' + profitColor + ';margin:2px 0">' + roi + '</div>' +
      '<div style="font-size:9px;color:#9da5b2">Rendimiento</div>' +
    '</div>' +
    '<div style="background:#090d13;border:1px solid #202938;border-radius:10px;padding:8px 4px;text-align:center">' +
      '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">Racha</div>' +
      '<div style="font-size:15px;font-weight:900;color:' + streakColor + ';margin:2px 0">' + streakText + '</div>' +
      '<div style="font-size:9px;color:#9da5b2">' + pendiente + ' en juego</div>' +
    '</div>';

  const filtrado = apuestas.filtro(función(b){
    Si (currentBetsFilter === 'all') devuelve verdadero;
    devolver b.status === currentBetsFilter;
  });

  Si (filtered.length === 0) {
    contenedor.innerHTML =
      '<div class="empty" style="padding:24px 10px;border:1px dashed #283344;border-radius:12px">' +
        '<div style="font-size:28px;margin-bottom:6px">ðŸ“Š</div>' +
        '<div style="font-weight:bold;color:white;margin-bottom:4px">No hay apuestas en esta vista</div>' +
        '<div style="font-size:11px;color:#8e97a5;margin-bottom:12px">Abre cualquier partido en "Analyst" y haz clic en "ðŸ“Œ Simular esta apuesta" para medir los resultados.</div>' +
        '<button type="button" class="league-chip active" onclick="seedDemoBets()">+ Cargar 4 apuestas de ejemplo</button>' +
      '</div>';
    devolver;
  }

  contenedor.innerHTML = filtrado.map(function(b){
    const isWon = b.status === 'won';
    const isLost = b.status === 'lost';
    const isPending = b.status === 'pending';

    let badgeHtml = '';
    si (estáPendiente) {
      badgeHtml = '<span style="font-size:10px;font-weight:800;color:#ffb45d;background:#282114;border:1px solid #ffb45d55;padding:2px 8px;border-radius:12px">â ³ Pendiente</span>';
    } else if (isWon) {
      badgeHtml = '<span style="font-size:10px;font-weight:800;color:#7ee787;background:#0d2a1b;border:1px solid #1d5b38;padding:2px 8px;border-radius:12px">âœ… GanÃ³ (+' + b.profitEur.toFixed(2) + 'â‚¬)</span>';
    } else if (isLost) {
      badgeHtml = '<span style="font-size:10px;font-weight:800;color:#ff7b72;background:#2a1314;border:1px solid #5d2225;padding:2px 8px;border-radius:12px">â Œ PerdiÃ³ (' + b.profitEur.toFixed(2) + 'â‚¬)</span>';
    } demás {
      badgeHtml = '<span style="font-size:10px;font-weight:800;color:#c7ccd4;background:#1f2633;border:1px solid #37455d;padding:2px 8px;border-radius:12px">âž– Anulada</span>';
    }

    const wonAmount = (b.stakeEur * (b.odds - 1)).toFixed(2);
    const actionsHtml = isPending ?
      '<div style="display:flex;gap:6px">' +
        '<button type="button" data-action="settle" data-status="won" data-bet-id="' + b.id + '" style="background:#103320;color:#7ee787;border:1px solid #22633d;border-radius:8px;padding:6px 10px;font-weight:900;font-size:11px;cursor:pointer">âœ… GanÃ³ (+' + wonAmount + 'â‚¬)</button>' +
        '<button type="button" data-action="settle" data-status="lost" data-bet-id="' + b.id + '" style="background:#2e1315;color:#ff7b72;border:1px solid #5d2327;border-radius:8px;padding:6px 10px;font-weight:900;font-size:11px;cursor:pointer">â Œ PerdiÃ³ (-' + b.stakeEur + 'â‚¬)</button>' +
        '<button type="button" data-action="settle" data-status="void" data-bet-id="' + b.id + '" style="background:#1b2330;color:#9da5b2;border:1px solid #2a374c;border-radius:8px;padding:6px 8px;font-size:11px;cursor:pointer" title="Anular">âž–</button>' +
      '</div>' :
      '<div>' +
        '<button type="button" data-action="settle" data-status="pending" data-bet-id="' + b.id + '" style="background:transparent;border:0;color:#8e97a5;text-decoration:underline;font-size:11px;cursor:pointer">Modificar resultado</button>' +
      '</div>';

    return '<div style="background:#0b0f16;border:1px solid #202b3a;border-radius:12px;padding:12px;margin-bottom:8px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#8e97a5;margin-bottom:6px">' +
        '<span>ðŸ † ' + esc(b.competition || '') + ' â€¢ ðŸ“… ' + esc(b.matchDate || '') + '</span>' +
        insigniaHtml +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<div style="font-size:13px;font-weight:bold;color:white;display:flex;align-items:center;gap:6px">' +
          '<span>' + esc(b.home) + '</span>' +
          '<span style="color:#8e97a5;font-size:10px">vs</span>' +
          '<span>' + esc(b.away) + '</span>' +
        '</div>' +
        '<button type="button" data-action="delete" data-bet-id="' + b.id + '" style="background:transparent;border:0;color:#64748b;font-size:12px;cursor:pointer" title="Eliminar">ðŸ—'ï¸ </button>' +
      '</div>' +
      '<div style="background:#121824;border:1px solid #212d40;border-radius:10px;padding:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">' +
        '<div>' +
          '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">PronÃ³stico Simulado</div>' +
          '<div style="font-size:13px;font-weight:900;color:white">' + esc(b.marketName) + ' <span style="color:#ffb45d;font-size:11px">@' + Number(b.odds).toFixed(2) + '</span></div>' +
          '<div style="font-size:10px;color:#9da5b2">Confianza: ' + esc(b.confidenceLevel || 'Alta') + ' (' + b.confidence + '%) • Stake: ' + b.stakeEur + 'â‚¬</div>' +
        '</div>' +
        accionesHtml +
      '</div>' +
    '</div>';
  }).unirse('');
}

// INICIALIZACIÃ“N
document.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById('date');
  si (fechaInput) fechaInput.value = localDateValue();

  document.getElementById('searchBtn')?.addEventListener('click', searchFixtures);

  const chips = document.querySelectorAll('#leagueChips .league-chip');
  chips.forEach(c => {
    c.addEventListener('click', () => {
      chips.forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      competencia seleccionada = c.conjunto de datos.competencia || '';
      searchFixtures();
    });
  });

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-panel]');
    si (btn) {
      openAnalysis(btn.dataset.panel, btn.dataset.home, btn.dataset.away, btn.dataset.date);
    }
    const closeBtn = e.target.closest('[data-close]');
    si (closeBtn) {
      document.getElementById(closeBtn.dataset.close)?.classList.remove('open');
    }
  });

  función mostrarPestaña(nombre) {
    document.getElementById('navHome')?.classList.toggle('active-nav', name === 'home');
    document.getElementById('navAnalyst')?.classList.toggle('active-nav', name === 'analyst');
    document.getElementById('navBets')?.classList.toggle('active-nav', name === 'bets');

    const homeCard = document.getElementById('homeCard');
    const searchCard = document.getElementById('searchCard');
    const fixturesCard = document.getElementById('fixturesCard');
    const betsCard = document.getElementById('betsCard');

    if (homeCard) homeCard.style.display = name === 'home' ? 'block' : 'none';
    if (searchCard) searchCard.style.display = name === 'analyst' ? 'block' : 'none';
    if (fixturesCard) fixturesCard.style.display = name === 'analyst' ? 'block' : 'none';
    if (betsCard) betsCard.style.display = name === 'bets' ? 'block' : 'none';

    si (nombre === 'apuestas') {
      renderBetsView();
    }
  }

  document.getElementById('navHome')?.addEventListener('click', () => showTab('home'));
  document.getElementById('navAnalyst')?.addEventListener('click', () => {
    mostrarTab('analista');
    searchFixtures();
  });
  document.getElementById('navBets')?.addEventListener('click', () => showTab('bets'));

  document.querySelectorAll('#betsFilters button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#betsFilters button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentBetsFilter = btn.dataset.filter || 'all';
      renderBetsView();
    });
  });

  document.getElementById('btnDemoBets')?.addEventListener('click', seedDemoBets);
  document.getElementById('btnClearBets')?.addEventListener('click', clearAllBets);
});
})();
</script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store,no-cache,must-revalidate,proxy-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.send(renderPage());
});

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, modelVersion: MODEL_VERSION, uptime: process.uptime() });
});

app.listen(PORT, async () => {
  console.log(`MK Bets ${MODEL_VERSION} ejecutándose en el puerto ${PORT}`);
  esperar ensureSchema();
});
