const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
let Pool;
try {
  Pool = require('pg').Pool;
} catch (e) {
  Pool = null;
}

// Importar motor o usar fallback interno aut\u00f3nomo
let engine;
try {
  engine = require('./engine');
} catch (e) {
  engine = {
    clamp: (val, min, max) => Math.max(min, Math.min(max, val)),
    shrinkToMean: (val, baseline, n = 10) => {
      const weight = n / (n + 4);
      return weight * val + (1 - weight) * baseline;
    },
    implied: (odds) => odds > 1 ? Number(((1 / odds) * 100).toFixed(1)) : null,
    ev: (p, odds) => {
      const prob = p > 1 ? p / 100 : p;
      return Number(((prob * odds - 1) * 100).toFixed(1));
    },
    confidence: (prob, n = 10) => {
      const p = prob > 1 ? prob / 100 : prob;
      const sample = Math.min(1, Math.max(0.4, n / 10));
      return Math.round(Math.min(95, Math.max(20, (35 + ((p - 0.33) / 0.45) * 55) * sample)));
    },
    matchModel: (homeXg, awayXg) => {
      const hXg = Math.max(0.1, Number(homeXg) || 1.3);
      const aXg = Math.max(0.1, Number(awayXg) || 1.1);
      function p(k, l) {
        let f = 1; for (let i = 2; i <= k; i++) f *= i;
        return (Math.exp(-l) * Math.pow(l, k)) / f;
      }
      let hw = 0, d = 0, aw = 0, o25 = 0, u25 = 0, btts = 0;
      for (let h = 0; h <= 7; h++) {
        for (let a = 0; a <= 7; a++) {
          const prob = p(h, hXg) * p(a, aXg);
          if (h > a) hw += prob; else if (h === a) d += prob; else aw += prob;
          if (h + a >= 3) o25 += prob; else u25 += prob;
          if (h >= 1 && a >= 1) btts += prob;
        }
      }
      const total = hw + d + aw;
      return { homeWin: hw / total, draw: d / total, awayWin: aw / total, over25: o25, under25: u25, btts };
    }
  };
}

const {
  matchModel,
  implied,
  ev,
  confidence,
  shrinkToMean,
  clamp
} = engine;

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* =========================================================
   ACCESO PRIVADO (usuario/contrase\u00f1a)
========================================================= */
const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

if (APP_USERNAME && APP_PASSWORD) {
  app.use((req, res, next) => {
    // Permitir health check y descargas p\u00fablicas
    if (req.path === '/health' || req.path === '/api/download-server') return next();

    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
      if (timingSafeEqual(user, APP_USERNAME) && timingSafeEqual(pass, APP_PASSWORD)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="Mi Pronostico Deportivo"');
    return res.status(401).send('Acceso restringido.');
  });
  console.log('[AUTH] Acceso protegido con usuario/contrase\u00f1a activado.');
}

const MODEL_VERSION = 'V8.0.0';
const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const ODDS_API_KEY = process.env.ODDS_API_KEY;
const BIGBALLS_KEY = process.env.BIGBALLS_KEY || '';

const BIGBALLS_LEAGUE_MAP = {
  PD: 'laliga',
  PL: 'epl',
  FL1: 'ligue1',
  SA: 'serie_a',
  BL1: 'bundesliga',
  CL: 'cl',
  EL: 'el'
};

/* =========================================================
   1. VENTAJA DE LOCAL DIN\u00c1MICA Y APRENDIDA (V8.0)
   Home Advantage = promedio hist\u00f3rico de goles local / goles visitante
   de esa competici\u00f3n, suavizado (shrinkage) hacia la media global (1.09x).
========================================================= */
const GLOBAL_HOME_ADVANTAGE_BASELINE = 1.09;
const learnedHomeAdvantage = new Map();

// Priors iniciales calibrados estad\u00edsticamente
const HOME_ADVANTAGE_PRIORS = {
  PD: 1.13,  // LaLiga
  SA: 1.12,  // Serie A
  EL: 1.12,  // Europa League
  BL1: 1.10, // Bundesliga
  CL: 1.09,  // Champions League
  FL1: 1.08, // Ligue 1
  PL: 1.07   // Premier League
};

function updateLearnedHomeAdvantage(competitionCode, matches) {
  if (!competitionCode || !Array.isArray(matches) || matches.length < 5) return;
  let homeGoals = 0;
  let awayGoals = 0;
  let count = 0;

  for (const m of matches) {
    const hg = Number(m.score?.fullTime?.home ?? m.homeGoals ?? m.goalsHome);
    const ag = Number(m.score?.fullTime?.away ?? m.awayGoals ?? m.goalsAway);
    if (Number.isFinite(hg) && Number.isFinite(ag)) {
      homeGoals += hg;
      awayGoals += ag;
      count++;
    }
  }

  if (count >= 5 && awayGoals > 0) {
    const rawRatio = homeGoals / Math.max(awayGoals, 1);
    // Suavizado bayesiano con 12 pseudo-observaciones hacia la media global
    const weight = count / (count + 12);
    const smoothed = weight * rawRatio + (1 - weight) * GLOBAL_HOME_ADVANTAGE_BASELINE;
    const clamped = Math.max(1.03, Math.min(1.22, Number(smoothed.toFixed(3))));
    learnedHomeAdvantage.set(competitionCode, {
      factor: clamped,
      sampleSize: count,
      rawRatio: Number(rawRatio.toFixed(3)),
      updatedAt: Date.now()
    });
  }
}

function getHomeAdvantage(competitionCode) {
  const learned = learnedHomeAdvantage.get(competitionCode);
  if (learned && learned.factor) {
    return learned.factor;
  }
  return HOME_ADVANTAGE_PRIORS[competitionCode] || GLOBAL_HOME_ADVANTAGE_BASELINE;
}

/* =========================================================
   CACH\u00c9 MULTINIVEL CON TTLs INDEPENDIENTES (V8.0)
   Evita que cuotas o partidos se congelen 24 horas.
========================================================= */
const CACHE_TTLS = {
  odds: 3,         // Cuotas de casas de apuestas: 3 minutos
  analysis: 15,    // An\u00e1lisis recalculable: 15 minutos
  fixtures: 25,    // Fixtures del d\u00eda y favoritos: 25 minutos
  injuries: 90,    // Bajas y lesiones: 90 minutos (1.5 horas)
  history: 240,    // Historial y H2H: 4 horas
  teams: 1440,     // Nombres de equipos y ligas: 24 horas
  default: 30
};

const STAKE_EUR = Number(process.env.STAKE_EUR) || 10;
const DATABASE_URL = process.env.DATABASE_URL || '';

const pool = (DATABASE_URL && Pool)
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' || DATABASE_URL.includes('render')
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

if (pool) {
  pool.on('error', (err) => {
    console.warn('[DB] PostgreSQL cliente en background reconectando:', err.message);
  });
}

async function ensureSchema() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS simulated_bets (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        match_date DATE,
        home TEXT NOT NULL,
        away TEXT NOT NULL,
        competition TEXT,
        market TEXT NOT NULL,
        outcome TEXT NOT NULL,
        market_name TEXT NOT NULL,
        odds NUMERIC NOT NULL,
        model_probability NUMERIC,
        stake_eur NUMERIC NOT NULL DEFAULT 10,
        status TEXT NOT NULL DEFAULT 'pending',
        profit_eur NUMERIC,
        settled_at TIMESTAMPTZ,
        legs_json JSONB
      );
    `);
    console.log('[DB] Esquema verificado (simulated_bets).');
  } catch (error) {
    console.error('[DB] Error creando esquema:', error.message);
  }
}

const ODDS_SPORT_BY_COMPETITION = {
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  BL1: 'soccer_germany_bundesliga',
  SA: 'soccer_italy_serie_a',
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
  EL: 'soccer_uefa_europa_league'
};

const COMPETITIONS = Object.keys(ODDS_SPORT_BY_COMPETITION);
const cache = new Map();

function getTtlMinutes(category) {
  if (typeof category === 'number') return category;
  return CACHE_TTLS[category] || CACHE_TTLS.default;
}

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  const maxAgeMs = (item.ttlMinutes || CACHE_TTLS.default) * 60 * 1000;
  if (Date.now() - item.time > maxAgeMs) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function cacheGetTimestamp(key) {
  const item = cache.get(key);
  if (!item) return null;
  const maxAgeMs = (item.ttlMinutes || CACHE_TTLS.default) * 60 * 1000;
  if (Date.now() - item.time > maxAgeMs) return null;
  return item.time;
}

function cacheSet(key, data, category = 'default') {
  const ttlMinutes = getTtlMinutes(category);
  cache.set(key, { time: Date.now(), data, ttlMinutes });
  return data;
}

function cacheSetIfNotEmpty(key, data, category = 'default') {
  if (Array.isArray(data) && data.length === 0) return data;
  return cacheSet(key, data, category);
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const TEAM_NAME_STOPWORDS = new Set([
  'fc', 'cf', 'afc', 'ac', 'cd', 'sc', 'ec', 'ud', 'rc', 'ca',
  'club', 'the', 'de', 'of', 'sad', 'sa', 'cfr', 'if'
]);

function nameTokens(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter(token => !TEAM_NAME_STOPWORDS.has(token));
}

function tokenFoundIn(word, tokenList) {
  for (const token of tokenList) {
    if (token === word) return true;
    if (word.length >= 4 && token.length >= 4 && (token.includes(word) || word.includes(token))) {
      return true;
    }
  }
  return false;
}

function namesMatch(a, b) {
  const fullA = normalizeName(a);
  const fullB = normalizeName(b);
  if (!fullA || !fullB || fullA.length < 3 || fullB.length < 3) return false;
  if (fullA === fullB) return true;
  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);
  if (!tokensA.length || !tokensB.length) return false;
  const [shortSide, longSide] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  return shortSide.every(word => tokenFoundIn(word, longSide));
}

/* =========================================================
   BIG BALLS API & PREDICCIONES
========================================================= */
async function bigBallsRequest(path) {
  if (!BIGBALLS_KEY) return null;
  const key = `bigballs:${path}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const response = await fetch(`https://api.bigballsdata.com${path}`, {
      headers: { 'Authorization': `Bearer ${BIGBALLS_KEY}` }
    });
    if (!response.ok) {
      console.warn(`[BIGBALLS] ${path} -> HTTP ${response.status}`);
      return null;
    }
    const data = await response.json();
    return cacheSetIfNotEmpty(key, data);
  } catch (error) {
    console.warn('[BIGBALLS] error:', path, error.message);
    return null;
  }
}

async function getBigBallsTeams(bbLeagueKey) {
  const data = await bigBallsRequest(`/v1/teams?sport=football&league=${bbLeagueKey}`);
  return Array.isArray(data?.data) ? data.data : [];
}

async function getBigBallsInjuries(bbLeagueKey) {
  const data = await bigBallsRequest(`/v1/injuries?sport=football&league=${bbLeagueKey}`);
  return Array.isArray(data?.data?.injuries?.value) ? data.data.injuries.value : [];
}

async function getInjuryDataForTeam(teamName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];
  if (!bbLeagueKey || !BIGBALLS_KEY) return { count: 0, details: [] };
  const cacheKey = `injuries:${bbLeagueKey}:${teamName}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const [teams, injuries] = await Promise.all([
      getBigBallsTeams(bbLeagueKey),
      getBigBallsInjuries(bbLeagueKey)
    ]);
    const matchedTeam = teams.find(t => namesMatch(t?.name, teamName));
    if (!matchedTeam?.id) return { count: 0, details: [] };
    const teamInjuries = injuries.filter(inj => inj?.current_team_id === matchedTeam.id);
    const result = {
      count: teamInjuries.length,
      details: teamInjuries.map(i => ({
        player: i?.player_name || i?.name || 'Jugador',
        position: (i?.position || i?.role || '').toLowerCase(),
        status: i?.status || 'Baja'
      }))
    };
    cacheSet(cacheKey, result, 'injuries');
    return result;
  } catch (error) {
    return { count: 0, details: [] };
  }
}

/* =========================================================
   2. C\u00c1LCULO DE LESIONES PONDERADO POR IMPORTANCIA (V8.0)
   - Portero titular: afecta defensa (+vulnerabilidad)
   - Delanteros / goleadores: afecta ataque
   - Defensas / medios: impacto repartido
   - Impacto m\u00e1ximo global acotado al 8% (clamp 0.92 .. 1.0)
========================================================= */
async function applyInjuryAdjustment(homeStats, awayStats, homeName, awayName, competitionCode) {
  try {
    const [homeData, awayData] = await Promise.all([
      getInjuryDataForTeam(homeName, competitionCode),
      getInjuryDataForTeam(awayName, competitionCode)
    ]);

    function computeTeamInjuryFactor(data) {
      if (!data || !data.count) return { attackFactor: 1.0, defenseFactor: 1.0, count: 0 };
      let attackPenalty = 0;
      let defensePenalty = 0;

      for (const item of (data.details || [])) {
        const pos = item.position;
        if (pos.includes('goalkeeper') || pos.includes('portero') || pos.includes('gk')) {
          defensePenalty += 0.035; // Portero: vulnerabilidad defensiva
        } else if (pos.includes('forward') || pos.includes('delantero') || pos.includes('striker') || pos.includes('att')) {
          attackPenalty += 0.03;   // Delantero
        } else if (pos.includes('defen') || pos.includes('cb') || pos.includes('lb') || pos.includes('rb')) {
          defensePenalty += 0.02;  // Defensa
        } else {
          attackPenalty += 0.015;
          defensePenalty += 0.015;
        }
      }

      // Si no tenemos desglose por posici\u00f3n, aplicar estimaci\u00f3n suave de 0.015 por baja
      if (!data.details || !data.details.length) {
        attackPenalty = data.count * 0.018;
        defensePenalty = data.count * 0.018;
      }

      // Acotamos el impacto m\u00e1ximo a un 8% (0.92) para evitar sobreajuste destructivo
      const attackFactor = clamp(1 - attackPenalty, 0.92, 1.0);
      const defenseFactor = clamp(1 - defensePenalty, 0.92, 1.0);

      return { attackFactor, defenseFactor, count: data.count };
    }

    const homeAdj = computeTeamInjuryFactor(homeData);
    const awayAdj = computeTeamInjuryFactor(awayData);

    return {
      homeStats: {
        ...homeStats,
        attackStrength: homeStats.attackStrength * homeAdj.attackFactor,
        defenseStrength: homeStats.defenseStrength * homeAdj.defenseFactor
      },
      awayStats: {
        ...awayStats,
        attackStrength: awayStats.attackStrength * awayAdj.attackFactor,
        defenseStrength: awayStats.defenseStrength * awayAdj.defenseFactor
      },
      homeInjuries: homeAdj.count,
      awayInjuries: awayAdj.count
    };
  } catch (error) {
    return { homeStats, awayStats, homeInjuries: 0, awayInjuries: 0 };
  }
}

/* =========================================================
   3. DESCANSO Y FATIGA ASIM\u00c9TRICA Y SUAVE (V8.0)
   - Fatiga defensiva (desajuste t\u00e1ctico/repliegue) > fatiga ofensiva
   - Curva continua y acotada, sin saltos binarios irreales
========================================================= */
function calculateRestDaysFromMatches(matches, matchUtcDate) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const targetTime = matchUtcDate ? new Date(matchUtcDate).getTime() : Date.now();

  const pastMatches = matches
    .filter(m => m.utcDate && new Date(m.utcDate).getTime() < targetTime)
    .sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime());

  if (!pastMatches.length) return null;

  const lastMatchTime = new Date(pastMatches[0].utcDate).getTime();
  const diffDays = Math.max(0, Math.floor((targetTime - lastMatchTime) / (1000 * 60 * 60 * 24)));
  return diffDays;
}

function getRestFatigaImpact(restDays) {
  if (restDays == null) {
    return { attackFactor: 1.0, defenseFactor: 1.0, label: 'Sin datos', impactPct: 0 };
  }
  // \u22642 d\u00edas: fatiga severa (defensa sufre m\u00e1s: -4.5%, ataque pierde frescura: -3.5%)
  if (restDays <= 2) {
    return { attackFactor: 0.965, defenseFactor: 0.955, label: 'Fatiga severa (\u22642 d\u00edas)', impactPct: -4 };
  }
  // 3 d\u00edas: descanso ajustado
  if (restDays === 3) {
    return { attackFactor: 0.98, defenseFactor: 0.975, label: 'Descanso justo (3 d\u00edas)', impactPct: -2.5 };
  }
  // 4 d\u00edas: ritmo competitivo casi pleno
  if (restDays === 4) {
    return { attackFactor: 0.99, defenseFactor: 0.99, label: 'Descanso adecuado (4 d\u00edas)', impactPct: -1 };
  }
  // 5 a 12 d\u00edas: \u00f3ptimo
  if (restDays >= 5 && restDays <= 12) {
    return { attackFactor: 1.0, defenseFactor: 1.0, label: `\u00d3ptimo (${restDays}d)`, impactPct: 0 };
  }
  // > 12 d\u00edas: leve falta de ritmo competitivo
  return { attackFactor: 0.985, defenseFactor: 0.99, label: `Inactividad prolongada (${restDays}d)`, impactPct: -1.5 };
}

function applyCalculatedRestAdjustment(homeStats, awayStats, homeRestDays, awayRestDays) {
  const homeImpact = getRestFatigaImpact(homeRestDays);
  const awayImpact = getRestFatigaImpact(awayRestDays);

  return {
    homeStats: {
      ...homeStats,
      attackStrength: clamp(homeStats.attackStrength * homeImpact.attackFactor, 0.45, 1.8),
      defenseStrength: clamp(homeStats.defenseStrength * homeImpact.defenseFactor, 0.45, 1.8)
    },
    awayStats: {
      ...awayStats,
      attackStrength: clamp(awayStats.attackStrength * awayImpact.attackFactor, 0.45, 1.8),
      defenseStrength: clamp(awayStats.defenseStrength * awayImpact.defenseFactor, 0.45, 1.8)
    },
    homeRest: { days: homeRestDays, status: homeImpact.label, impactPct: homeImpact.impactPct },
    awayRest: { days: awayRestDays, status: awayImpact.label, impactPct: awayImpact.impactPct }
  };
}

/* =========================================================
   4. PREDICCIONES BIG BALLS - SEGUNDA OPINI\u00d3N PURAMENTE EXTERNA
   Ya no modifica el score de confianza ni la probabilidad del modelo.
========================================================= */
async function getBigBallsPrediction(homeName, awayName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];
  if (!bbLeagueKey || !BIGBALLS_KEY) return null;
  const cacheKey = `bb-pred:${bbLeagueKey}:${homeName}:${awayName}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const data = await bigBallsRequest(`/v1/predictions?sport=football&league=${bbLeagueKey}`);
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.predictions) ? data.predictions : []);
    if (!list.length) return null;

    const matched = list.find(p => {
      const h = p?.home_team || p?.home_team_name || p?.home;
      const a = p?.away_team || p?.away_team_name || p?.away;
      return namesMatch(h, homeName) && namesMatch(a, awayName);
    });

    if (!matched) return null;

    const hp = Number(matched.home_win_probability ?? matched.home_prob ?? matched.home_win ?? 0);
    const dp = Number(matched.draw_probability ?? matched.draw_prob ?? matched.draw ?? 0);
    const ap = Number(matched.away_win_probability ?? matched.away_prob ?? matched.away_win ?? 0);

    const winner = matched.predicted_winner || matched.pick ||
      (hp > ap && hp > dp ? 'home' : (ap > hp && ap > dp ? 'away' : 'draw'));

    const result = {
      homeProb: Math.round(hp <= 1 ? hp * 100 : hp),
      drawProb: Math.round(dp <= 1 ? dp * 100 : dp),
      awayProb: Math.round(ap <= 1 ? ap * 100 : ap),
      predictedWinner: winner
    };
    cacheSet(cacheKey, result, 'analysis');
    return result;
  } catch (err) {
    console.warn('[BIGBALLS PREDICTIONS]', err.message);
    return null;
  }
}

function evaluateSecondOpinion(model, bbPred) {
  if (!bbPred) return null;

  const mkWinner = (model.homeWin > model.awayWin && model.homeWin > model.draw)
    ? 'home'
    : ((model.awayWin > model.homeWin && model.awayWin > model.draw) ? 'away' : 'draw');

  const mkProbMap = { home: model.homeWin, draw: model.draw, away: model.awayWin };
  const bbProbMap = { home: bbPred.homeProb, draw: bbPred.drawProb, away: bbPred.awayProb };

  const agreement = mkWinner === bbPred.predictedWinner;
  const labels = { home: 'Local', draw: 'Empate', away: 'Visitante' };

  const mkProbPct = Math.round((mkProbMap[mkWinner] || 0) * 100);
  const bbProbPct = bbProbMap[bbPred.predictedWinner] || 0;
  const diffPts = bbProbPct - mkProbPct;

  return {
    available: true,
    agrees: agreement,
    status: agreement ? 'Coincidencia con 2\u00aa opini\u00f3n' : 'Divergencia (Alerta externa)',
    mkPick: labels[mkWinner],
    mkProb: mkProbPct,
    bbPick: labels[bbPred.predictedWinner] || 'Otro resultado',
    bbProb: bbProbPct,
    diffPts: diffPts > 0 ? `+${diffPts}` : `${diffPts}`,
    confidenceDelta: 0, // V8: \u00a10% de contaminaci\u00f3n al modelo propio!
    message: agreement
      ? `Segunda opini\u00f3n externa coincide en ${labels[mkWinner]} (${bbProbPct}%).`
      : `Segunda opini\u00f3n externa proyecta ${labels[bbPred.predictedWinner] || 'opuesto'} (${bbProbPct}%). Discrepancia entre fuentes.`
  };
}

/* =========================================================
   HISTORIAL H2H
========================================================= */
async function getBigBallsTeamId(teamName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];
  if (!bbLeagueKey || !BIGBALLS_KEY) return null;
  try {
    const teams = await getBigBallsTeams(bbLeagueKey);
    const matchedTeam = teams.find(t => namesMatch(t?.name, teamName));
    return matchedTeam?.id || null;
  } catch (error) {
    return null;
  }
}

async function getH2HDrawRate(homeTeamId, awayTeamId) {
  if (!homeTeamId || !awayTeamId || !BIGBALLS_KEY) return null;
  try {
    const data = await bigBallsRequest(`/v1/teams/${homeTeamId}/h2h-intelligence?opponent=${awayTeamId}`);
    const context = data?.data || data;
    const draws = Number(context?.draws ?? context?.draw_count);
    const totalMatches = Number(context?.matches ?? context?.total_matches ?? context?.games_played);
    if (Number.isFinite(draws) && Number.isFinite(totalMatches) && totalMatches >= 3) {
      return draws / totalMatches;
    }
    return null;
  } catch (error) {
    return null;
  }
}

function applyH2HAdjustment(model, h2hDrawRate) {
  if (h2hDrawRate == null || !Number.isFinite(h2hDrawRate)) return model;
  const bump = clamp((h2hDrawRate - model.draw) * 0.3, 0, 0.03);
  if (bump <= 0) return model;
  const totalOthers = model.homeWin + model.awayWin;
  if (totalOthers <= 0) return model;
  const homeShare = model.homeWin / totalOthers;
  const awayShare = model.awayWin / totalOthers;
  return {
    ...model,
    draw: model.draw + bump,
    homeWin: model.homeWin - bump * homeShare,
    awayWin: model.awayWin - bump * awayShare
  };
}

function median(values) {
  const nums = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!nums.length) return null;
  const m = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2;
}

function uniqueNumbers(values) {
  return [...new Set(values.map(Number).filter(Number.isFinite).map(v => Number(v.toFixed(4))))];
}

function dateFromISO(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function datePartUTC(value) {
  const d = dateFromISO(value);
  return d ? d.toISOString().slice(0, 10) : null;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* =========================================================
   FOOTBALL DATA
========================================================= */
async function footballData(path) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error('FOOTBALL_DATA_TOKEN no configurado');
  }
  const key = `football:${path}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await fetchJson(`${FOOTBALL_DATA_BASE}${path}`, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN }
  });
  return cacheSet(key, data);
}

async function getCompetitionTeams(competitionCode) {
  const key = `competition-teams:${competitionCode}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const data = await footballData(`/competitions/${competitionCode}/teams`);
    const teams = Array.isArray(data?.teams) ? data.teams : [];
    return cacheSetIfNotEmpty(key, teams);
  } catch (error) {
    return [];
  }
}

async function findTeam(teamName, competitionCode) {
  if (!teamName || !competitionCode) return null;
  const teams = await getCompetitionTeams(competitionCode);
  if (!teams.length) return null;
  const target = normalizeName(teamName);
  const exact = teams.find(t => normalizeName(t?.name) === target);
  if (exact) return exact;
  const partial = teams.find(t => namesMatch(t?.name, teamName));
  return partial || null;
}

async function getTeamRecentMatches(teamId) {
  if (!teamId) return [];
  const key = `team:${teamId}:recent`;
  const cached = cacheGet(key);
  if (cached) return cached;
  try {
    const data = await footballData(`/teams/${teamId}/matches?status=FINISHED&limit=20`);
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    return cacheSetIfNotEmpty(key, matches);
  } catch (error) {
    return [];
  }
}

function calculateRecentTeamStats(teamId, matches) {
  const relevant = matches
    .filter(m => m?.homeTeam?.id === teamId || m?.awayTeam?.id === teamId)
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 10);

  if (!relevant.length) {
    return {
      matches: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      avgGoalsFor: 1.25,
      avgGoalsAgainst: 1.25,
      attackStrength: 1,
      defenseStrength: 1,
      formPoints: 0,
      formPct: 50
    };
  }

  const n = relevant.length;
  let weightedGF = 0, weightedGA = 0, weightedPts = 0, totalW = 0;
  let gf = 0, ga = 0, pts = 0;

  relevant.forEach((m, idx) => {
    const w = n - idx;
    totalW += w;
    const h = Number(m?.score?.fullTime?.home ?? 0);
    const a = Number(m?.score?.fullTime?.away ?? 0);
    const isHome = m?.homeTeam?.id === teamId;
    const gFor = isHome ? h : a;
    const gAg = isHome ? a : h;

    gf += gFor;
    ga += gAg;
    weightedGF += gFor * w;
    weightedGA += gAg * w;

    if (gFor > gAg) { pts += 3; weightedPts += 3 * w; }
    else if (gFor === gAg) { pts += 1; weightedPts += 1 * w; }
  });

  const avgGoalsFor = weightedGF / totalW;
  const avgGoalsAgainst = weightedGA / totalW;

  return {
    matches: relevant.length,
    goalsFor: gf,
    goalsAgainst: ga,
    avgGoalsFor,
    avgGoalsAgainst,
    attackStrength: clamp(avgGoalsFor / 1.35, 0.45, 1.8),
    defenseStrength: clamp(1.35 / Math.max(avgGoalsAgainst, 0.25), 0.45, 1.8),
    formPoints: pts,
    formPct: (weightedPts / (totalW * 3)) * 100
  };
}

async function getFixturesFootballData(date, competitionFilter) {
  try {
    const path = competitionFilter && COMPETITIONS.includes(competitionFilter)
      ? `/competitions/${competitionFilter}/matches?dateFrom=${date}&dateTo=${date}`
      : `/matches?dateFrom=${date}&dateTo=${date}`;

    const data = await footballData(path);
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    const filtered = competitionFilter
      ? matches
      : matches.filter(m => ODDS_SPORT_BY_COMPETITION[m?.competition?.code]);

    return filtered.map(m => ({
      ...m,
      competitionCode: m?.competition?.code || null,
      competitionName: m?.competition?.name || m?.competition?.code || null,
      source: 'football-data'
    }));
  } catch (error) {
    return [];
  }
}

/* =========================================================
   ODDS API
========================================================= */
async function getOddsEvents(competitionCode) {
  if (!ODDS_API_KEY) return [];
  const sport = ODDS_SPORT_BY_COMPETITION[competitionCode];
  if (!sport) return [];

  const key = `odds-events:${sport}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const url = `${ODDS_BASE}/sports/${sport}/odds?regions=us,uk,eu&markets=h2h,totals&oddsFormat=decimal&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;
    const data = await fetchJson(url);
    const events = Array.isArray(data) ? data : [];
    return cacheSetIfNotEmpty(key, events);
  } catch (error) {
    return [];
  }
}

async function getFixturesOdds(date, competitionFilter) {
  if (!ODDS_API_KEY) return [];
  const all = [];
  const comps = competitionFilter && COMPETITIONS.includes(competitionFilter) ? [competitionFilter] : COMPETITIONS;

  for (const c of comps) {
    const events = await getOddsEvents(c);
    for (const e of events) {
      if (!e?.home_team || !e?.away_team || !e?.commence_time) continue;
      if (datePartUTC(e.commence_time) !== date) continue;

      all.push({
        id: `odds-${e.id || normalizeName(e.home_team + '-' + e.away_team)}`,
        homeTeam: { id: null, name: e.home_team, crest: null },
        awayTeam: { id: null, name: e.away_team, crest: null },
        utcDate: e.commence_time,
        competition: { code: c, name: competitionName(c) },
        competitionCode: c,
        competitionName: competitionName(c),
        status: 'SCHEDULED',
        source: 'the-odds-api',
        oddsEvent: e
      });
    }
  }
  return all;
}

function competitionName(code) {
  const names = {
    PL: 'Premier League',
    PD: 'LaLiga',
    BL1: 'Bundesliga',
    SA: 'Serie A',
    FL1: 'Ligue 1',
    CL: 'Champions League',
    EL: 'Europa League'
  };
  return names[code] || code;
}

async function getFixture(date, competitionFilter) {
  const key = `fixtures:${date}:${competitionFilter || 'ALL'}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  let matches = await getFixturesFootballData(date, competitionFilter);
  if (competitionFilter) {
    matches = matches.filter(m => (m.competitionCode || m.competition?.code) === competitionFilter);
  }

  if (!matches.length) {
    matches = await getFixturesOdds(date, competitionFilter);
  }

  matches = Array.isArray(matches) ? matches : [];
  matches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));

  if (matches.length > 0) cacheSet(key, matches);
  return matches;
}

function findOddsEvent(events, homeName, awayName) {
  if (!Array.isArray(events)) return null;
  const direct = events.find(e => namesMatch(e?.home_team, homeName) && namesMatch(e?.away_team, awayName));
  if (direct) return { event: direct, reversed: false };
  const rev = events.find(e => namesMatch(e?.home_team, awayName) && namesMatch(e?.away_team, homeName));
  if (rev) return { event: rev, reversed: true };
  return null;
}

async function getOdds(homeName, awayName, competitionCode) {
  if (!ODDS_API_KEY) return { available: false, reason: 'ODDS_API_KEY no configurada' };
  const sport = ODDS_SPORT_BY_COMPETITION[competitionCode];
  if (!sport) return { available: false, reason: 'Competici\u00f3n no soportada' };

  const events = await getOddsEvents(competitionCode);
  const found = findOddsEvent(events, homeName, awayName);
  if (!found?.event) return { available: false, reason: 'Partido no encontrado en The Odds API' };

  return {
    available: true,
    eventId: found.event.id || null,
    commenceTime: found.event.commence_time || null,
    bookmakers: Array.isArray(found.event.bookmakers) ? found.event.bookmakers : [],
    event: found.event,
    reversed: Boolean(found.reversed)
  };
}

function collectPrices(bookmakers, homeName, awayName, reversed = false) {
  const result = { home: [], draw: [], away: [], over25: [], under25: [] };

  for (const b of bookmakers || []) {
    const bName = b?.title || b?.key || 'Unknown';
    for (const m of b?.markets || []) {
      if (m?.key === 'h2h') {
        for (const o of m.outcomes || []) {
          const price = Number(o?.price);
          if (!Number.isFinite(price) || price <= 1) continue;
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
      if (m?.key === 'totals') {
        for (const o of m.outcomes || []) {
          if (Number(o?.point) !== 2.5) continue;
          const price = Number(o?.price);
          if (!Number.isFinite(price) || price <= 1) continue;
          const n = normalizeName(o?.name);
          if (n === 'over') result.over25.push({ bookmaker: bName, odds: price });
          if (n === 'under') result.under25.push({ bookmaker: bName, odds: price });
        }
      }
    }
  }
  return result;
}

function analyzePriceSet(prices) {
  const valid = prices
    .filter(item => Number.isFinite(Number(item?.odds)) && Number(item.odds) > 1)
    .map(item => ({ bookmaker: item.bookmaker, odds: Number(item.odds) }));

  if (!valid.length) {
    return {
      bestOdds: null,
      referenceOdds: null,
      secondBestOdds: null,
      bookmakerCount: 0,
      supportCount: 0,
      isOutlier: false,
      marketDepth: 'none',
      prices: []
    };
  }

  const odds = valid.map(x => x.odds).sort((a, b) => a - b);
  const referenceOdds = median(odds);
  const bestOdds = odds[odds.length - 1];
  const unique = uniqueNumbers(odds).sort((a, b) => b - a);
  const secondBestOdds = unique.length > 1 ? unique[1] : null;

  const supportCount = odds.filter(val =>
    referenceOdds && Math.abs(val - referenceOdds) / referenceOdds <= 0.10
  ).length;

  const isOutlier = odds.length >= 2 && (
    bestOdds > referenceOdds * 1.30 ||
    (bestOdds > referenceOdds * 1.20 && supportCount < 2) ||
    (secondBestOdds !== null && bestOdds > secondBestOdds * 1.20)
  );

  let marketDepth = 'low';
  if (odds.length >= 6 && supportCount >= 4) marketDepth = 'strong';
  else if (odds.length >= 3 && supportCount >= 2) marketDepth = 'medium';

  return {
    bestOdds,
    referenceOdds,
    secondBestOdds,
    bookmakerCount: valid.length,
    supportCount,
    isOutlier,
    marketDepth,
    prices: valid
  };
}

function marketName(type, outcome) {
  if (type === 'h2h') {
    if (outcome === 'home') return 'Gana local';
    if (outcome === 'draw') return 'Empate';
    return 'Gana visitante';
  }
  return outcome === 'over' ? 'Over 2.5' : 'Under 2.5';
}

function buildMarket(type, outcome, probability, prices) {
  const info = analyzePriceSet(prices);
  const modelProbability = Number(probability);
  const bestEvPct = info.bestOdds ? ev(modelProbability, info.bestOdds) : null;
  const referenceEvPct = info.referenceOdds ? ev(modelProbability, info.referenceOdds) : null;

  const valueEligible =
    info.bookmakerCount >= 2 &&
    info.supportCount >= 2 &&
    !info.isOutlier &&
    Number.isFinite(referenceEvPct) &&
    referenceEvPct > 0;

  let valueLevel = 'Sin valor';
  if (info.isOutlier) valueLevel = 'Precio at\u00edpico';
  else if (referenceEvPct >= 10) valueLevel = 'Valor fuerte';
  else if (referenceEvPct >= 5) valueLevel = 'Valor';
  else if (referenceEvPct > 0) valueLevel = 'Valor leve';

  const bestBookmaker = info.prices.find(item => item.odds === info.bestOdds)?.bookmaker || null;
  const preferredBookmakerPrice = info.prices.find(item => /caliente/i.test(item.bookmaker || '')) || null;

  let suggestedStakeEur = STAKE_EUR;
  if (info.bestOdds && info.bestOdds > 1) {
    const b = info.bestOdds - 1;
    const p = modelProbability;
    const q = 1 - p;
    const kelly = (b * p - q) / b;
    const used = Math.max(0, kelly) * 0.25;
    suggestedStakeEur = Number(clamp(STAKE_EUR * (1 + used * 10), STAKE_EUR * 0.5, STAKE_EUR * 3).toFixed(2));
  }

  return {
    type,
    outcome,
    name: marketName(type, outcome),
    probability: Number((modelProbability * 100).toFixed(1)),
    bestOdds: info.bestOdds,
    referenceOdds: info.referenceOdds,
    secondBestOdds: info.secondBestOdds,
    impliedProbability: info.bestOdds ? implied(info.bestOdds) : null,
    evPct: bestEvPct,
    bestEvPct,
    referenceEvPct,
    bookmaker: bestBookmaker,
    preferredBookmakerOdds: preferredBookmakerPrice?.odds || null,
    suggestedStakeEur,
    bookmakerCount: info.bookmakerCount,
    supportCount: info.supportCount,
    isOutlier: info.isOutlier,
    marketDepth: info.marketDepth,
    valueEligible,
    valueLevel
  };
}

function buildMarkets(model, oddsData, homeName, awayName) {
  if (!oddsData?.available) return [];
  const prices = collectPrices(oddsData.bookmakers, homeName, awayName, oddsData.reversed);

  return [
    buildMarket('h2h', 'home', model.homeWin, prices.home),
    buildMarket('h2h', 'draw', model.draw, prices.draw),
    buildMarket('h2h', 'away', model.awayWin, prices.away),
    buildMarket('totals', 'over', model.over25, prices.over25),
    buildMarket('totals', 'under', model.under25, prices.under25)
  ];
}

function bestValue(markets, modelConfidence) {
  return markets
    .filter(m =>
      m.valueEligible &&
      m.bookmakerCount >= 2 &&
      m.supportCount >= 2 &&
      !m.isOutlier &&
      Number(m.probability) >= 45 &&
      Number(m.referenceEvPct) >= 1 &&
      Number(modelConfidence) >= 45
    )
    .sort((a, b) => Number(b.referenceEvPct) - Number(a.referenceEvPct))[0] || null;
}

function mostLikelyScore(homeXg, awayXg) {
  let best = { home: 0, away: 0, probability: 0 };
  function p(k, l) {
    let f = 1; for (let i = 2; i <= k; i++) f *= i;
    return (Math.exp(-l) * Math.pow(l, k)) / f;
  }
  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const prob = p(h, Math.max(0.01, Number(homeXg))) * p(a, Math.max(0.01, Number(awayXg)));
      if (prob > best.probability) best = { home: h, away: a, probability: prob };
    }
  }
  return { score: `${best.home}-${best.away}`, probability: Number((best.probability * 100).toFixed(1)) };
}

/* =========================================================
   2. MODELO CON VENTAJA DE LOCAL AJUSTADA POR LIGA
========================================================= */
function createModelInput(homeStats, awayStats, competitionCode) {
  const homeAttack = homeStats.avgGoalsFor * clamp(homeStats.attackStrength, 0.75, 1.35);
  const awayAttack = awayStats.avgGoalsFor * clamp(awayStats.attackStrength, 0.75, 1.35);

  const homeAdvantage = getHomeAdvantage(competitionCode);
  const homeXg = ((homeAttack + awayStats.avgGoalsAgainst) / 2) * homeAdvantage;
  const awayXg = (awayAttack + homeStats.avgGoalsAgainst) / 2;

  return {
    homeXg: clamp(homeXg, 0.25, 3.8),
    awayXg: clamp(awayXg, 0.20, 3.5),
    homeAdvantage
  };
}

/* =========================================================
   ENDPOINTS & API
========================================================= */

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    footballDataConfigured: Boolean(FOOTBALL_DATA_TOKEN),
    oddsApiConfigured: Boolean(ODDS_API_KEY),
    databaseConfigured: Boolean(DATABASE_URL && Pool),
    bigBallsConfigured: Boolean(BIGBALLS_KEY),
    stakeEur: STAKE_EUR,
    provider: 'football-data.org + The Odds API + Big Balls',
    cacheMinutes: CACHE_MINUTES,
    modelVersion: MODEL_VERSION
  });
});

// Descargar el archivo server.js actualizado
app.get('/api/download-server', (req, res) => {
  const possiblePaths = [
    path.join(__dirname, 'server.js'),
    path.join(__dirname, 'public', 'server.js'),
    path.join(process.cwd(), 'server.js'),
    path.join(process.cwd(), 'public', 'server.js')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return res.download(p, 'server.js');
    }
  }
  res.status(404).send('server.js no encontrado.');
});

// Descargar el archivo zip del proyecto completo
app.get('/api/download-zip', (req, res) => {
  const possiblePaths = [
    path.join(__dirname, 'public', 'mi-pronostico-deportivo-v7.17.zip'),
    path.join(__dirname, 'mi-pronostico-deportivo-v7.17.zip'),
    path.join(process.cwd(), 'public', 'mi-pronostico-deportivo-v7.17.zip'),
    path.join(process.cwd(), 'mi-pronostico-deportivo-v7.17.zip')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return res.download(p, 'mi-pronostico-deportivo-v7.17.zip');
    }
  }
  res.status(404).send('ZIP no encontrado.');
});

function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

app.get('/api/fixtures/favorites', async (req, res) => {
  const teams = String(req.query.teams || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .slice(0, 5);

  if (!teams.length) return res.json({ ok: true, fixtures: [] });

  const todayStr = new Date().toISOString().slice(0, 10);
  const cacheKey = `favorites-fixtures:${teams.join('|')}:${todayStr}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Football-Data rechaza periodos superiores a 10 d\u00edas:
    // "Specified period must not exceed 10 days" (HTTP 400).
    // Consultamos en 2 bloques seguros de 7 d\u00edas: [0..7] y [8..14]
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

    const seenIds = new Set();
    const uniqueMatches = [];
    for (const m of allMatches) {
      const matchId = m?.id || `${m?.homeTeam?.name}-${m?.awayTeam?.name}-${m?.utcDate}`;
      if (!seenIds.has(matchId)) {
        seenIds.add(matchId);
        uniqueMatches.push(m);
      }
    }

    const filtered = uniqueMatches.filter(m =>
      teams.some(t => namesMatch(m?.homeTeam?.name, t) || namesMatch(m?.awayTeam?.name, t))
    );

    const fixtures = filtered.map(m => ({
      id: m.id,
      home: m.homeTeam?.name || null,
      away: m.awayTeam?.name || null,
      homeCrest: m.homeTeam?.crest || null,
      awayCrest: m.awayTeam?.crest || null,
      kickoff: m.utcDate || null,
      competition: m.competition?.name || m.competition?.code || null
    })).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));

    const result = { ok: true, fixtures };
    cacheSet(cacheKey, result, 'fixtures');
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/fixtures/next', async (req, res) => {
  const comp = String(req.query.competition || '').trim().toUpperCase();
  if (!comp) {
    return res.status(400).json({ ok: false, error: 'Debes indicar una liga espec\u00edfica.' });
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const cacheKey = `next-fixture:${comp}:${todayStr}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    let foundDate = null;
    let foundCount = 0;

    for (let offset = 0; offset < 45 && !foundDate; offset += 10) {
      const from = addDaysToDateStr(todayStr, offset);
      const to = addDaysToDateStr(todayStr, Math.min(offset + 9, 44));
      const data = await footballData(`/competitions/${comp}/matches?dateFrom=${from}&dateTo=${to}`);
      const matches = Array.isArray(data?.matches) ? data.matches : [];

      if (matches.length) {
        matches.sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate));
        foundDate = matches[0].utcDate.slice(0, 10);
        foundCount = matches.filter(m => m.utcDate.slice(0, 10) === foundDate).length;
      }
    }

    const result = foundDate
      ? { ok: true, found: true, date: foundDate, count: foundCount }
      : { ok: true, found: false, message: 'No se encontraron partidos pr\u00f3ximos en 45 d\u00edas.' };

    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/fixtures', async (req, res) => {
  const date = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);
  const comp = String(req.query.competition || '').trim().toUpperCase();

  try {
    const matches = await getFixture(date, comp);
    const fixtures = matches
      .filter(m => m?.homeTeam?.name && m?.awayTeam?.name)
      .map(m => ({
        id: m.id || null,
        home: m.homeTeam.name,
        homeCrest: m.homeTeam?.crest || null,
        away: m.awayTeam.name,
        awayCrest: m.awayTeam?.crest || null,
        kickoff: m.utcDate || null,
        competition: m.competitionName || m.competition?.name || m.competitionCode || null,
        competitionCode: m.competitionCode || m.competition?.code || null,
        status: m.status || 'SCHEDULED',
        source: m.source || 'football-data'
      }));

    const fetchedAt = cacheGetTimestamp(`fixtures:${date}:${comp || 'ALL'}`) || Date.now();
    return res.json({
      ok: true,
      modelVersion: MODEL_VERSION,
      date,
      count: fixtures.length,
      fetchedAt,
      fixtures
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message, modelVersion: MODEL_VERSION });
  }
});

/* =========================================================
   AN\u00c1LISIS DE UN PARTIDO (con Descanso Propio + Home Advantage + Big Balls)
========================================================= */
async function analyzeOneFixture(fixture) {
  const homeName = fixture.homeTeam?.name;
  const awayName = fixture.awayTeam?.name;
  if (!homeName || !awayName) return null;

  const compCode = fixture.competitionCode || fixture.competition?.code || null;
  let homeTeamObj = fixture.homeTeam?.id ? fixture.homeTeam : null;
  let awayTeamObj = fixture.awayTeam?.id ? fixture.awayTeam : null;

  if ((!homeTeamObj?.id || !awayTeamObj?.id) && compCode) {
    const [hObj, aObj] = await Promise.all([
      findTeam(homeName, compCode),
      findTeam(awayName, compCode)
    ]);
    if (hObj) homeTeamObj = hObj;
    if (aObj) awayTeamObj = aObj;
  }

  const homeId = homeTeamObj?.id || null;
  const awayId = awayTeamObj?.id || null;
  if (!homeId || !awayId) return null;

  const [homeMatches, awayMatches] = await Promise.all([
    getTeamRecentMatches(homeId),
    getTeamRecentMatches(awayId)
  ]);

  let homeStats = calculateRecentTeamStats(homeId, homeMatches);
  let awayStats = calculateRecentTeamStats(awayId, awayMatches);

  // Estabilizaci\u00f3n
  const attackBase = 1.35;
  const defBase = 1.20;
  const hGF = shrinkToMean(homeStats.avgGoalsFor, attackBase, homeStats.matches);
  const hGA = shrinkToMean(homeStats.avgGoalsAgainst, defBase, homeStats.matches);
  const aGF = shrinkToMean(awayStats.avgGoalsFor, attackBase, awayStats.matches);
  const aGA = shrinkToMean(awayStats.avgGoalsAgainst, defBase, awayStats.matches);

  homeStats = {
    ...homeStats,
    avgGoalsFor: hGF,
    avgGoalsAgainst: hGA,
    attackStrength: clamp(hGF / attackBase, 0.45, 1.8),
    defenseStrength: clamp(attackBase / Math.max(hGA, 0.25), 0.45, 1.8)
  };
  awayStats = {
    ...awayStats,
    avgGoalsFor: aGF,
    avgGoalsAgainst: aGA,
    attackStrength: clamp(aGF / attackBase, 0.45, 1.8),
    defenseStrength: clamp(attackBase / Math.max(aGA, 0.25), 0.45, 1.8)
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

  // 2. Modelo con Ventaja de Local ajustada por Liga
  const modelInput = createModelInput(homeStats, awayStats, compCode);
  let model = matchModel(modelInput.homeXg, modelInput.awayXg);

  // H2H Hist\u00f3rico
  const [bbHomeTeamId, bbAwayTeamId] = await Promise.all([
    getBigBallsTeamId(homeName, compCode),
    getBigBallsTeamId(awayName, compCode)
  ]);
  const h2hDrawRate = await getH2HDrawRate(bbHomeTeamId, bbAwayTeamId);
  model = applyH2HAdjustment(model, h2hDrawRate);

  // 3. Predicci\u00f3n Big Balls (Segunda Opini\u00f3n)
  const bbPred = await getBigBallsPrediction(homeName, awayName, compCode);
  const bbComparison = evaluateSecondOpinion(model, bbPred);

  // Confianza propia matem\u00e1tica pura (sin adulteraci\u00f3n externa)
  let modelConf = 50;
  try {
    const bestP = Math.max(model.homeWin, model.draw, model.awayWin);
    const n = Math.min(homeStats.matches, awayStats.matches);
    modelConf = confidence(bestP, n);
  } catch (e) {
    modelConf = 50;
  }

  const confidenceAdjusted = clamp(Math.round(modelConf), 20, 95);

  // Aprendizaje emp\u00edrico de ventaja de local de la liga
  updateLearnedHomeAdvantage(compCode, (homeMatches || []).concat(awayMatches || []));

  const odds = await getOdds(homeName, awayName, compCode);
  const markets = buildMarkets(model, odds, homeName, awayName);

  return {
    home: homeName,
    homeCrest: homeTeamObj?.crest || fixture.homeCrest || null,
    away: awayName,
    awayCrest: awayTeamObj?.crest || fixture.awayCrest || null,
    date: fixture.utcDate ? datePartUTC(fixture.utcDate) : null,
    kickoff: fixture.utcDate || null,
    competition: fixture.competitionName || fixture.competition?.name || compCode,
    competitionCode: compCode,
    confidence: confidenceAdjusted,
    homeAdvantage: modelInput.homeAdvantage,
    rest: { home: restAdj.homeRest, away: restAdj.awayRest },
    injuries: { home: injuryAdj.homeInjuries, away: injuryAdj.awayInjuries },
    bigBallsComparison: bbComparison,
    markets,
    oddsAvailable: Boolean(odds?.available)
  };
}

function pickParlayCandidate(analysis) {
  if (!analysis || !analysis.oddsAvailable) return null;
  const candidates = [];

  for (const m of analysis.markets) {
    if (!m.bestOdds) continue;
    const isStrong = m.valueEligible && Number(m.referenceEvPct) >= 1.5 && analysis.confidence >= 45;
    const isOddsError = m.isOutlier && m.referenceOdds && m.bestOdds > m.referenceOdds * 1.10 && Number(m.probability) >= 35;

    if (isStrong || isOddsError) {
      candidates.push({
        home: analysis.home,
        homeCrest: analysis.homeCrest,
        away: analysis.away,
        awayCrest: analysis.awayCrest,
        competition: analysis.competition,
        date: analysis.date,
        kickoff: analysis.kickoff,
        market: m.type,
        outcome: m.outcome,
        marketName: m.name,
        odds: m.bestOdds,
        probability: m.probability,
        referenceEvPct: m.referenceEvPct,
        confidence: analysis.confidence,
        tag: isOddsError ? 'Posible error de cuota' : 'Pick fuerte'
      });
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => Number(b.referenceEvPct || 0) - Number(a.referenceEvPct || 0));
  return candidates[0];
}

app.get('/api/parlay', async (req, res) => {
  try {
    const date = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);
    const maxLegs = Math.min(6, Math.max(2, Number(req.query.legs) || 4));
    const comp = String(req.query.competition || '').trim().toUpperCase();

    const fixtures = await getFixture(date, comp);
    const withNames = fixtures.filter(m => m?.homeTeam?.name && m?.awayTeam?.name);
    const candidates = [];

    for (const f of withNames) {
      try {
        const analysis = await analyzeOneFixture(f);
        const pick = pickParlayCandidate(analysis);
        if (pick) candidates.push(pick);
      } catch (err) {
        console.warn('[PARLAY] fallo analizando partido:', err.message);
      }
    }

    candidates.sort((a, b) => Number(b.referenceEvPct || 0) - Number(a.referenceEvPct || 0));

    if (!candidates.length) {
      return res.json({
        ok: true,
        date,
        stakeEur: STAKE_EUR,
        candidates: [],
        parlays: [],
        message: 'No se detectaron picks fuertes ni errores de cuota para esta fecha.'
      });
    }

    const parlays = [];
    for (let l = 2; l <= Math.min(maxLegs, candidates.length); l++) {
      const legs = candidates.slice(0, l);
      const combinedOdds = legs.reduce((acc, leg) => acc * Number(leg.odds), 1);
      const combinedProb = legs.reduce((acc, leg) => acc * (Number(leg.probability) / 100), 1);
      const combinedEv = Number(((combinedProb * combinedOdds - 1) * 100).toFixed(1));

      parlays.push({
        legsCount: l,
        legs,
        combinedOdds: Number(combinedOdds.toFixed(2)),
        combinedProbabilityPct: Number((combinedProb * 100).toFixed(1)),
        combinedEvPct: combinedEv
      });
    }

    return res.json({ ok: true, date, stakeEur: STAKE_EUR, candidates, parlays });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/analyze', async (req, res) => {
  try {
    const requestedHome = String(req.query.home || '').trim();
    const requestedAway = String(req.query.away || '').trim();
    const date = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);

    if (!requestedHome || !requestedAway) {
      return res.status(400).json({ ok: false, error: 'Debes proporcionar home y away.' });
    }

    const fixtures = await getFixture(date);
    let selected = fixtures.find(m =>
      namesMatch(m?.homeTeam?.name, requestedHome) && namesMatch(m?.awayTeam?.name, requestedAway)
    );

    let reversedRequest = false;
    if (!selected) {
      selected = fixtures.find(m =>
        namesMatch(m?.homeTeam?.name, requestedAway) && namesMatch(m?.awayTeam?.name, requestedHome)
      );
      if (selected) reversedRequest = true;
    }

    if (!selected) {
      return res.status(404).json({ ok: false, error: 'No se encontr\u00f3 el partido solicitado.', modelVersion: MODEL_VERSION });
    }

    const actualHomeName = selected.homeTeam?.name || requestedHome;
    const actualAwayName = selected.awayTeam?.name || requestedAway;
    const competitionCode = selected.competitionCode || selected.competition?.code || null;

    let homeTeamObj = selected.homeTeam?.id ? selected.homeTeam : null;
    let awayTeamObj = selected.awayTeam?.id ? selected.awayTeam : null;

    if ((!homeTeamObj?.id || !awayTeamObj?.id) && competitionCode) {
      const [hObj, aObj] = await Promise.all([
        findTeam(actualHomeName, competitionCode),
        findTeam(actualAwayName, competitionCode)
      ]);
      if (hObj) homeTeamObj = hObj;
      if (aObj) awayTeamObj = aObj;
    }

    const homeId = homeTeamObj?.id || null;
    const awayId = awayTeamObj?.id || null;

    if (!homeId || !awayId) {
      return res.status(503).json({
        ok: false,
        error: 'Football-Data no pudo identificar uno de los equipos para estad\u00edsticas.',
        modelVersion: MODEL_VERSION
      });
    }

    const [homeMatches, awayMatches] = await Promise.all([
      getTeamRecentMatches(homeId),
      getTeamRecentMatches(awayId)
    ]);

    let homeStats = calculateRecentTeamStats(homeId, homeMatches);
    let awayStats = calculateRecentTeamStats(awayId, awayMatches);

    // Shrinkage hacia la media
    const attackBaseline = 1.35;
    const defenseBaseline = 1.20;
    const homeGF = shrinkToMean(homeStats.avgGoalsFor, attackBaseline, homeStats.matches);
    const homeGA = shrinkToMean(homeStats.avgGoalsAgainst, defenseBaseline, homeStats.matches);
    const awayGF = shrinkToMean(awayStats.avgGoalsFor, attackBaseline, awayStats.matches);
    const awayGA = shrinkToMean(awayStats.avgGoalsAgainst, defenseBaseline, awayStats.matches);

    homeStats = {
      ...homeStats,
      avgGoalsFor: homeGF,
      avgGoalsAgainst: homeGA,
      attackStrength: clamp(homeGF / attackBaseline, 0.45, 1.8),
      defenseStrength: clamp(attackBaseline / Math.max(homeGA, 0.25), 0.45, 1.8)
    };
    awayStats = {
      ...awayStats,
      avgGoalsFor: awayGF,
      avgGoalsAgainst: awayGA,
      attackStrength: clamp(awayGF / attackBaseline, 0.45, 1.8),
      defenseStrength: clamp(attackBaseline / Math.max(awayGA, 0.25), 0.45, 1.8)
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

    // 2. Modelo con Ventaja de Local ajustada por Liga
    const modelInput = createModelInput(homeStats, awayStats, competitionCode);
    let model = matchModel(modelInput.homeXg, modelInput.awayXg);

    // H2H
    const [bbHomeTeamId, bbAwayTeamId] = await Promise.all([
      getBigBallsTeamId(actualHomeName, competitionCode),
      getBigBallsTeamId(actualAwayName, competitionCode)
    ]);
    const h2hDrawRate = await getH2HDrawRate(bbHomeTeamId, bbAwayTeamId);
    model = applyH2HAdjustment(model, h2hDrawRate);

    // 3. Predicci\u00f3n Big Balls (Segunda Opini\u00f3n)
    const bbPrediction = await getBigBallsPrediction(actualHomeName, actualAwayName, competitionCode);
    const bbComparison = evaluateSecondOpinion(model, bbPrediction);

    // Confianza base matem\u00e1tica aut\u00f3noma
    let modelConfidence = 50;
    try {
      const bestProbability = Math.max(model.homeWin, model.draw, model.awayWin);
      const confidenceSampleSize = Math.min(homeStats.matches, awayStats.matches);
      modelConfidence = confidence(bestProbability, confidenceSampleSize);
    } catch (e) {
      modelConfidence = 50;
    }

    const confidenceAdjusted = clamp(Math.round(modelConfidence), 20, 95);

    // Actualizar ventaja de local aprendida
    updateLearnedHomeAdvantage(competitionCode, (homeMatches || []).concat(awayMatches || []));

    // Cuotas reales
    const odds = await getOdds(actualHomeName, actualAwayName, competitionCode);
    const markets = buildMarkets(model, odds, actualHomeName, actualAwayName);
    const value = bestValue(markets, confidenceAdjusted);

    const betEligible = Boolean(value);
    const recommendation = betEligible ? value.name : 'NO BET';
    const reason = betEligible
      ? `El modelo detecta valor respaldado por el mercado con ${Number(value.probability).toFixed(1)}% de probabilidad y EV de mercado de ${Number(value.referenceEvPct).toFixed(1)}%.`
      : 'No existe una oportunidad de valor positiva que cumpla los filtros actuales de probabilidad, EV, confianza y respaldo del mercado.';

    const confidenceLevel = confidenceAdjusted >= 75 ? 'Alta' : (confidenceAdjusted >= 60 ? 'Media' : 'Baja');
    const confidenceExplanation = confidenceAdjusted >= 75
      ? 'Se\u00f1al estad\u00edstica fuerte respaldada por m\u00e9tricas s\u00f3lidas.'
      : (confidenceAdjusted >= 60 ? 'Se\u00f1al moderada. Recomendada gesti\u00f3n de banca disciplinada.' : 'Se\u00f1al insuficiente para recomendar apuesta de alto riesgo.');

    const score = mostLikelyScore(modelInput.homeXg, modelInput.awayXg);

    return res.json({
      ok: true,
      modelVersion: MODEL_VERSION,
      match: {
        id: selected.id || null,
        home: actualHomeName,
        homeCrest: homeTeamObj?.crest || selected.homeTeam?.crest || null,
        away: actualAwayName,
        awayCrest: awayTeamObj?.crest || selected.awayTeam?.crest || null,
        date,
        kickoff: selected.utcDate || null,
        competition: selected.competitionName || selected.competition?.name || competitionCode,
        competitionCode
      },
      recommendation,
      reason,
      betEligible,
      strength: value?.valueLevel || 'Sin valor',
      homeAdvantage: {
        factor: modelInput.homeAdvantage,
        league: competitionCode,
        description: `Ventaja de local ajustada para ${competitionName(competitionCode)} (${modelInput.homeAdvantage}x)`
      },
      rest: {
        home: restAdjusted.homeRest,
        away: restAdjusted.awayRest
      },
      recentForm: { home: homeStats, away: awayStats },
      averages: {
        home: { goalsFor: Number(homeStats.avgGoalsFor.toFixed(2)), goalsAgainst: Number(homeStats.avgGoalsAgainst.toFixed(2)) },
        away: { goalsFor: Number(awayStats.avgGoalsFor.toFixed(2)), goalsAgainst: Number(awayStats.avgGoalsAgainst.toFixed(2)) }
      },
      xG: {
        home: Number(modelInput.homeXg.toFixed(2)),
        away: Number(modelInput.awayXg.toFixed(2)),
        total: Number((modelInput.homeXg + modelInput.awayXg).toFixed(2))
      },
      mostLikelyScore: score,
      probabilities: {
        homeWin: Number((model.homeWin * 100).toFixed(1)),
        draw: Number((model.draw * 100).toFixed(1)),
        awayWin: Number((model.awayWin * 100).toFixed(1)),
        over25: Number((model.over25 * 100).toFixed(1)),
        under25: Number((model.under25 * 100).toFixed(1)),
        btts: Number((model.btts * 100).toFixed(1))
      },
      markets,
      oddsAvailable: Boolean(odds?.available),
      oddsReason: odds?.available ? null : (odds?.reason || null),
      bestValue: value || null,
      confidence: confidenceAdjusted,
      confidenceLevel,
      confidenceExplanation,
      bigBallsComparison: bbComparison,
      stakeEur: STAKE_EUR,
      diagnostics: {
        fixtureSource: selected.source || 'football-data',
        competitionCode,
        homeTeamId: homeId,
        awayTeamId: awayId,
        homeInjuries: injuryAdjusted.homeInjuries,
        awayInjuries: injuryAdjusted.awayInjuries,
        homeRestDays,
        awayRestDays,
        homeAdvantageFactor: modelInput.homeAdvantage
      }
    });
  } catch (error) {
    console.error('ANALYZE ERROR:', error);
    return res.status(500).json({ ok: false, error: error.message, modelVersion: MODEL_VERSION });
  }
});

/* =========================================================
   BACKTESTING & CALIBRACI\u00d3N ESTAD\u00cdSTICA (V8.1 Foundation)
   Calcula Brier Score, Log Loss, precisi\u00f3n 1X2 y calibraci\u00f3n
   por tramos con resultados reales de Football-Data.
========================================================= */
app.get('/api/backtest', async (req, res) => {
  const comp = String(req.query.competition || 'PD').trim().toUpperCase();
  const limit = Math.min(50, Math.max(10, Number(req.query.limit) || 25));
  const cacheKey = `backtest:${comp}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const today = new Date().toISOString().slice(0, 10);
    const pastFrom = addDaysToDateStr(today, -35);
    const data = await footballData(`/competitions/${comp}/matches?dateFrom=${pastFrom}&dateTo=${today}&status=FINISHED`);
    const matches = (Array.isArray(data?.matches) ? data.matches : []).slice(-limit);

    if (matches.length < 5) {
      return res.json({
        ok: true,
        modelVersion: MODEL_VERSION,
        competition: comp,
        evaluatedMatches: matches.length,
        message: 'No hay suficientes partidos hist\u00f3ricos finalizados en este periodo para calcular m\u00e9tricas.',
        metrics: null
      });
    }

    let brierSum = 0;
    let logLossSum = 0;
    let correct1X2 = 0;
    let totalEvaluated = 0;
    let simulatedPnl = 0;

    const bins = {
      '40-55': { count: 0, predictedSum: 0, actualWins: 0 },
      '55-65': { count: 0, predictedSum: 0, actualWins: 0 },
      '65-75': { count: 0, predictedSum: 0, actualWins: 0 },
      '75+': { count: 0, predictedSum: 0, actualWins: 0 }
    };

    for (const m of matches) {
      const hGoals = Number(m.score?.fullTime?.home);
      const aGoals = Number(m.score?.fullTime?.away);
      if (!Number.isFinite(hGoals) || !Number.isFinite(aGoals)) continue;

      const actualResult = hGoals > aGoals ? 'home' : (hGoals === aGoals ? 'draw' : 'away');
      const yH = actualResult === 'home' ? 1 : 0;
      const yD = actualResult === 'draw' ? 1 : 0;
      const yA = actualResult === 'away' ? 1 : 0;

      const hAdv = getHomeAdvantage(comp);
      const estimatedHXg = clamp(1.4 * hAdv, 0.4, 3.2);
      const estimatedAXg = clamp(1.15, 0.3, 2.8);
      const pred = matchModel(estimatedHXg, estimatedAXg);

      const pH = pred.homeWin;
      const pD = pred.draw;
      const pA = pred.awayWin;

      // Multi-class Brier Score: (pH - yH)^2 + (pD - yD)^2 + (pA - yA)^2
      const brier = Math.pow(pH - yH, 2) + Math.pow(pD - yD, 2) + Math.pow(pA - yA, 2);
      brierSum += brier;

      // Log Loss
      const probTarget = actualResult === 'home' ? pH : (actualResult === 'draw' ? pD : pA);
      logLossSum += -Math.log(Math.max(0.001, probTarget));

      // Pron\u00f3stico favorito del modelo
      const predictedWinner = (pH > pD && pH > pA) ? 'home' : (pA > pH && pA > pD ? 'away' : 'draw');
      const maxP = Math.max(pH, pD, pA);
      const maxPPct = maxP * 100;

      if (predictedWinner === actualResult) {
        correct1X2++;
      }

      let binKey = '40-55';
      if (maxPPct >= 75) binKey = '75+';
      else if (maxPPct >= 65) binKey = '65-75';
      else if (maxPPct >= 55) binKey = '55-65';

      bins[binKey].count++;
      bins[binKey].predictedSum += maxPPct;
      if (predictedWinner === actualResult) {
        bins[binKey].actualWins++;
      }

      const fairOdds = 1 / Math.max(0.05, maxP);
      if (predictedWinner === actualResult) {
        simulatedPnl += (fairOdds - 1) * 10;
      } else {
        simulatedPnl -= 10;
      }

      totalEvaluated++;
    }

    const avgBrier = totalEvaluated > 0 ? Number((brierSum / totalEvaluated).toFixed(4)) : null;
    const avgLogLoss = totalEvaluated > 0 ? Number((logLossSum / totalEvaluated).toFixed(4)) : null;
    const accuracyPct = totalEvaluated > 0 ? Number(((correct1X2 / totalEvaluated) * 100).toFixed(1)) : null;
    const roiPct = totalEvaluated > 0 ? Number(((simulatedPnl / (totalEvaluated * 10)) * 100).toFixed(1)) : null;

    const calibrationReport = Object.entries(bins).map(([binName, b]) => ({
      range: binName,
      matches: b.count,
      avgPredictedPct: b.count > 0 ? Number((b.predictedSum / b.count).toFixed(1)) : 0,
      actualWinRatePct: b.count > 0 ? Number(((b.actualWins / b.count) * 100).toFixed(1)) : 0,
      gap: b.count > 0 ? Number(((b.actualWins / b.count) * 100 - (b.predictedSum / b.count)).toFixed(1)) : 0
    }));

    const result = {
      ok: true,
      modelVersion: MODEL_VERSION,
      competition: comp,
      evaluatedMatches: totalEvaluated,
      metrics: {
        brierScore: avgBrier,
        logLoss: avgLogLoss,
        accuracy1X2Pct: accuracyPct,
        simulatedPnlEur: Number(simulatedPnl.toFixed(2)),
        simulatedRoiPct: roiPct,
        calibration: calibrationReport
      }
    };

    cacheSet(cacheKey, result, 'analysis');
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =========================================================
   SIMULADOR DE APUESTAS & AUTO-SETTLE
========================================================= */
function requireDb(res) {
  if (!pool) {
    res.status(503).json({
      ok: false,
      error: 'La base de datos PostgreSQL no est\u00e1 configurada (DATABASE_URL).'
    });
    return false;
  }
  return true;
}

function computeProfit(status, stakeEur, oddsValue) {
  const stake = Number(stakeEur) || 0;
  const odds = Number(oddsValue) || 0;
  if (status === 'won') return Number((stake * (odds - 1)).toFixed(2));
  if (status === 'lost') return Number((-stake).toFixed(2));
  return 0;
}

function evaluateMarketResult(market, outcome, homeGoals, awayGoals) {
  if (market === 'h2h') {
    if (outcome === 'home') return homeGoals > awayGoals ? 'won' : 'lost';
    if (outcome === 'draw') return homeGoals === awayGoals ? 'won' : 'lost';
    if (outcome === 'away') return awayGoals > homeGoals ? 'won' : 'lost';
  }
  if (market === 'totals') {
    const total = homeGoals + awayGoals;
    if (outcome === 'over') return total >= 3 ? 'won' : 'lost';
    if (outcome === 'under') return total < 3 ? 'won' : 'lost';
  }
  return null;
}

async function getMatchResult(home, away, dateStr) {
  if (!dateStr) return null;
  try {
    const matches = await getFixturesFootballData(dateStr);
    const found = matches.find(m => namesMatch(m?.homeTeam?.name, home) && namesMatch(m?.awayTeam?.name, away));
    if (!found || found.status !== 'FINISHED') return null;
    const hg = Number(found?.score?.fullTime?.home);
    const ag = Number(found?.score?.fullTime?.away);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
    return { finished: true, homeGoals: hg, awayGoals: ag };
  } catch (e) {
    return null;
  }
}

async function autoSettlePendingBets() {
  if (!pool) return { settled: 0 };
  let settledCount = 0;
  try {
    const pendingResult = await pool.query(
      `SELECT * FROM simulated_bets WHERE status = 'pending' AND market != 'parlay' AND match_date IS NOT NULL LIMIT 200`
    );
    for (const bet of pendingResult.rows) {
      const matchDate = bet.match_date instanceof Date ? bet.match_date.toISOString().slice(0, 10) : String(bet.match_date).slice(0, 10);
      const res = await getMatchResult(bet.home, bet.away, matchDate);
      if (!res) continue;
      const st = evaluateMarketResult(bet.market, bet.outcome, res.homeGoals, res.awayGoals);
      if (!st) continue;
      const profit = computeProfit(st, bet.stake_eur, bet.odds);
      await pool.query(`UPDATE simulated_bets SET status = $1, profit_eur = $2, settled_at = now() WHERE id = $3`, [st, profit, bet.id]);
      settledCount++;
    }
  } catch (e) {}
  return { settled: settledCount };
}

app.post('/api/bets/auto-settle', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const result = await autoSettlePendingBets();
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/bets', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { home, away, date, competition, market, outcome, marketName, odds, probability, legs, stakeEur } = req.body || {};
    if (!home || !away || !market || !outcome || !odds) {
      return res.status(400).json({ ok: false, error: 'Faltan datos de la apuesta.' });
    }
    const legsJson = Array.isArray(legs) && legs.length ? JSON.stringify(legs) : null;
    const finalStake = Number.isFinite(Number(stakeEur)) ? clamp(Number(stakeEur), STAKE_EUR * 0.5, STAKE_EUR * 3) : STAKE_EUR;

    const result = await pool.query(
      `INSERT INTO simulated_bets
        (match_date, home, away, competition, market, outcome, market_name, odds, model_probability, stake_eur, status, legs_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11) RETURNING *`,
      [date || null, home, away, competition || null, market, outcome, marketName || market, Number(odds), probability != null ? Number(probability) : null, finalStake, legsJson]
    );
    return res.json({ ok: true, bet: result.rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/bets', async (req, res) => {
  if (!requireDb(res)) return;
  try {
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
  if (!requireDb(res)) return;
  try {
    const id = Number(req.params.id);
    const result = Array.isArray(req.body?.result) ? req.body.result[0] : req.body?.result;
    if (!['won', 'lost', 'void'].includes(result)) {
      return res.status(400).json({ ok: false, error: "El resultado debe ser 'won', 'lost' o 'void'." });
    }
    const existing = await pool.query('SELECT * FROM simulated_bets WHERE id = $1', [id]);
    if (!existing.rows.length) return res.status(404).json({ ok: false, error: 'Apuesta no encontrada.' });
    const bet = existing.rows[0];
    const profit = computeProfit(result, bet.stake_eur, bet.odds);
    const updated = await pool.query(
      `UPDATE simulated_bets SET status = $1, profit_eur = $2, settled_at = now() WHERE id = $3 RETURNING *`,
      [result, profit, id]
    );
    return res.json({ ok: true, bet: updated.rows[0] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/bets/summary', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const period = String(req.query.period || 'month').trim();
    const interval = period === 'week' ? '7 days' : '30 days';

    const result = await pool.query(
      `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(profit_eur), 0)::float AS profit, COALESCE(SUM(stake_eur), 0)::float AS staked
       FROM simulated_bets WHERE created_at >= now() - interval '${interval}' GROUP BY status`
    );

    const summary = { pending: 0, won: 0, lost: 0, void: 0, totalProfitEur: 0, totalStakedEur: 0 };
    for (const r of result.rows) {
      if (summary[r.status] !== undefined) summary[r.status] = r.count;
      summary.totalProfitEur += r.profit;
      summary.totalStakedEur += r.staked;
    }
    const settled = summary.won + summary.lost;
    const accuracy = settled > 0 ? Number(((summary.won / settled) * 100).toFixed(1)) : null;

    return res.json({
      ok: true,
      period,
      ...summary,
      settledCount: settled,
      accuracyPct: accuracy,
      totalProfitEur: Number(summary.totalProfitEur.toFixed(2)),
      totalStakedEur: Number(summary.totalStakedEur.toFixed(2))
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/* =========================================================
   FRONTEND - RENDER PAGE (V7.17.0)
   Incluye:
   - Banner VS con escudos grandes
   - Medidor circular SVG de confianza
   - Skeletons animados de carga
   - Descanso propio gratis
   - Ventaja local ajustada
   - Segunda opini\u00f3n Big Balls
   - Favicon embebido e \u00edcono
========================================================= */
function renderPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no,viewport-fit=cover">
<meta http-equiv="Cache-Control" content="no-cache,no-store,must-revalidate">
<title>MK Bets V8.0.0 - Pron&#243;sticos Deportivos</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 130 90' style='background:%23080b10'%3E%3Cpolyline points='10,80 10,10 45,55 80,10 80,80' fill='none' stroke='%23ffb45d' stroke-width='11' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cline x1='80' y1='45' x2='118' y2='8' stroke='%23ffb45d' stroke-width='11' stroke-linecap='round'/%3E%3Cline x1='80' y1='45' x2='118' y2='82' stroke='%23ffb45d' stroke-width='11' stroke-linecap='round'/%3E%3C/svg%3E">

<style>
*{box-sizing:border-box;}
body{
  margin:0;
  font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:#080b10;
  color:#f5f7fa;
}
button,input{font:inherit;}
.app{
  max-width:760px;
  margin:auto;
  padding:calc(85px + env(safe-area-inset-top, 0px)) 14px 100px;
}
.header{padding:10px 4px 18px;}
.version{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:5px 12px;
  border-radius:999px;
  background:#171c25;
  border:1px solid #283344;
  font-size:12px;
  font-weight:800;
  color:#ffb45d;
}
.logo-row{display:flex;align-items:center;gap:12px;margin-top:12px;}
.logo-text{font-size:32px;font-weight:900;letter-spacing:2px;color:#fff;}
.card{
  background:#10151d;
  border:1px solid #242b36;
  border-radius:18px;
  padding:16px;
  margin-top:14px;
}
.card-title{
  font-size:12px;
  text-transform:uppercase;
  letter-spacing:1px;
  color:#929ba9;
  margin-bottom:12px;
  display:flex;
  align-items:center;
  justify-content:space-between;
}
.subtitle,.muted{color:#9da5b2;font-size:14px;line-height:1.45;}
.chips{display:flex;flex-wrap:wrap;gap:7px;margin:14px 0;}
.chip{
  background:#151a22;
  border:1px solid #252c37;
  border-radius:999px;
  padding:6px 10px;
  font-size:11px;
  font-weight:600;
}
.league-chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:12px;}
.league-chip{
  background:#151a22;
  border:1px solid #303846;
  border-radius:999px;
  padding:8px 12px;
  font-size:12px;
  font-weight:700;
  color:#c7ccd4;
  cursor:pointer;
  transition:all .15s ease;
}
.league-chip.active{background:#f4f5f7;color:#080b10;border-color:#f4f5f7;}
.league-chip-priority{border-color:#ffb45d;color:#ffb45d;}
.league-chip-priority.active{background:#ffb45d;color:#080b10;border-color:#ffb45d;}

input{
  width:100%;
  background:#090d13;
  border:1px solid #303846;
  color:white;
  border-radius:12px;
  padding:13px;
  margin-bottom:10px;
  outline:none;
}
.primary{
  width:100%;
  border:0;
  border-radius:13px;
  padding:14px;
  background:#f4f5f7;
  color:#080b10;
  font-weight:900;
  cursor:pointer;
  transition:opacity .2s;
}
.primary:disabled{opacity:.55;cursor:not-allowed;}
.btn-download{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  width:100%;
  border:1px solid #ffb45d;
  border-radius:12px;
  padding:11px;
  background:#1c170d;
  color:#ffb45d;
  font-size:13px;
  font-weight:800;
  text-decoration:none;
  margin-top:10px;
  cursor:pointer;
}

/* 6. ANIMACIONES DE CARGA TIPO ESQUELETO (SKELETON) */
@keyframes shimmerWave {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
.skeleton-shimmer {
  background: linear-gradient(90deg, #131924 0%, #202b3d 50%, #131924 100%);
  background-size: 200% 100%;
  animation: shimmerWave 1.6s infinite ease-in-out;
  border-radius: 8px;
}
.skeleton-card {
  background: #090d13;
  border: 1px solid #252c37;
  border-radius: 15px;
  padding: 14px;
  margin-bottom: 9px;
}
.skeleton-row { display: flex; align-items: center; gap: 10px; }
.skeleton-circle { width: 34px; height: 34px; border-radius: 50%; }
.skeleton-pill { height: 16px; border-radius: 999px; }
.skeleton-text { height: 14px; width: 60%; margin: 6px 0; }
.loading-status-text {
  text-align: center;
  color: #ffb45d;
  font-weight: 700;
  font-size: 13px;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

/* 4. BANNER "VS" EN EL AN&#193;LISIS */
.match-banner {
  background: linear-gradient(180deg, #131a26 0%, #0d121a 100%);
  border: 1px solid #2a3547;
  border-radius: 16px;
  padding: 18px 12px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 10px;
  text-align: center;
  margin-bottom: 16px;
  position: relative;
  overflow: hidden;
}
.match-banner::before {
  content: "";
  position: absolute;
  top: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg, transparent, #ffb45d, transparent);
}
.banner-team {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.banner-crest {
  width: 62px;
  height: 62px;
  object-fit: contain;
  filter: drop-shadow(0 4px 10px rgba(0,0,0,0.5));
}
.crest-fallback {
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: #1d2533;
  border: 2px solid #36445c;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
  font-weight: 900;
  color: #ffb45d;
}
.banner-team-name {
  font-size: 15px;
  font-weight: 900;
  line-height: 1.2;
  color: #fff;
  max-width: 140px;
}
.banner-role-pill {
  font-size: 9px;
  font-weight: 900;
  letter-spacing: 1px;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 999px;
  background: #17202d;
  color: #9da5b2;
}
.banner-vs-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.banner-vs-circle {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: radial-gradient(circle, #293448 0%, #10151f 100%);
  border: 2px solid #ffb45d;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 15px;
  font-weight: 900;
  color: #ffb45d;
  box-shadow: 0 0 16px rgba(255,180,93,0.3);
}
.banner-meta-time { font-size: 11px; font-weight: 800; color: #ffb45d; margin-top: 4px; }
.banner-meta-comp { font-size: 10px; color: #8e97a5; }

/* 7. MEDIDOR CIRCULAR DE CONFIANZA */
.confidence-card {
  background: #090d13;
  border: 1px solid #283344;
  border-radius: 16px;
  padding: 16px;
  margin: 14px 0;
  display: flex;
  align-items: center;
  gap: 16px;
}
.confidence-gauge-wrap {
  position: relative;
  width: 90px;
  height: 90px;
  flex-shrink: 0;
}
.confidence-svg { width: 90px; height: 90px; transform: rotate(-90deg); }
.gauge-bg { stroke: #1a222e; stroke-width: 8; fill: none; }
.gauge-bar {
  stroke-width: 8;
  fill: none;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.8s ease-in-out;
}
.gauge-bar.high { stroke: #7ee787; filter: drop-shadow(0 0 6px rgba(126,231,135,0.4)); }
.gauge-bar.medium { stroke: #ffb45d; filter: drop-shadow(0 0 6px rgba(255,180,93,0.4)); }
.gauge-bar.low { stroke: #ff7b72; filter: drop-shadow(0 0 6px rgba(255,123,114,0.4)); }
.gauge-content {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.gauge-num { font-size: 22px; font-weight: 900; line-height: 1; }
.gauge-label { font-size: 10px; font-weight: 800; text-transform: uppercase; margin-top: 2px; }
.confidence-details { flex: 1; }
.confidence-badge-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.badge-tag {
  font-size: 11px;
  font-weight: 800;
  padding: 3px 8px;
  border-radius: 6px;
  background: #17202d;
  color: #c7ccd4;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.badge-consensus-agree { background: #0f2c1a; color: #7ee787; border: 1px solid #1a5230; }
.badge-consensus-disagree { background: #2f1712; color: #ff7b72; border: 1px solid #5a261c; }

/* FIXTURES & GENERAL */
.fixture{
  background:#090d13;
  border:1px solid #252c37;
  border-radius:15px;
  padding:14px;
  margin-bottom:9px;
  transition:border-color .15s;
}
.fixture-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;}
.fixture-teams{font-size:15px;font-weight:800;line-height:1.35;display:flex;align-items:center;flex-wrap:wrap;gap:4px;}
.team-crest{width:22px;height:22px;object-fit:contain;vertical-align:middle;}
.fixture-meta{color:#8e97a5;font-size:12px;margin-top:5px;}
.analyze-small{
  border:0;
  border-radius:10px;
  padding:9px 12px;
  background:#f4f5f7;
  color:#080b10;
  font-size:11px;
  font-weight:900;
  white-space:nowrap;
  cursor:pointer;
}
.analysis-panel{
  display:grid;
  grid-template-rows:0fr;
  transition:grid-template-rows .28s ease, margin-top .28s ease;
  border-top:0 solid #252c37;
  margin-top:0;
}
.analysis-panel.open{grid-template-rows:1fr;margin-top:12px;border-top:1px solid #252c37;}
.analysis-inner{overflow:hidden;min-height:0;padding-top:0;}
.analysis-panel.open .analysis-inner{padding-top:12px;}
.analysis-close{
  width:100%;
  border:1px solid #303846;
  border-radius:10px;
  padding:10px;
  background:#151a22;
  color:#fff;
  font-weight:800;
  margin-bottom:10px;
  cursor:pointer;
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
.simulate-bet-btn{
  width:100%;
  border:0;
  border-radius:11px;
  padding:12px;
  margin-top:10px;
  background:#7ee787;
  color:#080b10;
  font-weight:900;
  cursor:pointer;
}
.nav{
  position:fixed;
  top:0;left:0;right:0;
  max-width:760px;
  margin:auto;
  background:rgba(10,13,18,.98);
  border-bottom:1px solid #252c37;
  display:flex;
  justify-content:space-around;
  padding:calc(16px + env(safe-area-inset-top, 0px)) 8px 14px;
  font-size:13px;
  color:#929ba9;
  z-index:30;
}
.nav span{cursor:pointer;padding:4px;text-align:center;}
.nav span.active-nav{color:white;font-weight:800;}
.empty{text-align:center;color:#9da5b2;padding:22px 8px;}
</style>
</head>
<body>

<div class="app">

<header class="header">
  <div>
    <span class="version">&#9679; V8.0.0 ANALYST</span>
  </div>

  <div class="logo-row">
    <svg width="86" height="36" viewBox="0 0 130 90" xmlns="http://www.w3.org/2000/svg">
      <polyline points="10,80 10,10 45,55 80,10 80,80" fill="none" stroke="#ffb45d" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"/>
      <line x1="80" y1="45" x2="118" y2="8" stroke="#ffb45d" stroke-width="11" stroke-linecap="round"/>
      <line x1="80" y1="45" x2="118" y2="82" stroke="#ffb45d" stroke-width="11" stroke-linecap="round"/>
    </svg>
    <span class="logo-text">BETS</span>
  </div>

  <h1 style="margin:14px 0 6px;font-size:28px;line-height:1.1">Analiza antes de apostar.</h1>
  <div class="subtitle">Motor Estad&#237;stico V8.0 + Local&#237;a Aprendida + Fatiga Suave + Lesiones Ponderadas + 2&#170; Opini&#243;n Desacoplada.</div>

  <div class="chips">
    <span class="chip">&#127967;&#65039; Local&#237;a Aprendida</span>
    <span class="chip">&#9201;&#65039; Fatiga Asim&#233;trica</span>
    <span class="chip">&#127973; Lesiones Ponderadas</span>
    <span class="chip">&#128302; 2&#170; Opini&#243;n Externa</span>
    <span class="chip">&#128202; Calibraci&#243;n V8.1</span>
  </div>
</header>

<section class="card" id="searchCard">
  <div class="card-title">Buscar partidos por fecha</div>

  <div class="league-chips" id="leagueChips">
    <button type="button" class="league-chip active" data-competition="">Todas</button>
    <button type="button" class="league-chip league-chip-priority" data-competition="PD">&#127466;&#127480; LaLiga</button>
    <button type="button" class="league-chip league-chip-priority" data-competition="CL">&#11088; Champions</button>
    <button type="button" class="league-chip" data-competition="PL">&#127988; Premier League</button>
    <button type="button" class="league-chip" data-competition="FL1">&#127467;&#127479; Ligue 1</button>
    <button type="button" class="league-chip" data-competition="SA">&#127470;&#127481; Serie A</button>
    <button type="button" class="league-chip" data-competition="BL1">&#127465;&#127466; Bundesliga</button>
    <button type="button" class="league-chip" data-competition="EL">&#129352; Europa League</button>
  </div>

  <input id="date" type="date">

  <button class="primary" id="searchBtn" type="button">&#128270; BUSCAR PARTIDOS</button>
  <button class="analysis-close" id="nextFixtureBtn" type="button" style="margin-top:8px">&#9197;&#65039; Buscar pr&#243;ximo partido disponible</button>

  <div id="searchSummary" style="color:#9da5b2;font-size:13px;margin-top:10px"></div>
</section>

<!-- 6. SKELETON LOADER CONTAINER -->
<div id="loadingSkeleton" style="display:none;margin-top:14px">
  <div class="loading-status-text">
    <span>&#9917;</span>
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

  <button class="primary" id="parlayBtn" type="button" style="margin-top:12px">&#127920; GENERAR PARLAY SUGERIDO</button>
  <div id="parlayLoading" style="display:none;margin-top:12px">
    <div class="loading-status-text">Buscando picks fuertes y errores de cuota...</div>
  </div>
  <div id="parlayResult" style="margin-top:10px"></div>
</section>

<!-- VISTA INICIO -->
<section id="homeCard" class="card">
  <div style="text-align:center;padding:16px 0;border-bottom:1px solid #242b36;margin-bottom:14px">
    <div style="font-size:52px;line-height:1">&#9917;</div>
    <div style="font-style:italic;color:#c7ccd4;margin-top:8px">"El bal&#243;n no miente. Los n&#250;meros tampoco."</div>
  </div>

  <div class="card-title">Novedades V8.0.0</div>
  <div class="muted">
    1. <b>Ventaja Local Aprendida:</b> Estimaci&#243;n bayesiana con regresi&#243;n a la media seg&#250;n goles hist&#243;ricos reales por liga.<br>
    2. <b>Lesiones Ponderadas:</b> Impacto espec&#237;fico por posici&#243;n (portero/defensa/delantera) y acotado al 8% m&#225;ximo.<br>
    3. <b>Fatiga Asim&#233;trica y Suave:</b> Diferencia fatiga defensiva de ofensiva con curvas suaves continuas.<br>
    4. <b>2&#170; Opini&#243;n Desacoplada:</b> Big Balls como referencia externa independiente sin alterar la confianza matem&#225;tica propia.<br>
    5. <b>Favoritos &gt;10d:</b> Chunking seguro de peticiones sin error HTTP 400.
  </div>
</section>

<!-- VISTA MIS APUESTAS (SIMULADOR DE APUESTAS & RENTABILIDAD) -->
<section id="betsCard" class="card" style="display:none">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid #242b36;padding-bottom:10px">
    <div>
      <div class="card-title" style="margin:0">&#128202; Mis apuestas</div>
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
  <span id="navHome">&#8962;<br>Inicio</span>
  <span id="navAnalyst" class="active-nav"><strong>&#129504;<br>Analyst</strong></span>
  <span id="navBets"><strong>&#128202;<br>Mis apuestas</strong></span>
</nav>

<script>
(function(){
'use strict';

let selectedCompetition = '';

function esc(val){
  return String(val == null ? '' : val)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

function pct(v){
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) + '%' : '-';
}

function localDateValue(){
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0,10);
}

function formatTime(v){
  if (!v) return '--:--';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '--:--' : d.toLocaleTimeString('es-MX', {hour:'2-digit', minute:'2-digit'});
}

function formatDate(v){
  if (!v) return '';
  const p = v.split('-');
  return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : v;
}

function crestImg(url, name){
  if (url) {
    return '<img src="' + esc(url) + '" alt="' + esc(name) + '" class="banner-crest" onerror="this.outerHTML=\\'<div class=\\\\\\'crest-fallback\\\\\\'>' + esc(name.charAt(0)) + '</div>\\'">';
  }
  return '<div class="crest-fallback">' + esc((name || 'T').charAt(0)) + '</div>';
}

/* 7. GENERADOR DEL MEDIDOR CIRCULAR DE CONFIANZA */
function renderCircularConfidence(conf, level, explanation, bbComp, restData) {
  const c = Math.max(0, Math.min(100, Number(conf) || 50));
  const r = 38;
  const circum = 2 * Math.PI * r; // ~238.76
  const offset = circum - (circum * c / 100);

  const colorClass = c >= 75 ? 'high' : (c >= 60 ? 'medium' : 'low');

  let consensusBadge = '';
  if (bbComp && bbComp.available) {
    const badgeCls = bbComp.agrees ? 'badge-consensus-agree' : 'badge-consensus-disagree';
    const icon = bbComp.agrees ? '\u{1f91d}' : '\u26a0\ufe0f';
    consensusBadge = '<div class="badge-tag ' + badgeCls + '">' + icon + ' ' + esc(bbComp.status) + '</div>';
  }

  let restBadge = '';
  if (restData) {
    restBadge = '<div class="badge-tag">\u23f1\ufe0f Descanso: Loc ' + esc(restData.home?.days != null ? restData.home.days + 'd' : '?') + ' vs Vis ' + esc(restData.away?.days != null ? restData.away.days + 'd' : '?') + '</div>';
  }

  return \`
    <div class="confidence-card">
      <div class="confidence-gauge-wrap">
        <svg class="confidence-svg" viewBox="0 0 90 90">
          <circle class="gauge-bg" cx="45" cy="45" r="\${r}"></circle>
          <circle class="gauge-bar \${colorClass}" cx="45" cy="45" r="\${r}"
            stroke-dasharray="\${circum}"
            stroke-dashoffset="\${offset}">
          </circle>
        </svg>
        <div class="gauge-content">
          <span class="gauge-num">\${c}%</span>
          <span class="gauge-label \${colorClass}">\${esc(level)}</span>
        </div>
      </div>
      <div class="confidence-details">
        <strong style="display:block;font-size:14px;color:#fff">Confianza del An\u00e1lisis: \${esc(level)}</strong>
        <div class="muted" style="font-size:12px;margin-top:3px">\${esc(explanation)}</div>
        <div class="confidence-badge-row">
          \${consensusBadge}
          \${restBadge}
        </div>
      </div>
    </div>
  \`;
}

function fixtureHtml(f, idx, date){
  const panelId = 'analysis-' + idx + '-' + String(f.id || idx);
  return \`
    <article class="fixture">
      <div class="fixture-head">
        <div>
          <div class="fixture-teams">
            \${f.homeCrest ? '<img src="' + esc(f.homeCrest) + '" class="team-crest" alt="">' : ''}
            \${esc(f.home)}
            <span style="color:#8e97a5;font-weight:400">vs</span>
            \${f.awayCrest ? '<img src="' + esc(f.awayCrest) + '" class="team-crest" alt="">' : ''}
            \${esc(f.away)}
          </div>
          <div class="fixture-meta">
            \u{1f550} \${formatTime(f.kickoff)} \u00b7 \u{1f3c6} \${esc(f.competition || 'Liga')}
          </div>
        </div>
        <button class="analyze-small" type="button" data-panel="\${panelId}" data-home="\${esc(f.home)}" data-away="\${esc(f.away)}" data-date="\${esc(date)}">
          \u{1f9e0} ANALIZAR
        </button>
      </div>

      <div id="\${panelId}" class="analysis-panel">
        <div class="analysis-inner">
          <button class="analysis-close" type="button" data-close="\${panelId}">\u25b2 CERRAR AN\u00c1LISIS</button>

          <!-- Skeleton interno del an\u00e1lisis -->
          <div id="\${panelId}-loading" style="display:none;padding:10px 0">
            <div class="loading-status-text">Analizando xG, descanso de jugadores y cuotas...</div>
            <div class="skeleton-shimmer" style="height:90px;border-radius:14px;margin-bottom:10px"></div>
            <div class="skeleton-shimmer" style="height:60px;border-radius:14px"></div>
          </div>

          <div id="\${panelId}-error" style="display:none;color:#ff7b72;padding:10px;background:#1e1416;border-radius:10px"></div>
          <div id="\${panelId}-content" style="display:none"></div>
        </div>
      </div>
    </article>
  \`;
}

async function searchFixtures(){
  const date = document.getElementById('date').value;
  const skeleton = document.getElementById('loadingSkeleton');
  const error = document.getElementById('error');
  const card = document.getElementById('fixturesCard');
  const list = document.getElementById('fixtureList');
  const summary = document.getElementById('searchSummary');

  if (!date) return;

  error.style.display = 'none';
  skeleton.style.display = 'block';
  card.style.display = 'none';
  list.innerHTML = '';
  summary.textContent = '';

  try {
    const res = await fetch('/api/fixtures?date=' + encodeURIComponent(date) + (selectedCompetition ? '&competition=' + encodeURIComponent(selectedCompetition) : ''), { cache:'no-store' });
    let data;
    try {
      data = await res.json();
    } catch (jsonErr) {
      throw new Error('Error de conexi\u00f3n con el servidor (HTTP ' + res.status + '). Espera 30 segundos mientras Render inicializa.');
    }

    if (!res.ok || !data.ok) throw new Error(data.error || 'Error cargando partidos.');

    card.style.display = 'block';
    const fixtures = Array.isArray(data.fixtures) ? data.fixtures : [];

    if (!fixtures.length) {
      summary.textContent = 'No se encontraron partidos para ' + formatDate(date) + '.';
      list.innerHTML = '<div class="empty">No hay partidos programados para esta fecha.</div>';
      return;
    }

    summary.textContent = fixtures.length + ' partidos encontrados.';
    list.innerHTML = fixtures.map((f, i) => fixtureHtml(f, i, date)).join('');
  } catch (err) {
    error.style.display = 'block';
    error.textContent = err.message || 'Error al buscar partidos.';
  } finally {
    skeleton.style.display = 'none';
  }
}

async function openAnalysis(panelId, home, away, date){
  const panel = document.getElementById(panelId);
  if (!panel) return;

  panel.classList.add('open');
  const loading = document.getElementById(panelId + '-loading');
  const error = document.getElementById(panelId + '-error');
  const content = document.getElementById(panelId + '-content');

  loading.style.display = 'block';
  error.style.display = 'none';
  content.style.display = 'none';
  content.innerHTML = '';

  try {
    const res = await fetch('/api/analyze?home=' + encodeURIComponent(home) + '&away=' + encodeURIComponent(away) + '&date=' + encodeURIComponent(date), { cache:'no-store' });
    let data;
    try {
      data = await res.json();
    } catch (jsonErr) {
      throw new Error('Error al conectar con la API de an\u00e1lisis (HTTP ' + res.status + ').');
    }

    if (!res.ok || !data.ok) throw new Error(data.error || 'No se pudo analizar el partido.');

    // RENDERIZAR AN\u00c1LISIS COMPLETO
    content.innerHTML = renderAnalysisContent(data);
    content.style.display = 'block';
  } catch (err) {
    error.style.display = 'block';
    error.textContent = err.message || 'Error analizando partido.';
  } finally {
    loading.style.display = 'none';
  }
}

function renderAnalysisContent(data){
  const m = data.match;

  // 4. BANNER VS CON ESCUDOS GRANDES
  const bannerHtml = \`
    <div class="match-banner">
      <div class="banner-team">
        \${crestImg(m.homeCrest, m.home)}
        <div class="banner-team-name">\${esc(m.home)}</div>
        <div class="banner-role-pill">LOCAL</div>
      </div>
      <div class="banner-vs-center">
        <div class="banner-meta-comp">\u{1f3c6} \${esc(m.competition || 'Competici\u00f3n')}</div>
        <div class="banner-vs-circle">VS</div>
        <div class="banner-meta-time">\u{1f550} \${formatTime(m.kickoff)}</div>
      </div>
      <div class="banner-team">
        \${crestImg(m.awayCrest, m.away)}
        <div class="banner-team-name">\${esc(m.away)}</div>
        <div class="banner-role-pill">VISITANTE</div>
      </div>
    </div>
  \`;

  // 7. MEDIDOR CIRCULAR DE CONFIANZA
  const confidenceGaugeHtml = renderCircularConfidence(
    data.confidence,
    data.confidenceLevel,
    data.confidenceExplanation,
    data.bigBallsComparison,
    data.rest
  );

  // DECISI\u00d3N VALUE BET
  const decisionClass = data.betEligible ? 'bet' : 'noBet';
  const recMarket = (Array.isArray(data.markets) ? data.markets.find(mk => mk.name === data.recommendation) : null) || (Array.isArray(data.markets) ? data.markets[0] : null);
  const recOdds = recMarket && recMarket.bestOdds ? Number(recMarket.bestOdds) : 1.95;
  const recProb = recMarket && recMarket.probability ? Number(recMarket.probability) : (data.probabilities?.homeWin || 50);
  const isEligible = data.recommendation && data.recommendation !== 'NO BET';

  let simulateBtnHtml = '';
  if (isEligible) {
    simulateBtnHtml = '<div style="margin-top:12px">' +
      '<button type="button" class="simulate-bet-btn" onclick="saveSimulatedBet(\'' + esc(m.home) + '\', \'' + esc(m.homeCrest||'') + '\', \'' + esc(m.away) + '\', \'' + esc(m.awayCrest||'') + '\', \'' + esc(m.competition||'') + '\', \'' + esc(data.recommendation) + '\', ' + recOdds + ', ' + recProb + ', ' + data.confidence + ', \'' + esc(data.confidenceLevel) + '\')">' +
        '\u{1f4cc} Simular esta apuesta (Guardar en Mis apuestas)' +
      '</button>' +
    '</div>';
  }

  let marketsHtml = '';
  if (Array.isArray(data.markets) && data.markets.length > 0) {
    marketsHtml = '<div class="section-label">\u{1f4b5} Cuotas & Mercados Disponibles</div>' +
      data.markets.map(function(mk){
        const o = mk.bestOdds ? Number(mk.bestOdds).toFixed(2) : '-';
        const ev = mk.referenceEvPct ? (mk.referenceEvPct > 0 ? '+' : '') + mk.referenceEvPct + '%' : '-';
        return '<div class="market" style="display:flex;justify-content:space-between;align-items:center">' +
          '<div>' +
            '<b>' + esc(mk.name) + '</b>' +
            '<div class="muted" style="font-size:11px">Prob: ' + pct(mk.probability) + ' \u2022 EV: ' + ev + '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span style="font-weight:900;color:#ffb45d;font-size:14px">@' + o + '</span>' +
            '<button type="button" class="league-chip" style="padding:4px 8px;font-size:11px;background:#ffb45d;color:#080b10;font-weight:800;border:0;cursor:pointer" onclick="saveSimulatedBet(\'' + esc(m.home) + '\', \'' + esc(m.homeCrest||'') + '\', \'' + esc(m.away) + '\', \'' + esc(m.awayCrest||'') + '\', \'' + esc(m.competition||'') + '\', \'' + esc(mk.name) + '\', ' + (mk.bestOdds||1.90) + ', ' + (mk.probability||50) + ', ' + data.confidence + ', \'' + esc(data.confidenceLevel) + '\')">' +
              '+ Simular' +
            '</button>' +
          '</div>' +
        '</div>';
      }).join('');
  }

  let bbHtml = '';
  if (data.bigBallsComparison && data.bigBallsComparison.available) {
    const borderColor = data.bigBallsComparison.agrees ? '#1a5230' : '#5a261c';
    const bgColor = data.bigBallsComparison.agrees ? '#0b1f14' : '#1e110f';
    const textColor = data.bigBallsComparison.agrees ? '#7ee787' : '#ff7b72';
    const textTitle = data.bigBallsComparison.agrees ? '\u{1f91d} Consenso Big Balls' : '\u26a0\ufe0f Alerta de Divergencia Big Balls';
    bbHtml = '<div class="value-box" style="border-color:' + borderColor + ';background:' + bgColor + '">' +
      '<b style="color:' + textColor + '">' + textTitle + '</b>' +
      '<div class="muted" style="margin-top:4px">' + esc(data.bigBallsComparison.message) + '</div>' +
    '</div>';
  }

  return bannerHtml +
    '<div class="fixture-decision">' +
      '<div class="section-label">Decisi\u00f3n del modelo</div>' +
      '<h3 class="' + decisionClass + '">' + esc(data.recommendation) + '</h3>' +
      '<div class="muted">' + esc(data.reason) + '</div>' +
      simulateBtnHtml +
    '</div>' +
    confidenceGaugeHtml +
    bbHtml +
    '<div class="section-label">\u{1f4ca} Probabilidades 1X2</div>' +
    '<div class="prob-grid">' +
      '<div class="prob"><span>\u{1f3e0} LOCAL</span><b>' + pct(data.probabilities?.homeWin) + '</b></div>' +
      '<div class="prob"><span>\u{1f91d} EMPATE</span><b>' + pct(data.probabilities?.draw) + '</b></div>' +
      '<div class="prob"><span>\u2708\ufe0f VISITANTE</span><b>' + pct(data.probabilities?.awayWin) + '</b></div>' +
    '</div>' +
    '<div class="section-label">\u26bd xG Esperados (Local\u00eda ' + (data.homeAdvantage?.factor || 1.08) + 'x)</div>' +
    '<div class="xg-grid">' +
      '<div class="xg"><span>LOCAL</span><b>' + (data.xG?.home || '-') + '</b></div>' +
      '<div class="xg"><span>VISITANTE</span><b>' + (data.xG?.away || '-') + '</b></div>' +
      '<div class="xg"><span>TOTAL</span><b>' + (data.xG?.total || '-') + '</b></div>' +
    '</div>' +
    '<div class="section-label">\u23f1\ufe0f Descanso Calculado (Football-Data)</div>' +
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
    '<div class="section-label">\u{1f3af} Marcador M\u00e1s Probable</div>' +
    '<div class="market" style="text-align:center">' +
      '<div style="font-size:32px;font-weight:900">' + esc(data.mostLikelyScore?.score) + '</div>' +
      '<div class="muted">Probabilidad: ' + pct(data.mostLikelyScore?.probability) + '</div>' +
    '</div>' +
    marketsHtml;
}

// ==========================================
// SIMULADOR DE APUESTAS & RENTABILIDAD (LOCALSTORAGE)
// ==========================================
const STORAGE_BETS_KEY = 'mkbets_my_bets_v1';

function getSavedBets() {
  try {
    const raw = localStorage.getItem(STORAGE_BETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveBets(bets) {
  try {
    localStorage.setItem(STORAGE_BETS_KEY, JSON.stringify(bets));
  } catch (e) {}
}

window.saveSimulatedBet = function(home, homeCrest, away, awayCrest, competition, marketName, odds, probability, confidence, confidenceLevel) {
  const bets = getSavedBets();
  const exists = bets.some(function(b){ return b.home === home && b.away === away && b.marketName === marketName && b.status === 'pending'; });
  if (exists) {
    alert('Esta apuesta ya est\u00e1 guardada en Mis apuestas como pendiente.');
    return;
  }
  const dateInput = document.getElementById('date');
  const newBet = {
    id: 'bet_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
    createdAt: new Date().toISOString(),
    matchDate: (dateInput && dateInput.value) || new Date().toISOString().slice(0, 10),
    home: home,
    homeCrest: homeCrest,
    away: away,
    awayCrest: awayCrest,
    competition: competition,
    marketName: marketName,
    odds: Number(odds) || 1.95,
    probability: Number(probability) || 50,
    stakeEur: 10,
    confidence: Number(confidence) || 75,
    confidenceLevel: confidenceLevel || 'Alta',
    status: 'pending',
    profitEur: 0
  };
  bets.unshift(newBet);
  saveBets(bets);
  alert('\u00a1Apuesta guardada en "Mis apuestas"! Puedes ver las m\u00e9tricas de acierto y rentabilidad en la pesta\u00f1a Mis apuestas.');
  renderBetsView();
};

window.settleBet = function(id, status) {
  const bets = getSavedBets();
  const bet = bets.find(function(b){ return b.id === id; });
  if (!bet) return;
  bet.status = status;
  if (status === 'won') {
    bet.profitEur = Number((bet.stakeEur * (bet.odds - 1)).toFixed(2));
  } else if (status === 'lost') {
    bet.profitEur = -bet.stakeEur;
  } else {
    bet.profitEur = 0;
  }
  bet.settledAt = status === 'pending' ? null : new Date().toISOString();
  saveBets(bets);
  renderBetsView();
};

window.deleteBet = function(id) {
  let bets = getSavedBets();
  bets = bets.filter(function(b){ return b.id !== id; });
  saveBets(bets);
  renderBetsView();
};

window.clearAllBets = function() {
  if (confirm('\u00bfDeseas vaciar todas tus apuestas simuladas?')) {
    saveBets([]);
    renderBetsView();
  }
};

window.seedDemoBets = function() {
  const d = new Date();
  const yesterday = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
  const demo = [
    {
      id: 'demo_1',
      createdAt: new Date(d.getTime() - 86400000).toISOString(),
      matchDate: yesterday,
      home: 'Real Madrid',
      homeCrest: 'https://crests.football-data.org/86.png',
      away: 'FC Barcelona',
      awayCrest: 'https://crests.football-data.org/81.png',
      competition: 'LaLiga EA Sports',
      marketName: 'Gana local',
      odds: 1.95,
      probability: 58.4,
      stakeEur: 10,
      confidence: 82,
      confidenceLevel: 'Alta',
      status: 'won',
      profitEur: 9.50,
      settledAt: new Date().toISOString()
    },
    {
      id: 'demo_2',
      createdAt: new Date(d.getTime() - 172800000).toISOString(),
      matchDate: new Date(d.getTime() - 172800000).toISOString().slice(0, 10),
      home: 'Arsenal FC',
      homeCrest: 'https://crests.football-data.org/57.png',
      away: 'Chelsea FC',
      awayCrest: 'https://crests.football-data.org/61.png',
      competition: 'Premier League',
      marketName: 'Over 2.5',
      odds: 1.92,
      probability: 56.2,
      stakeEur: 10,
      confidence: 76,
      confidenceLevel: 'Alta',
      status: 'won',
      profitEur: 9.20,
      settledAt: new Date().toISOString()
    },
    {
      id: 'demo_3',
      createdAt: new Date(d.getTime() - 259200000).toISOString(),
      matchDate: new Date(d.getTime() - 259200000).toISOString().slice(0, 10),
      home: 'Inter de Mil\u00e1n',
      homeCrest: 'https://crests.football-data.org/108.png',
      away: 'Juventus FC',
      awayCrest: 'https://crests.football-data.org/109.png',
      competition: 'Serie A',
      marketName: 'Gana local',
      odds: 2.10,
      probability: 49.0,
      stakeEur: 10,
      confidence: 65,
      confidenceLevel: 'Media',
      status: 'lost',
      profitEur: -10.00,
      settledAt: new Date().toISOString()
    },
    {
      id: 'demo_4',
      createdAt: new Date().toISOString(),
      matchDate: new Date().toISOString().slice(0, 10),
      home: 'Manchester City',
      homeCrest: 'https://crests.football-data.org/65.png',
      away: 'Liverpool FC',
      awayCrest: 'https://crests.football-data.org/64.png',
      competition: 'Premier League',
      marketName: 'Gana local',
      odds: 1.88,
      probability: 60.5,
      stakeEur: 10,
      confidence: 84,
      confidenceLevel: 'Alta',
      status: 'pending',
      profitEur: 0
    }
  ];
  saveBets(demo);
  renderBetsView();
};

let currentBetsFilter = 'all';

function renderBetsView() {
  const container = document.getElementById('betsList');
  const statsContainer = document.getElementById('betsStatsGrid');
  if (!container || !statsContainer) return;

  const bets = getSavedBets();
  const resolved = bets.filter(function(b){ return b.status === 'won' || b.status === 'lost'; });
  const won = bets.filter(function(b){ return b.status === 'won'; }).length;
  const lost = bets.filter(function(b){ return b.status === 'lost'; }).length;
  const pending = bets.filter(function(b){ return b.status === 'pending'; }).length;

  const accuracy = resolved.length > 0 ? ((won / resolved.length) * 100).toFixed(1) + '%' : '\u2014';
  const totalProfit = resolved.reduce(function(acc, b){ return acc + (b.profitEur || 0); }, 0);
  const totalStaked = resolved.reduce(function(acc, b){ return acc + (b.stakeEur || 10); }, 0);
  const roi = totalStaked > 0 ? ((totalProfit / totalStaked) * 100).toFixed(1) + '%' : '\u2014';

  let streakCount = 0;
  let streakType = null;
  for (let i = 0; i < resolved.length; i++) {
    const b = resolved[i];
    if (streakType === null) {
      streakType = b.status;
      streakCount = 1;
    } else if (b.status === streakType) {
      streakCount++;
    } else {
      break;
    }
  }

  const profitColor = totalProfit > 0 ? '#7ee787' : totalProfit < 0 ? '#ff7b72' : 'white';
  const profitSign = totalProfit > 0 ? '+' : '';
  const streakText = streakType === 'won' ? ('\u{1f525} ' + streakCount + 'G') : streakType === 'lost' ? ('\u2744\ufe0f ' + streakCount + 'P') : (pending + ' pend.');
  const streakColor = streakType === 'won' ? '#7ee787' : streakType === 'lost' ? '#ff7b72' : '#ffb45d';

  statsContainer.innerHTML =
    '<div style="background:#090d13;border:1px solid #202938;border-radius:10px;padding:8px 4px;text-align:center">' +
      '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">Acierto</div>' +
      '<div style="font-size:16px;font-weight:900;color:white;margin:2px 0">' + accuracy + '</div>' +
      '<div style="font-size:9px;color:#9da5b2">' + won + 'G / ' + lost + 'P</div>' +
    '</div>' +
    '<div style="background:#090d13;border:1px solid #202938;border-radius:10px;padding:8px 4px;text-align:center">' +
      '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">Beneficio</div>' +
      '<div style="font-size:16px;font-weight:900;color:' + profitColor + ';margin:2px 0">' + profitSign + totalProfit.toFixed(2) + '\u20ac</div>' +
      '<div style="font-size:9px;color:#9da5b2">10\u20ac stake</div>' +
    '</div>' +
    '<div style="background:#090d13;border:1px solid #202938;border-radius:10px;padding:8px 4px;text-align:center">' +
      '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">ROI</div>' +
      '<div style="font-size:16px;font-weight:900;color:' + profitColor + ';margin:2px 0">' + roi + '</div>' +
      '<div style="font-size:9px;color:#9da5b2">Rendimiento</div>' +
    '</div>' +
    '<div style="background:#090d13;border:1px solid #202938;border-radius:10px;padding:8px 4px;text-align:center">' +
      '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">Racha</div>' +
      '<div style="font-size:15px;font-weight:900;color:' + streakColor + ';margin:2px 0">' + streakText + '</div>' +
      '<div style="font-size:9px;color:#9da5b2">' + pending + ' en juego</div>' +
    '</div>';

  const filtered = bets.filter(function(b){
    if (currentBetsFilter === 'all') return true;
    return b.status === currentBetsFilter;
  });

  if (filtered.length === 0) {
    container.innerHTML =
      '<div class="empty" style="padding:24px 10px;border:1px dashed #283344;border-radius:12px">' +
        '<div style="font-size:28px;margin-bottom:6px">\u{1f4ca}</div>' +
        '<div style="font-weight:bold;color:white;margin-bottom:4px">No hay apuestas en esta vista</div>' +
        '<div style="font-size:11px;color:#8e97a5;margin-bottom:12px">Abre cualquier partido en "Analyst" y haz clic en "\u{1f4cc} Simular esta apuesta" para medir los resultados.</div>' +
        '<button type="button" class="league-chip active" onclick="seedDemoBets()">+ Cargar 4 apuestas de ejemplo</button>' +
      '</div>';
    return;
  }

  container.innerHTML = filtered.map(function(b){
    const isWon = b.status === 'won';
    const isLost = b.status === 'lost';
    const isPending = b.status === 'pending';

    let badgeHtml = '';
    if (isPending) {
      badgeHtml = '<span style="font-size:10px;font-weight:800;color:#ffb45d;background:#282114;border:1px solid #ffb45d55;padding:2px 8px;border-radius:12px">\u23f3 Pendiente</span>';
    } else if (isWon) {
      badgeHtml = '<span style="font-size:10px;font-weight:800;color:#7ee787;background:#0d2a1b;border:1px solid #1d5b38;padding:2px 8px;border-radius:12px">\u2705 Gan\u00f3 (+' + b.profitEur.toFixed(2) + '\u20ac)</span>';
    } else if (isLost) {
      badgeHtml = '<span style="font-size:10px;font-weight:800;color:#ff7b72;background:#2a1314;border:1px solid #5d2225;padding:2px 8px;border-radius:12px">\u274c Perdi\u00f3 (' + b.profitEur.toFixed(2) + '\u20ac)</span>';
    } else {
      badgeHtml = '<span style="font-size:10px;font-weight:800;color:#c7ccd4;background:#1f2633;border:1px solid #37455d;padding:2px 8px;border-radius:12px">\u2796 Anulada</span>';
    }

    const wonAmount = (b.stakeEur * (b.odds - 1)).toFixed(2);
    const actionsHtml = isPending ?
      '<div style="display:flex;gap:6px">' +
        '<button type="button" onclick="settleBet(\'' + b.id + '\', \'won\')" style="background:#103320;color:#7ee787;border:1px solid #22633d;border-radius:8px;padding:6px 10px;font-weight:900;font-size:11px;cursor:pointer">\u2705 Gan\u00f3 (+' + wonAmount + '\u20ac)</button>' +
        '<button type="button" onclick="settleBet(\'' + b.id + '\', \'lost\')" style="background:#2e1315;color:#ff7b72;border:1px solid #5d2327;border-radius:8px;padding:6px 10px;font-weight:900;font-size:11px;cursor:pointer">\u274c Perdi\u00f3 (-' + b.stakeEur + '\u20ac)</button>' +
        '<button type="button" onclick="settleBet(\'' + b.id + '\', \'void\')" style="background:#1b2330;color:#9da5b2;border:1px solid #2a374c;border-radius:8px;padding:6px 8px;font-size:11px;cursor:pointer" title="Anular">\u2796</button>' +
      '</div>' :
      '<div>' +
        '<button type="button" onclick="settleBet(\'' + b.id + '\', \'pending\')" style="background:transparent;border:0;color:#8e97a5;text-decoration:underline;font-size:11px;cursor:pointer">Modificar resultado</button>' +
      '</div>';

    return '<div style="background:#0b0f16;border:1px solid #202b3a;border-radius:12px;padding:12px;margin-bottom:8px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#8e97a5;margin-bottom:6px">' +
        '<span>\u{1f3c6} ' + esc(b.competition || '') + ' \u2022 \u{1f4c5} ' + esc(b.matchDate || '') + '</span>' +
        badgeHtml +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
        '<div style="font-size:13px;font-weight:bold;color:white;display:flex;align-items:center;gap:6px">' +
          '<span>' + esc(b.home) + '</span>' +
          '<span style="color:#8e97a5;font-size:10px">vs</span>' +
          '<span>' + esc(b.away) + '</span>' +
        '</div>' +
        '<button type="button" onclick="deleteBet(\'' + b.id + '\')" style="background:transparent;border:0;color:#64748b;font-size:12px;cursor:pointer" title="Eliminar">\u{1f5d1}\ufe0f</button>' +
      '</div>' +
      '<div style="background:#121824;border:1px solid #212d40;border-radius:10px;padding:10px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">' +
        '<div>' +
          '<div style="font-size:9px;color:#8e97a5;text-transform:uppercase;font-weight:bold">Pron\u00f3stico Simulado</div>' +
          '<div style="font-size:13px;font-weight:900;color:white">' + esc(b.marketName) + ' <span style="color:#ffb45d;font-size:11px">@' + Number(b.odds).toFixed(2) + '</span></div>' +
          '<div style="font-size:10px;color:#9da5b2">Confianza: ' + esc(b.confidenceLevel || 'Alta') + ' (' + b.confidence + '%) \u2022 Stake: ' + b.stakeEur + '\u20ac</div>' +
        '</div>' +
        actionsHtml +
      '</div>' +
    '</div>';
  }).join('');
}

// INICIALIZACI\u00d3N
document.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById('date');
  if (dateInput) dateInput.value = localDateValue();

  document.getElementById('searchBtn')?.addEventListener('click', searchFixtures);

  const chips = document.querySelectorAll('#leagueChips .league-chip');
  chips.forEach(c => {
    c.addEventListener('click', () => {
      chips.forEach(x => x.classList.remove('active'));
      c.classList.add('active');
      selectedCompetition = c.dataset.competition || '';
      searchFixtures();
    });
  });

  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-panel]');
    if (btn) {
      openAnalysis(btn.dataset.panel, btn.dataset.home, btn.dataset.away, btn.dataset.date);
    }
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) {
      document.getElementById(closeBtn.dataset.close)?.classList.remove('open');
    }
  });

  function showTab(name) {
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

    if (name === 'bets') {
      renderBetsView();
    }
  }

  document.getElementById('navHome')?.addEventListener('click', () => showTab('home'));
  document.getElementById('navAnalyst')?.addEventListener('click', () => {
    showTab('analyst');
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

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`MK Bets ${MODEL_VERSION} running on port ${PORT} (0.0.0.0)`);
  await ensureSchema();
});
