const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const {
  matchModel,
  implied,
  ev,
  confidence,
  shrinkToMean,
  clamp
} = require('./engine');

const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

/* =========================================================
   ACCESO PRIVADO (usuario/contraseña)
   Se activa solo si defines APP_USERNAME y APP_PASSWORD en
   las variables de entorno de Render. Sin esas variables,
   la app queda igual que antes (sin login) para no romper
   nada si aún no las configuras.
========================================================= */

const APP_USERNAME = process.env.APP_USERNAME || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));

  if (bufA.length !== bufB.length) {
    // igual se compara para no filtrar la longitud por tiempo de respuesta
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

if (APP_USERNAME && APP_PASSWORD) {

  app.use((req, res, next) => {

    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');

    if (scheme === 'Basic' && encoded) {

      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separatorIndex = decoded.indexOf(':');

      const user = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
      const pass = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

      if (
        timingSafeEqual(user, APP_USERNAME) &&
        timingSafeEqual(pass, APP_PASSWORD)
      ) {
        return next();
      }
    }

    res.set('WWW-Authenticate', 'Basic realm="Mi Pronostico Deportivo"');
    return res.status(401).send('Acceso restringido.');
  });

  console.log('[AUTH] Acceso protegido con usuario/contraseña activado.');

} else {
  console.log('[AUTH] APP_USERNAME/APP_PASSWORD no configuradas: la app queda sin login.');
}

const MODEL_VERSION = 'V7.13.0';

const FOOTBALL_DATA_BASE =
  'https://api.football-data.org/v4';

const ODDS_BASE =
  'https://api.the-odds-api.com/v4';

const FOOTBALL_DATA_TOKEN =
  process.env.FOOTBALL_DATA_TOKEN;

const ODDS_API_KEY =
  process.env.ODDS_API_KEY;

const BIGBALLS_KEY =
  process.env.BIGBALLS_KEY || '';

const BIGBALLS_LEAGUE_MAP = {
  PD: 'laliga',
  PL: 'epl',
  FL1: 'ligue1',
  SA: 'serie_a',
  BL1: 'bundesliga',
  CL: 'cl'
};

const CACHE_MINUTES = 1440; // 24 horas — conserva la cuota de The Odds API

const STAKE_EUR = Number(process.env.STAKE_EUR) || 10;

const DATABASE_URL = process.env.DATABASE_URL || '';

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function ensureSchema() {
  if (!pool) {
    console.warn(
      '[DB] DATABASE_URL no configurada. El simulador de apuestas no funcionará hasta que la configures.'
    );
    return;
  }

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
    console.error('[DB] Error creando el esquema:', error.message);
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

const COMPETITIONS = Object.keys(
  ODDS_SPORT_BY_COMPETITION
);

const cache = new Map();

/* =========================================================
   CACHE
========================================================= */

function cacheGet(key) {
  const item = cache.get(key);

  if (!item) {
    return null;
  }

  if (
    Date.now() - item.time >
    CACHE_MINUTES * 60 * 1000
  ) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function cacheSet(key, data) {
  cache.set(key, {
    time: Date.now(),
    data
  });

  return data;
}

function cacheSetIfNotEmpty(key, data) {
  if (
    Array.isArray(data) &&
    data.length === 0
  ) {
    return data;
  }

  return cacheSet(key, data);
}

/* =========================================================
   UTILIDADES
========================================================= */

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

/*
 * Convierte un nombre en su lista de palabras significativas
 * (sin acentos, sin siglas genéricas tipo "FC"/"CF"/"Club").
 * Esto es lo que compara namesMatch(), en vez de la cadena completa.
 */
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
    if (token === word) {
      return true;
    }

    if (
      word.length >= 4 &&
      token.length >= 4 &&
      (token.includes(word) || word.includes(token))
    ) {
      return true;
    }
  }

  return false;
}

/*
 * The Odds API entrega nombres cortos ("Nice", "Metz", "Lyon")
 * mientras que Football-Data usa nombres oficiales largos
 * ("OGC Nice", "FC Metz", "Olympique Lyonnais"). La versión anterior
 * de esta función exigía que AMBOS nombres tuvieran 7+ caracteres
 * para permitir coincidencia parcial, lo que hacía fallar
 * sistemáticamente cualquier nombre corto de club real.
 *
 * Ahora: se toma el lado con menos palabras significativas como la
 * "forma corta", y se exige que TODAS sus palabras aparezcan en el
 * otro lado (exactas o como subcadena de al menos 4 letras). Esto
 * evita falsos positivos como "Real Madrid" vs "Real Sociedad"
 * (que antes NO ocurrían, pero un enfoque más simple sí los genera).
 */
function namesMatch(a, b) {
  const fullA = normalizeName(a);
  const fullB = normalizeName(b);

  if (!fullA || !fullB || fullA.length < 3 || fullB.length < 3) {
    return false;
  }

  if (fullA === fullB) {
    return true;
  }

  const tokensA = nameTokens(a);
  const tokensB = nameTokens(b);

  if (!tokensA.length || !tokensB.length) {
    return false;
  }

  const [shortSide, longSide] =
    tokensA.length <= tokensB.length
      ? [tokensA, tokensB]
      : [tokensB, tokensA];

  return shortSide.every(word => tokenFoundIn(word, longSide));
}

/* =========================================================
   LESIONADOS (Big Balls Sports Data)
   Ajusta la fuerza de ataque/defensa de un equipo según
   cuántos jugadores tiene reportados como lesionados.
   Gratis en su plan free; si falla o no hay key, simplemente
   no se aplica ningún ajuste (no rompe el análisis).
========================================================= */

async function bigBallsRequest(path) {
  if (!BIGBALLS_KEY) {
    return null;
  }

  const key = `bigballs:${path}`;

  const cached = cacheGet(key);

  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(
      `https://api.bigballsdata.com${path}`,
      {
        headers: {
          'Authorization': `Bearer ${BIGBALLS_KEY}`
        }
      }
    );

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

async function getInjuryCountForTeam(teamName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];

  if (!bbLeagueKey || !BIGBALLS_KEY) {
    return 0;
  }

  try {
    const [teams, injuries] = await Promise.all([
      getBigBallsTeams(bbLeagueKey),
      getBigBallsInjuries(bbLeagueKey)
    ]);

    const matchedTeam = teams.find(t => namesMatch(t?.name, teamName));

    if (!matchedTeam?.id) {
      return 0;
    }

    return injuries.filter(
      inj => inj?.current_team_id === matchedTeam.id
    ).length;

  } catch (error) {
    console.warn('[BIGBALLS INJURIES]', teamName, error.message);
    return 0;
  }
}

/*
 * Descuento moderado: -3% de fuerza (ataque y defensa) por cada
 * jugador lesionado reportado, con un tope de -15% para no
 * castigar de más a equipos con plantillas largas.
 */
async function applyInjuryAdjustment(homeStats, awayStats, homeName, awayName, competitionCode) {
  try {
    const [homeInjuries, awayInjuries] = await Promise.all([
      getInjuryCountForTeam(homeName, competitionCode),
      getInjuryCountForTeam(awayName, competitionCode)
    ]);

    const homeFactor = clamp(1 - homeInjuries * 0.03, 0.85, 1);
    const awayFactor = clamp(1 - awayInjuries * 0.03, 0.85, 1);

    if (homeInjuries || awayInjuries) {
      console.log(
        `[INJURIES] ${homeName}: ${homeInjuries} lesionados (factor ${homeFactor.toFixed(2)}) | ${awayName}: ${awayInjuries} lesionados (factor ${awayFactor.toFixed(2)})`
      );
    }

    return {
      homeStats: {
        ...homeStats,
        attackStrength: homeStats.attackStrength * homeFactor,
        defenseStrength: homeStats.defenseStrength * homeFactor
      },
      awayStats: {
        ...awayStats,
        attackStrength: awayStats.attackStrength * awayFactor,
        defenseStrength: awayStats.defenseStrength * awayFactor
      },
      homeInjuries,
      awayInjuries
    };

  } catch (error) {
    console.warn('[INJURIES] ajuste fallback (sin cambios):', error.message);
    return { homeStats, awayStats, homeInjuries: 0, awayInjuries: 0 };
  }
}

async function getBigBallsTeamId(teamName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];

  if (!bbLeagueKey || !BIGBALLS_KEY) {
    return null;
  }

  try {
    const teams = await getBigBallsTeams(bbLeagueKey);
    const matchedTeam = teams.find(t => namesMatch(t?.name, teamName));
    return matchedTeam?.id || null;
  } catch (error) {
    console.warn('[BIGBALLS TEAM ID]', teamName, error.message);
    return null;
  }
}

/*
 * DESCANSO / CALENDARIO CONGESTIONADO
 * Si un equipo jugó hace muy poco (ej. partido europeo entre
 * semana), suele rendir algo peor. Ajuste pequeño y con tope,
 * y si la respuesta de la API no trae el campo esperado,
 * simplemente no se aplica nada (nunca rompe el análisis).
 */
async function getRestDays(teamId) {
  if (!teamId || !BIGBALLS_KEY) {
    return null;
  }

  try {
    const data = await bigBallsRequest(`/v1/teams/${teamId}/schedule-context`);

    const context = data?.data || data;

    const restDays =
      Number(
        context?.rest_days ??
        context?.restDays ??
        context?.days_since_last_match ??
        context?.daysSinceLastMatch
      );

    return Number.isFinite(restDays) ? restDays : null;

  } catch (error) {
    console.warn('[BIGBALLS SCHEDULE]', teamId, error.message);
    return null;
  }
}

async function applyRestAdjustment(homeStats, awayStats, homeTeamId, awayTeamId) {
  try {
    const [homeRest, awayRest] = await Promise.all([
      getRestDays(homeTeamId),
      getRestDays(awayTeamId)
    ]);

    // Menos de 4 días de descanso -> pequeña penalización (tope 8%)
    const restFactor = (rest) => {
      if (rest == null) return 1;
      if (rest >= 4) return 1;
      return clamp(1 - (4 - rest) * 0.025, 0.92, 1);
    };

    const homeFactor = restFactor(homeRest);
    const awayFactor = restFactor(awayRest);

    if (homeFactor < 1 || awayFactor < 1) {
      console.log(
        `[REST] local descanso=${homeRest}d (factor ${homeFactor.toFixed(2)}) | visitante descanso=${awayRest}d (factor ${awayFactor.toFixed(2)})`
      );
    }

    return {
      homeStats: {
        ...homeStats,
        attackStrength: homeStats.attackStrength * homeFactor,
        defenseStrength: homeStats.defenseStrength * homeFactor
      },
      awayStats: {
        ...awayStats,
        attackStrength: awayStats.attackStrength * awayFactor,
        defenseStrength: awayStats.defenseStrength * awayFactor
      }
    };

  } catch (error) {
    console.warn('[REST] ajuste fallback (sin cambios):', error.message);
    return { homeStats, awayStats };
  }
}

/*
 * HISTORIAL CARA A CARA (H2H)
 * Si dos equipos históricamente empatan mucho entre sí, se
 * sube un poco la probabilidad de empate del modelo (tope
 * pequeño, 3 puntos porcentuales) y se reparte esa resta
 * proporcionalmente entre local/visitante. Si la API no trae
 * lo esperado, no se aplica ningún ajuste.
 */
async function getH2HDrawRate(homeTeamId, awayTeamId) {
  if (!homeTeamId || !awayTeamId || !BIGBALLS_KEY) {
    return null;
  }

  try {
    const data = await bigBallsRequest(
      `/v1/teams/${homeTeamId}/h2h-intelligence?opponent=${awayTeamId}`
    );

    const context = data?.data || data;

    const draws =
      Number(context?.draws ?? context?.draw_count);

    const totalMatches =
      Number(context?.matches ?? context?.total_matches ?? context?.games_played);

    if (
      Number.isFinite(draws) &&
      Number.isFinite(totalMatches) &&
      totalMatches >= 3
    ) {
      return draws / totalMatches;
    }

    return null;

  } catch (error) {
    console.warn('[BIGBALLS H2H]', homeTeamId, awayTeamId, error.message);
    return null;
  }
}

function applyH2HAdjustment(model, h2hDrawRate) {
  if (h2hDrawRate == null || !Number.isFinite(h2hDrawRate)) {
    return model;
  }

  // Solo actúa si el histórico empata claramente más que el modelo,
  // y con un tope de 3 puntos porcentuales para no distorsionar el modelo.
  const bump = clamp((h2hDrawRate - model.draw) * 0.3, 0, 0.03);

  if (bump <= 0) {
    return model;
  }

  console.log(`[H2H] empates históricos ${(h2hDrawRate * 100).toFixed(0)}% -> ajuste +${(bump * 100).toFixed(1)}pp a empate`);

  const totalOthers = model.homeWin + model.awayWin;

  if (totalOthers <= 0) {
    return model;
  }

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
  const nums = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!nums.length) {
    return null;
  }

  const middle =
    Math.floor(nums.length / 2);

  return nums.length % 2
    ? nums[middle]
    : (
        nums[middle - 1] +
        nums[middle]
      ) / 2;
}

function uniqueNumbers(values) {
  return [
    ...new Set(
      values
        .map(Number)
        .filter(Number.isFinite)
        .map(v =>
          Number(v.toFixed(4))
        )
    )
  ];
}

function dateFromISO(value) {
  if (!value) {
    return null;
  }

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date;
}

function datePartUTC(value) {
  const date =
    dateFromISO(value);

  if (!date) {
    return null;
  }

  return date
    .toISOString()
    .slice(0, 10);
}

/* =========================================================
   HTTP
========================================================= */

async function fetchJson(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      options
    );

  let data = null;

  try {
    data =
      await response.json();
  } catch (_) {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      data?.errors?.message ||
      `HTTP ${response.status}`;

    const error =
      new Error(message);

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }

  return data;
}

/* =========================================================
   FOOTBALL-DATA
========================================================= */

async function footballData(path) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error(
      'FOOTBALL_DATA_TOKEN no configurado'
    );
  }

  const key =
    `football:${path}`;

  const cached =
    cacheGet(key);

  if (cached) {
    return cached;
  }

  console.log(
    `[FOOTBALL-DATA] ${path}`
  );

  const data =
    await fetchJson(
      `${FOOTBALL_DATA_BASE}${path}`,
      {
        headers: {
          'X-Auth-Token':
            FOOTBALL_DATA_TOKEN
        }
      }
    );

  return cacheSet(
    key,
    data
  );
}

/* =========================================================
   EQUIPOS
========================================================= */

async function getCompetitionTeams(
  competitionCode
) {
  const key =
    `competition-teams:${competitionCode}`;

  const cached =
    cacheGet(key);

  if (cached) {
    return cached;
  }

  try {
    console.log(
      `[TEAMS] buscando equipos ${competitionCode}`
    );

    const data =
      await footballData(
        `/competitions/${competitionCode}/teams`
      );

    const teams =
      Array.isArray(
        data?.teams
      )
        ? data.teams
        : [];

    console.log(
      `[TEAMS] ${competitionCode}: ${teams.length} equipos`
    );

    return cacheSetIfNotEmpty(
      key,
      teams
    );

  } catch (error) {
    console.error(
      `[TEAMS ERROR] ${competitionCode}:`,
      error.message
    );

    return [];
  }
}

async function findTeamId(
  teamName,
  competitionCode
) {
  if (
    !teamName ||
    !competitionCode
  ) {
    return null;
  }

  const teams =
    await getCompetitionTeams(
      competitionCode
    );

  if (!teams.length) {
    console.log(
      `[TEAM ID] No hay equipos disponibles para ${competitionCode}`
    );

    return null;
  }

  const normalizedTarget =
    normalizeName(
      teamName
    );

  const exact =
    teams.find(
      team =>
        normalizeName(
          team?.name
        ) === normalizedTarget
    );

  if (exact?.id) {
    console.log(
      `[TEAM ID] ${teamName} -> ${exact.id} (${exact.name})`
    );

    return exact.id;
  }

  const partial =
    teams.find(
      team =>
        namesMatch(
          team?.name,
          teamName
        )
    );

  if (partial?.id) {
    console.log(
      `[TEAM ID] coincidencia parcial ${teamName} -> ${partial.id} (${partial.name})`
    );

    return partial.id;
  }

  console.log(
    `[TEAM ID] No encontrado: ${teamName} en ${competitionCode}`
  );

  return null;
}

/* =========================================================
   PARTIDOS RECIENTES
========================================================= */

async function getTeamRecentMatches(
  teamId
) {
  if (!teamId) {
    return [];
  }

  const key =
    `team:${teamId}:recent`;

  const cached =
    cacheGet(key);

  if (cached) {
    return cached;
  }

  try {
    console.log(
      `[RECENT] equipo ${teamId}`
    );

    const data =
      await footballData(
        `/teams/${teamId}/matches?status=FINISHED&limit=20`
      );

    const matches =
      Array.isArray(
        data?.matches
      )
        ? data.matches
        : [];

    console.log(
      `[RECENT] equipo ${teamId}: ${matches.length} partidos`
    );

    return cacheSetIfNotEmpty(
      key,
      matches
    );

  } catch (error) {
    console.error(
      `[RECENT ERROR] equipo ${teamId}:`,
      error.message
    );

    return [];
  }
}

/* =========================================================
   ESTADÍSTICAS
========================================================= */

function calculateRecentTeamStats(
  teamId,
  matches
) {
  const relevant =
    matches
      .filter(
        match =>
          match?.homeTeam?.id === teamId ||
          match?.awayTeam?.id === teamId
      )
      .sort(
        (a, b) =>
          new Date(b.utcDate) -
          new Date(a.utcDate)
      )
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

  let goalsFor = 0;
  let goalsAgainst = 0;
  let points = 0;

  /*
   * PONDERACIÓN POR ANTIGÜEDAD:
   * el partido más reciente (índice 0, ya viene ordenado
   * descendente por fecha) pesa más que el más viejo.
   * Con 10 partidos: pesos 10,9,8...1. El promedio ponderado
   * reacciona más rápido a la forma actual que un promedio plano.
   */
  const n = relevant.length;
  let weightedGoalsFor = 0;
  let weightedGoalsAgainst = 0;
  let weightedPoints = 0;
  let totalWeight = 0;

  relevant.forEach((match, index) => {

    const weight = n - index;
    totalWeight += weight;

    const home =
      Number(
        match?.score?.fullTime?.home ?? 0
      );

    const away =
      Number(
        match?.score?.fullTime?.away ?? 0
      );

    const isHome =
      match?.homeTeam?.id === teamId;

    const gf =
      isHome
        ? home
        : away;

    const ga =
      isHome
        ? away
        : home;

    goalsFor += gf;
    goalsAgainst += ga;

    weightedGoalsFor += gf * weight;
    weightedGoalsAgainst += ga * weight;

    if (gf > ga) {
      points += 3;
      weightedPoints += 3 * weight;
    } else if (gf === ga) {
      points += 1;
      weightedPoints += 1 * weight;
    }
  });

  const avgGoalsFor =
    weightedGoalsFor /
    totalWeight;

  const avgGoalsAgainst =
    weightedGoalsAgainst /
    totalWeight;

  return {
    matches:
      relevant.length,

    goalsFor,

    goalsAgainst,

    avgGoalsFor,

    avgGoalsAgainst,

    attackStrength:
      Math.max(
        0.45,
        Math.min(
          1.8,
          avgGoalsFor / 1.35
        )
      ),

    defenseStrength:
      Math.max(
        0.45,
        Math.min(
          1.8,
          1.35 /
          Math.max(
            avgGoalsAgainst,
            0.25
          )
        )
      ),

    formPoints:
      points,

    formPct:
      (
        weightedPoints /
        (
          totalWeight *
          3
        )
      ) * 100
  };
}

/* =========================================================
   FIXTURES — FOOTBALL DATA
========================================================= */

async function getFixturesFootballData(
  date
) {
  console.log(
    `[FIXTURES FD] buscando ${date}`
  );

  try {
    const data =
      await footballData(
        `/matches?dateFrom=${date}&dateTo=${date}`
      );

    const matches =
      Array.isArray(
        data?.matches
      )
        ? data.matches
        : [];

    const filtered =
      matches.filter(
        match =>
          ODDS_SPORT_BY_COMPETITION[
            match?.competition?.code
          ]
      );

    console.log(
      `[FIXTURES FD] ${date}: ${filtered.length} partidos`
    );

    return filtered.map(
      match => ({
        ...match,

        competitionCode:
          match?.competition?.code ||
          null,

        competitionName:
          match?.competition?.name ||
          match?.competition?.code ||
          null,

        source:
          'football-data'
      })
    );

  } catch (error) {
    console.error(
      `[FIXTURES FD ERROR] ${date}:`,
      error.message
    );

    return [];
  }
}

/* =========================================================
   ODDS API
========================================================= */

async function getOddsEvents(
  competitionCode
) {
  if (!ODDS_API_KEY) {
    return [];
  }

  const sport =
    ODDS_SPORT_BY_COMPETITION[
      competitionCode
    ];

  if (!sport) {
    return [];
  }

  const key =
    `odds-events:${sport}`;

  const cached =
    cacheGet(key);

  if (cached) {
    return cached;
  }

  try {
    console.log(
      `[ODDS EVENTS] ${sport}`
    );

    const url =
      `${ODDS_BASE}/sports/${sport}/odds` +
      `?regions=us,uk,eu` +
      `&markets=h2h,totals` +
      `&oddsFormat=decimal` +
      `&apiKey=${encodeURIComponent(
        ODDS_API_KEY
      )}`;

    const data =
      await fetchJson(
        url
      );

    const events =
      Array.isArray(data)
        ? data
        : [];

    console.log(
      `[ODDS EVENTS] ${sport}: ${events.length} eventos`
    );

    return cacheSetIfNotEmpty(
      key,
      events
    );

  } catch (error) {
    console.error(
      `[ODDS EVENTS ERROR] ${sport}:`,
      error.message
    );

    return [];
  }
}

async function getFixturesOdds(
  date,
  competitionFilter
) {
  if (!ODDS_API_KEY) {
    console.log(
      '[FIXTURES ODDS] ODDS_API_KEY no configurada'
    );

    return [];
  }

  console.log(
    `[FIXTURES ODDS] buscando ${date} (liga=${competitionFilter || 'TODAS'})`
  );

  const all = [];

  const competitionsToQuery =
    competitionFilter && COMPETITIONS.includes(competitionFilter)
      ? [competitionFilter]
      : COMPETITIONS;

  for (
    const competitionCode of
    competitionsToQuery
  ) {
    const events =
      await getOddsEvents(
        competitionCode
      );

    for (
      const event of events
    ) {
      if (
        !event?.home_team ||
        !event?.away_team ||
        !event?.commence_time
      ) {
        continue;
      }

      const eventDate =
        datePartUTC(
          event.commence_time
        );

      if (
        eventDate !== date
      ) {
        continue;
      }

      all.push({
        id:
          `odds-${event.id || normalizeName(
            event.home_team +
            '-' +
            event.away_team
          )}`,

        homeTeam: {
          id: null,
          name:
            event.home_team
        },

        awayTeam: {
          id: null,
          name:
            event.away_team
        },

        utcDate:
          event.commence_time,

        competition: {
          code:
            competitionCode,

          name:
            competitionName(
              competitionCode
            )
        },

        competitionCode,

        competitionName:
          competitionName(
            competitionCode
          ),

        status:
          'SCHEDULED',

        source:
          'the-odds-api',

        oddsEvent:
          event
      });
    }
  }

  console.log(
    `[FIXTURES ODDS] ${date}: ${all.length} partidos`
  );

  return all;
}

function competitionName(
  code
) {
  const names = {
    PL: 'Premier League',
    PD: 'LaLiga',
    BL1: 'Bundesliga',
    SA: 'Serie A',
    FL1: 'Ligue 1',
    CL: 'Champions League',
    EL: 'Europa League'
  };

  return (
    names[code] ||
    code
  );
}

/* =========================================================
   FIXTURES PRINCIPAL
========================================================= */

async function getFixture(
  date,
  competitionFilter
) {
  const key =
    `fixtures:${date}:${competitionFilter || 'ALL'}`;

  const cached =
    cacheGet(key);

  if (cached) {
    console.log(
      `[FIXTURES] cache ${date} (${competitionFilter || 'TODAS'}): ${cached.length}`
    );

    return cached;
  }

  console.log(
    `[FIXTURES] buscando ${date} (liga=${competitionFilter || 'TODAS'})`
  );

  let matches =
    await getFixturesFootballData(
      date
    );

  if (competitionFilter) {
    matches = matches.filter(
      match => (match.competitionCode || match.competition?.code) === competitionFilter
    );
  }

  if (!matches.length) {
    console.log(
      `[FIXTURES] Football-Data devolvió 0. Activando fallback Odds API.`
    );

    matches =
      await getFixturesOdds(
        date,
        competitionFilter
      );
  }

  matches =
    Array.isArray(matches)
      ? matches
      : [];

  matches.sort(
    (a, b) =>
      new Date(a.utcDate) -
      new Date(b.utcDate)
  );

  /*
   * IMPORTANTE:
   * No guardamos en caché durante 5 minutos
   * un resultado vacío.
   *
   * Así, si la fuente tarda en actualizar,
   * el siguiente intento vuelve a consultar.
   */
  if (matches.length > 0) {
    cacheSet(
      key,
      matches
    );
  }

  console.log(
    `[FIXTURES] ${date}: ${matches.length} partidos finales`
  );

  return matches;
}

/* =========================================================
   BUSCAR EVENTO ODDS API
========================================================= */

function findOddsEvent(
  events,
  homeName,
  awayName
) {
  if (!Array.isArray(events)) {
    return null;
  }

  const direct =
    events.find(
      event =>
        namesMatch(
          event?.home_team,
          homeName
        ) &&
        namesMatch(
          event?.away_team,
          awayName
        )
    );

  if (direct) {
    return {
      event: direct,
      reversed: false
    };
  }

  const reversed =
    events.find(
      event =>
        namesMatch(
          event?.home_team,
          awayName
        ) &&
        namesMatch(
          event?.away_team,
          homeName
        )
    );

  if (reversed) {
    return {
      event: reversed,
      reversed: true
    };
  }

  return null;
}

/* =========================================================
   ODDS DEL PARTIDO
========================================================= */

async function getOdds(
  homeName,
  awayName,
  competitionCode
) {
  if (!ODDS_API_KEY) {
    return {
      available: false,
      reason:
        'ODDS_API_KEY no configurada'
    };
  }

  const sport =
    ODDS_SPORT_BY_COMPETITION[
      competitionCode
    ];

  if (!sport) {
    return {
      available: false,
      reason:
        'Competición no soportada'
    };
  }

  const events =
    await getOddsEvents(
      competitionCode
    );

  const found =
    findOddsEvent(
      events,
      homeName,
      awayName
    );

  if (!found?.event) {
    return {
      available: false,
      reason:
        'Partido no encontrado en The Odds API'
    };
  }

  return {
    available: true,

    eventId:
      found.event.id ||
      null,

    commenceTime:
      found.event.commence_time ||
      null,

    bookmakers:
      Array.isArray(
        found.event.bookmakers
      )
        ? found.event.bookmakers
        : [],

    event:
      found.event,

    reversed:
      Boolean(
        found.reversed
      )
  };
}

/* =========================================================
   MERCADOS
========================================================= */

function collectPrices(
  bookmakers,
  homeName,
  awayName,
  reversed = false
) {
  const result = {
    home: [],
    draw: [],
    away: [],
    over25: [],
    under25: []
  };

  for (
    const bookmaker of
    bookmakers || []
  ) {
    const bookmakerName =
      bookmaker?.title ||
      bookmaker?.key ||
      'Unknown';

    for (
      const market of
      bookmaker?.markets || []
    ) {

      if (
        market?.key === 'h2h'
      ) {
        for (
          const outcome of
          market.outcomes || []
        ) {
          const price =
            Number(
              outcome?.price
            );

          if (
            !Number.isFinite(price) ||
            price <= 1
          ) {
            continue;
          }

          const outcomeName =
            outcome?.name;

          const isHome =
            namesMatch(
              outcomeName,
              homeName
            );

          const isAway =
            namesMatch(
              outcomeName,
              awayName
            );

          const isDraw =
            [
              'draw',
              'tie',
              'empate'
            ].includes(
              normalizeName(
                outcomeName
              )
            );

          if (isDraw) {
            result.draw.push({
              bookmaker:
                bookmakerName,
              odds:
                price
            });

          } else if (
            !reversed &&
            isHome
          ) {
            result.home.push({
              bookmaker:
                bookmakerName,
              odds:
                price
            });

          } else if (
            !reversed &&
            isAway
          ) {
            result.away.push({
              bookmaker:
                bookmakerName,
              odds:
                price
            });

          } else if (
            reversed &&
            isAway
          ) {
            /*
             * El evento está invertido.
             * La selección visitante del evento
             * corresponde al local solicitado.
             */
            result.home.push({
              bookmaker:
                bookmakerName,
              odds:
                price
            });

          } else if (
            reversed &&
            isHome
          ) {
            /*
             * La selección local del evento
             * corresponde al visitante solicitado.
             */
            result.away.push({
              bookmaker:
                bookmakerName,
              odds:
                price
            });
          }
        }
      }

      if (
        market?.key === 'totals'
      ) {
        for (
          const outcome of
          market.outcomes || []
        ) {
          if (
            Number(
              outcome?.point
            ) !== 2.5
          ) {
            continue;
          }

          const price =
            Number(
              outcome?.price
            );

          if (
            !Number.isFinite(price) ||
            price <= 1
          ) {
            continue;
          }

          const name =
            normalizeName(
              outcome?.name
            );

          if (
            name === 'over'
          ) {
            result.over25.push({
              bookmaker:
                bookmakerName,
              odds:
                price
            });
          }

          if (
            name === 'under'
          ) {
            result.under25.push({
              bookmaker:
                bookmakerName,
              odds:
                price
            });
          }
        }
      }
    }
  }

  return result;
}

function analyzePriceSet(
  prices
) {
  const valid =
    prices
      .filter(
        item =>
          Number.isFinite(
            Number(
              item?.odds
            )
          ) &&
          Number(
            item.odds
          ) > 1
      )
      .map(
        item => ({
          bookmaker:
            item.bookmaker,

          odds:
            Number(
              item.odds
            )
        })
      );

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

  const odds =
    valid
      .map(
        x => x.odds
      )
      .sort(
        (a, b) =>
          a - b
      );

  const referenceOdds =
    median(odds);

  const bestOdds =
    odds[
      odds.length - 1
    ];

  const unique =
    uniqueNumbers(odds)
      .sort(
        (a, b) =>
          b - a
      );

  const secondBestOdds =
    unique.length > 1
      ? unique[1]
      : null;

  const supportCount =
    odds.filter(
      oddsValue =>
        referenceOdds &&
        Math.abs(
          oddsValue -
          referenceOdds
        ) /
        referenceOdds <=
        0.10
    ).length;

  const isOutlier =
    odds.length >= 2 &&
    (
      bestOdds >
      referenceOdds * 1.30 ||
      (
        bestOdds >
        referenceOdds * 1.20 &&
        supportCount < 2
      ) ||
      (
        secondBestOdds !== null &&
        bestOdds >
        secondBestOdds * 1.20
      )
    );

  let marketDepth =
    'low';

  if (
    odds.length >= 6 &&
    supportCount >= 4
  ) {
    marketDepth =
      'strong';

  } else if (
    odds.length >= 3 &&
    supportCount >= 2
  ) {
    marketDepth =
      'medium';
  }

  return {
    bestOdds,

    referenceOdds,

    secondBestOdds,

    bookmakerCount:
      valid.length,

    supportCount,

    isOutlier,

    marketDepth,

    prices:
      valid
  };
}

function marketName(
  type,
  outcome
) {
  if (
    type === 'h2h'
  ) {
    if (
      outcome === 'home'
    ) {
      return 'Gana local';
    }

    if (
      outcome === 'draw'
    ) {
      return 'Empate';
    }

    return 'Gana visitante';
  }

  return outcome === 'over'
    ? 'Over 2.5'
    : 'Under 2.5';
}

function buildMarket(
  type,
  outcome,
  probability,
  prices
) {
  const info =
    analyzePriceSet(
      prices
    );

  const modelProbability =
    Number(
      probability
    );

  const bestEvPct =
    info.bestOdds
      ? ev(
          modelProbability,
          info.bestOdds
        )
      : null;

  const referenceEvPct =
    info.referenceOdds
      ? ev(
          modelProbability,
          info.referenceOdds
        )
      : null;

  const valueEligible =
    info.bookmakerCount >= 2 &&
    info.supportCount >= 2 &&
    !info.isOutlier &&
    Number.isFinite(
      referenceEvPct
    ) &&
    referenceEvPct > 0;

  let valueLevel =
    'Sin valor';

  if (
    info.isOutlier
  ) {
    valueLevel =
      'Precio atípico';

  } else if (
    referenceEvPct >= 10
  ) {
    valueLevel =
      'Valor fuerte';

  } else if (
    referenceEvPct >= 5
  ) {
    valueLevel =
      'Valor';

  } else if (
    referenceEvPct > 0
  ) {
    valueLevel =
      'Valor leve';
  }

  const bestBookmaker =
    info.prices.find(
      item =>
        item.odds ===
        info.bestOdds
    )?.bookmaker ||
    null;

  // Casa de apuestas preferida del usuario (Caliente MX), si
  // llegara a aparecer entre las cuotas consultadas. The Odds API
  // (regiones us/uk/eu/au) normalmente no la incluye, así que esto
  // casi siempre quedará en null — se deja preparado por si acaso.
  const preferredBookmakerPrice =
    info.prices.find(
      item => /caliente/i.test(item.bookmaker || '')
    ) || null;

  return {
    type,

    outcome,

    name:
      marketName(
        type,
        outcome
      ),

    probability:
      Number((modelProbability * 100).toFixed(1)),

    bestOdds:
      info.bestOdds,

    referenceOdds:
      info.referenceOdds,

    secondBestOdds:
      info.secondBestOdds,

    impliedProbability:
      info.bestOdds
        ? implied(
            info.bestOdds
          )
        : null,

    evPct:
      bestEvPct,

    bestEvPct,

    referenceEvPct,

    bookmaker:
      bestBookmaker,

    preferredBookmakerOdds:
      preferredBookmakerPrice?.odds || null,

    bookmakerCount:
      info.bookmakerCount,

    supportCount:
      info.supportCount,

    isOutlier:
      info.isOutlier,

    marketDepth:
      info.marketDepth,

    valueEligible,

    valueLevel
  };
}

function buildMarkets(
  model,
  oddsData,
  homeName,
  awayName
) {
  if (
    !oddsData?.available
  ) {
    return [];
  }

  const prices =
    collectPrices(
      oddsData.bookmakers,
      homeName,
      awayName,
      oddsData.reversed
    );

  return [
    buildMarket(
      'h2h',
      'home',
      model.homeWin,
      prices.home
    ),

    buildMarket(
      'h2h',
      'draw',
      model.draw,
      prices.draw
    ),

    buildMarket(
      'h2h',
      'away',
      model.awayWin,
      prices.away
    ),

    buildMarket(
      'totals',
      'over',
      model.over25,
      prices.over25
    ),

    buildMarket(
      'totals',
      'under',
      model.under25,
      prices.under25
    )
  ];
}

/* =========================================================
   VALUE
========================================================= */

function bestValue(
  markets,
  modelConfidence
) {
  return markets
    .filter(
      market =>
        market.valueEligible &&
        market.bookmakerCount >= 2 &&
        market.supportCount >= 2 &&
        !market.isOutlier &&
        Number(
          market.probability
        ) >= 45 &&
        Number(
          market.referenceEvPct
        ) >= 1 &&
        Number(
          modelConfidence
        ) >= 45
    )
    .sort(
      (a, b) =>
        Number(
          b.referenceEvPct
        ) -
        Number(
          a.referenceEvPct
        )
    )[0] || null;
}

function mostLikelyScore(
  homeXg,
  awayXg
) {
  let best = {
    home: 0,
    away: 0,
    probability: 0
  };

  function poisson(
    k,
    lambda
  ) {
    let factorial = 1;

    for (
      let i = 2;
      i <= k;
      i++
    ) {
      factorial *= i;
    }

    return (
      Math.exp(-lambda) *
      Math.pow(
        lambda,
        k
      ) /
      factorial
    );
  }

  for (
    let home = 0;
    home <= 7;
    home++
  ) {
    for (
      let away = 0;
      away <= 7;
      away++
    ) {
      const probability =
        poisson(
          home,
          Math.max(
            0.01,
            Number(
              homeXg
            )
          )
        ) *
        poisson(
          away,
          Math.max(
            0.01,
            Number(
              awayXg
            )
          )
        );

      if (
        probability >
        best.probability
      ) {
        best = {
          home,
          away,
          probability
        };
      }
    }
  }

  return {
    score:
      `${best.home}-${best.away}`,

    probability:
      Number(
        (
          best.probability *
          100
        ).toFixed(1)
      )
  };
}

/* =========================================================
   MODELO
========================================================= */

function createModelInput(
  homeStats,
  awayStats
) {
  const homeAttack =
    homeStats.avgGoalsFor *
    Math.max(
      0.75,
      Math.min(
        1.35,
        homeStats.attackStrength
      )
    );

  const awayAttack =
    awayStats.avgGoalsFor *
    Math.max(
      0.75,
      Math.min(
        1.35,
        awayStats.attackStrength
      )
    );

  const homeXg =
    (
      homeAttack +
      awayStats.avgGoalsAgainst
    ) /
    2 *
    1.08;

  const awayXg =
    (
      awayAttack +
      homeStats.avgGoalsAgainst
    ) /
    2;

  return {
    homeXg:
      Math.max(
        0.25,
        Math.min(
          3.8,
          homeXg
        )
      ),

    awayXg:
      Math.max(
        0.20,
        Math.min(
          3.5,
          awayXg
        )
      )
  };
}

/* =========================================================
   STATUS
========================================================= */

app.get(
  '/api/status',
  (req, res) => {
    res.set(
      'Cache-Control',
      'no-store'
    );

    res.json({
      ok: true,

      footballDataConfigured:
        Boolean(
          FOOTBALL_DATA_TOKEN
        ),

      oddsApiConfigured:
        Boolean(
          ODDS_API_KEY
        ),

      databaseConfigured:
        Boolean(DATABASE_URL),

      bigBallsConfigured:
        Boolean(BIGBALLS_KEY),

      stakeEur:
        STAKE_EUR,

      provider:
        'football-data.org + The Odds API',

      cacheMinutes:
        CACHE_MINUTES,

      modelVersion:
        MODEL_VERSION
    });
  }
);

/* =========================================================
   API FIXTURES
========================================================= */

app.get(
  '/api/fixtures',
  async (req, res) => {

    const date =
      String(
        req.query.date || ''
      ).trim() ||
      new Date()
        .toISOString()
        .slice(0, 10);

    const competitionFilter =
      String(req.query.competition || '').trim().toUpperCase();

    console.log(
      `[API /api/fixtures] solicitud recibida date=${date} competition=${competitionFilter || 'TODAS'}`
    );

    try {
      const matches =
        await getFixture(
          date,
          competitionFilter
        );

      const fixtures =
        matches
          .filter(
            match =>
              match?.homeTeam?.name &&
              match?.awayTeam?.name
          )
          .filter(
            match =>
              !competitionFilter ||
              (match.competitionCode || match.competition?.code) === competitionFilter
          )
          .sort(
            (a, b) =>
              new Date(
                a.utcDate
              ) -
              new Date(
                b.utcDate
              )
          )
          .map(
            match => ({
              id:
                match.id ||
                null,

              home:
                match.homeTeam.name,

              away:
                match.awayTeam.name,

              kickoff:
                match.utcDate ||
                null,

              competition:
                match.competitionName ||
                match.competition?.name ||
                match.competitionCode ||
                null,

              competitionCode:
                match.competitionCode ||
                match.competition?.code ||
                null,

              status:
                match.status ||
                'SCHEDULED',

              source:
                match.source ||
                'football-data'
            })
          );

      console.log(
        `[API /api/fixtures] respuesta ${fixtures.length} partidos`
      );

      return res.json({
        ok: true,

        modelVersion:
          MODEL_VERSION,

        date,

        count:
          fixtures.length,

        fixtures
      });

    } catch (error) {

      console.error(
        'FIXTURES ERROR:',
        error
      );

      return res
        .status(500)
        .json({
          ok: false,

          error:
            error.message ||
            'Error al cargar los partidos.',

          modelVersion:
            MODEL_VERSION
        });
    }
  }
);

/* =========================================================
   ANÁLISIS REUTILIZABLE (para /api/analyze y /api/parlay)
========================================================= */

async function analyzeOneFixture(fixture) {

  const actualHomeName = fixture.homeTeam?.name;
  const actualAwayName = fixture.awayTeam?.name;

  if (!actualHomeName || !actualAwayName) {
    return null;
  }

  const competitionCode =
    fixture.competitionCode ||
    fixture.competition?.code ||
    null;

  let homeId = fixture.homeTeam?.id || null;
  let awayId = fixture.awayTeam?.id || null;

  if (!homeId && competitionCode) {
    homeId = await findTeamId(actualHomeName, competitionCode);
  }

  if (!awayId && competitionCode) {
    awayId = await findTeamId(actualAwayName, competitionCode);
  }

  if (!homeId || !awayId) {
    return null;
  }

  const [homeMatches, awayMatches] = await Promise.all([
    getTeamRecentMatches(homeId),
    getTeamRecentMatches(awayId)
  ]);

  let homeStats = calculateRecentTeamStats(homeId, homeMatches);
  let awayStats = calculateRecentTeamStats(awayId, awayMatches);

  try {
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

  } catch (error) {
    console.warn('[PARLAY] estabilización fallback:', error.message);
  }

  const injuryAdjusted = await applyInjuryAdjustment(
    homeStats,
    awayStats,
    actualHomeName,
    actualAwayName,
    competitionCode
  );

  homeStats = injuryAdjusted.homeStats;
  awayStats = injuryAdjusted.awayStats;

  const [bbHomeTeamId, bbAwayTeamId] = await Promise.all([
    getBigBallsTeamId(actualHomeName, competitionCode),
    getBigBallsTeamId(actualAwayName, competitionCode)
  ]);

  const restAdjusted = await applyRestAdjustment(
    homeStats,
    awayStats,
    bbHomeTeamId,
    bbAwayTeamId
  );

  homeStats = restAdjusted.homeStats;
  awayStats = restAdjusted.awayStats;

  const modelInput = createModelInput(homeStats, awayStats);
  let model = matchModel(modelInput.homeXg, modelInput.awayXg);

  const h2hDrawRate = await getH2HDrawRate(bbHomeTeamId, bbAwayTeamId);
  model = applyH2HAdjustment(model, h2hDrawRate);

  let modelConfidence = 50;

  try {
    const bestProbability = Math.max(model.homeWin, model.draw, model.awayWin);
    const confidenceSampleSize = Math.min(homeStats.matches, awayStats.matches);

    modelConfidence = confidence(bestProbability, confidenceSampleSize);

  } catch (error) {
    modelConfidence = 50;
  }

  const confidenceAdjusted =
    Math.max(0, Math.min(100, Math.round(Number(modelConfidence) || 50)));

  const odds = await getOdds(actualHomeName, actualAwayName, competitionCode);
  const markets = buildMarkets(model, odds, actualHomeName, actualAwayName);

  return {
    home: actualHomeName,
    away: actualAwayName,
    date: fixture.utcDate ? datePartUTC(fixture.utcDate) : null,
    kickoff: fixture.utcDate || null,
    competition:
      fixture.competitionName ||
      fixture.competition?.name ||
      competitionCode,
    confidence: confidenceAdjusted,
    markets,
    oddsAvailable: Boolean(odds?.available)
  };
}

/*
 * Un "pick fuerte" es un mercado que ya pasa los filtros normales
 * de value bet (probabilidad, EV, respaldo del mercado, confianza).
 *
 * Un "posible error de cuota" es un mercado marcado como isOutlier
 * (una cuota anormalmente alta frente al resto del mercado) donde
 * el modelo, aun así, le da al resultado al menos 50% de probabilidad.
 * Estos NO se usan como value pick individual (por eso el filtro
 * normal los excluye) pero son justo el tipo de "error de cuota"
 * que se busca para combinadas de mayor riesgo/beneficio.
 */
function pickParlayCandidate(analysis) {

  if (!analysis || !analysis.oddsAvailable) {
    return null;
  }

  const candidates = [];

  for (const market of analysis.markets) {

    if (!market.bestOdds) {
      continue;
    }

    const isStrong =
      market.valueEligible &&
      Number(market.referenceEvPct) >= 1.5 &&
      analysis.confidence >= 45;

    const isOddsError =
      market.isOutlier &&
      market.referenceOdds &&
      market.bestOdds > market.referenceOdds * 1.10 &&
      Number(market.probability) >= 35;

    if (isStrong || isOddsError) {
      candidates.push({
        home: analysis.home,
        away: analysis.away,
        competition: analysis.competition,
        date: analysis.date,
        kickoff: analysis.kickoff,
        market: market.type,
        outcome: market.outcome,
        marketName: market.name,
        odds: market.bestOdds,
        probability: market.probability,
        referenceEvPct: market.referenceEvPct,
        confidence: analysis.confidence,
        tag: isOddsError ? 'Posible error de cuota' : 'Pick fuerte'
      });
    }
  }

  if (!candidates.length) {
    return null;
  }

  // Solo un pick por partido (el de mejor EV), para no combinar
  // dos selecciones correlacionadas del mismo encuentro.
  candidates.sort(
    (a, b) => Number(b.referenceEvPct || 0) - Number(a.referenceEvPct || 0)
  );

  return candidates[0];
}

/* =========================================================
   API PARLAY
========================================================= */

app.get(
  '/api/parlay',
  async (req, res) => {

    try {

      const date =
        String(req.query.date || '').trim() ||
        new Date().toISOString().slice(0, 10);

      const maxLegs =
        Math.min(6, Math.max(2, Number(req.query.legs) || 4));

      const competitionFilter =
        String(req.query.competition || '').trim().toUpperCase();

      const fixtures = await getFixture(date, competitionFilter);

      const withNames =
        fixtures
          .filter(
            match => match?.homeTeam?.name && match?.awayTeam?.name
          )
          .filter(
            match =>
              !competitionFilter ||
              (match.competitionCode || match.competition?.code) === competitionFilter
          );

      const candidates = [];

      for (const fixture of withNames) {

        try {
          const analysis = await analyzeOneFixture(fixture);
          const pick = pickParlayCandidate(analysis);

          if (pick) {
            candidates.push(pick);
          }

        } catch (error) {
          console.warn(
            `[PARLAY] fallo analizando ${fixture?.homeTeam?.name} vs ${fixture?.awayTeam?.name}:`,
            error.message
          );
        }
      }

      candidates.sort(
        (a, b) => Number(b.referenceEvPct || 0) - Number(a.referenceEvPct || 0)
      );

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

      for (
        let legsCount = 2;
        legsCount <= Math.min(maxLegs, candidates.length);
        legsCount++
      ) {
        const legs = candidates.slice(0, legsCount);

        const combinedOdds =
          legs.reduce((acc, leg) => acc * Number(leg.odds), 1);

        const combinedProbability =
          legs.reduce((acc, leg) => acc * (Number(leg.probability) / 100), 1);

        const combinedEvPct =
          Number(((combinedProbability * combinedOdds - 1) * 100).toFixed(1));

        parlays.push({
          legsCount,
          legs,
          combinedOdds: Number(combinedOdds.toFixed(2)),
          combinedProbabilityPct: Number((combinedProbability * 100).toFixed(1)),
          combinedEvPct
        });
      }

      return res.json({
        ok: true,
        date,
        stakeEur: STAKE_EUR,
        candidates,
        parlays
      });

    } catch (error) {

      console.error('PARLAY ERROR:', error);

      return res.status(500).json({
        ok: false,
        error: error.message || 'Error al generar el parlay.'
      });
    }
  }
);

/* =========================================================
   API ANALYZE
========================================================= */

app.get(
  '/api/analyze',
  async (req, res) => {

    try {

      const requestedHome =
        String(
          req.query.home || ''
        ).trim();

      const requestedAway =
        String(
          req.query.away || ''
        ).trim();

      const date =
        String(
          req.query.date || ''
        ).trim() ||
        new Date()
          .toISOString()
          .slice(0, 10);

      console.log(
        `[API /api/analyze] ${requestedHome} vs ${requestedAway} ${date}`
      );

      if (
        !requestedHome ||
        !requestedAway
      ) {
        return res
          .status(400)
          .json({
            ok: false,

            error:
              'Debes proporcionar home y away.'
          });
      }

      const fixtures =
        await getFixture(
          date
        );

      let selected =
        fixtures.find(
          match =>
            namesMatch(
              match?.homeTeam?.name,
              requestedHome
            ) &&
            namesMatch(
              match?.awayTeam?.name,
              requestedAway
            )
        );

      /*
       * También permitimos encontrar
       * el partido aunque el usuario
       * haya enviado los equipos invertidos.
       */
      let reversedRequest =
        false;

      if (!selected) {
        selected =
          fixtures.find(
            match =>
              namesMatch(
                match?.homeTeam?.name,
                requestedAway
              ) &&
              namesMatch(
                match?.awayTeam?.name,
                requestedHome
              )
          );

        if (selected) {
          reversedRequest =
            true;
        }
      }

      if (!selected) {
        console.log(
          `[ANALYZE] No encontrado ${requestedHome} vs ${requestedAway} en ${date}`
        );

        return res
          .status(404)
          .json({
            ok: false,

            error:
              'No se encontró el partido solicitado para esa fecha.',

            modelVersion:
              MODEL_VERSION
          });
      }

      /*
       * IMPORTANTE:
       * Usamos los nombres reales del fixture.
       * Esto evita que una diferencia de nombre
       * enviada desde la interfaz provoque una
       * asignación incorrecta de estadísticas.
       */
      const actualHomeName =
        selected.homeTeam?.name ||
        requestedHome;

      const actualAwayName =
        selected.awayTeam?.name ||
        requestedAway;

      const competitionCode =
        selected.competitionCode ||
        selected.competition?.code ||
        null;

      console.log(
        `[ANALYZE] fixture=${actualHomeName} vs ${actualAwayName} competition=${competitionCode} source=${selected.source}`
      );

      /*
       * IDs Football-Data
       */
      let homeId =
        selected.homeTeam?.id ||
        null;

      let awayId =
        selected.awayTeam?.id ||
        null;

      /*
       * Si el fixture viene de The Odds API,
       * sus IDs no existen en Football-Data.
       *
       * Aquí resolvemos ambos equipos por nombre.
       */
      if (
        !homeId &&
        competitionCode
      ) {
        homeId =
          await findTeamId(
            actualHomeName,
            competitionCode
          );
      }

      if (
        !awayId &&
        competitionCode
      ) {
        awayId =
          await findTeamId(
            actualAwayName,
            competitionCode
          );
      }

      if (
        !homeId ||
        !awayId
      ) {

        console.error(
          `[ANALYZE] IDs no resueltos home=${homeId} away=${awayId}`
        );

        return res
          .status(503)
          .json({
            ok: false,

            error:
              'Encontramos el partido, pero Football-Data no pudo identificar uno de los equipos para calcular sus estadísticas.',

            modelVersion:
              MODEL_VERSION,

            diagnostics: {
              fixtureSource:
                selected.source ||
                'unknown',

              competitionCode,

              homeTeam:
                actualHomeName,

              awayTeam:
                actualAwayName,

              homeTeamId:
                homeId,

              awayTeamId:
                awayId
            }
          });
      }

      /*
       * Partidos recientes
       */
      const [
        homeMatches,
        awayMatches
      ] =
        await Promise.all([
          getTeamRecentMatches(
            homeId
          ),

          getTeamRecentMatches(
            awayId
          )
        ]);

      let homeStats =
        calculateRecentTeamStats(
          homeId,
          homeMatches
        );

      let awayStats =
        calculateRecentTeamStats(
          awayId,
          awayMatches
        );

      /*
       * ESTABILIZACIÓN (shrinkage hacia la media)
       *
       * Aplicamos shrinkToMean directamente sobre los
       * promedios reales de cada equipo (avgGoalsFor /
       * avgGoalsAgainst), en vez de pasarle el objeto de
       * stats completo a stabilizeStats/shrinkToMean —
       * eso descartaba los datos reales por un mismatch
       * de formato entre server.js y engine.js.
       */
      try {

        const attackBaseline = 1.35;
        const defenseBaseline = 1.20;

        const homeGF = shrinkToMean(
          homeStats.avgGoalsFor,
          attackBaseline,
          homeStats.matches
        );

        const homeGA = shrinkToMean(
          homeStats.avgGoalsAgainst,
          defenseBaseline,
          homeStats.matches
        );

        const awayGF = shrinkToMean(
          awayStats.avgGoalsFor,
          attackBaseline,
          awayStats.matches
        );

        const awayGA = shrinkToMean(
          awayStats.avgGoalsAgainst,
          defenseBaseline,
          awayStats.matches
        );

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

      } catch (error) {

        console.warn(
          '[ANALYZE] estabilización fallback (se usan promedios crudos):',
          error.message
        );
      }

      /*
       * LESIONADOS (Big Balls Sports Data, si hay BIGBALLS_KEY)
       */
      const injuryAdjusted = await applyInjuryAdjustment(
        homeStats,
        awayStats,
        actualHomeName,
        actualAwayName,
        competitionCode
      );

      homeStats = injuryAdjusted.homeStats;
      awayStats = injuryAdjusted.awayStats;

      /*
       * DESCANSO / CALENDARIO (Big Balls Sports Data)
       */
      const [bbHomeTeamId, bbAwayTeamId] = await Promise.all([
        getBigBallsTeamId(actualHomeName, competitionCode),
        getBigBallsTeamId(actualAwayName, competitionCode)
      ]);

      const restAdjusted = await applyRestAdjustment(
        homeStats,
        awayStats,
        bbHomeTeamId,
        bbAwayTeamId
      );

      homeStats = restAdjusted.homeStats;
      awayStats = restAdjusted.awayStats;

      /*
       * MODELO
       */
      const modelInput =
        createModelInput(
          homeStats,
          awayStats
        );

      let model =
        matchModel(
          modelInput.homeXg,
          modelInput.awayXg
        );

      /*
       * HISTORIAL CARA A CARA (Big Balls Sports Data)
       */
      const h2hDrawRate = await getH2HDrawRate(bbHomeTeamId, bbAwayTeamId);
      model = applyH2HAdjustment(model, h2hDrawRate);

      /*
       * CONFIANZA
       *
       * confidence(probability, sampleSize, edge) espera
       * tres argumentos posicionales, no un objeto. Usamos
       * la probabilidad 1X2 más alta del modelo y el tamaño
       * de muestra más chico entre ambos equipos.
       */
      let modelConfidence =
        50;

      try {

        const bestProbability =
          Math.max(
            model.homeWin,
            model.draw,
            model.awayWin
          );

        const confidenceSampleSize =
          Math.min(
            homeStats.matches,
            awayStats.matches
          );

        modelConfidence =
          confidence(
            bestProbability,
            confidenceSampleSize
          );

      } catch (error) {

        console.warn(
          '[ANALYZE] confidence fallback 50:',
          error.message
        );

        modelConfidence =
          50;
      }

      const confidenceAdjusted =
        Math.max(
          0,
          Math.min(
            100,
            Math.round(
              Number(
                modelConfidence
              ) || 50
            )
          )
        );

      /*
       * CUOTAS
       */
      const odds =
        await getOdds(
          actualHomeName,
          actualAwayName,
          competitionCode
        );

      /*
       * MERCADOS
       */
      const markets =
        buildMarkets(
          model,
          odds,
          actualHomeName,
          actualAwayName
        );

      /*
       * VALUE
       */
      const value =
        bestValue(
          markets,
          confidenceAdjusted
        );

      const betEligible =
        Boolean(
          value
        );

      const recommendation =
        betEligible
          ? value.name
          : 'NO BET';

      const reason =
        betEligible
          ? `El modelo detecta valor respaldado por el mercado con ${Number(value.probability).toFixed(1)}% de probabilidad y EV de mercado de ${Number(value.referenceEvPct).toFixed(1)}%.`
          : 'No existe una oportunidad de valor positiva que cumpla los filtros actuales de probabilidad, EV, confianza y respaldo del mercado.';

      const confidenceLevel =
        confidenceAdjusted >= 75
          ? 'Alta'
          : confidenceAdjusted >= 60
            ? 'Media'
            : 'Baja';

      const confidenceExplanation =
        confidenceAdjusted >= 75
          ? 'Señal estadística fuerte.'
          : confidenceAdjusted >= 60
            ? 'Señal moderada. Se requiere disciplina.'
            : 'Señal insuficiente para recomendar apuesta.';

      /*
       * MARCADOR
       */
      const score =
        mostLikelyScore(
          modelInput.homeXg,
          modelInput.awayXg
        );

      console.log(
        `[ANALYZE] terminado ${actualHomeName} vs ${actualAwayName} | confidence=${confidenceAdjusted} | value=${value?.name || 'NO BET'}`
      );

      return res.json({

        ok: true,

        modelVersion:
          MODEL_VERSION,

        match: {

          id:
            selected.id ||
            null,

          home:
            actualHomeName,

          away:
            actualAwayName,

          date,

          kickoff:
            selected.utcDate ||
            null,

          competition:
            selected.competitionName ||
            selected.competition?.name ||
            competitionCode
        },

        recommendation,

        reason,

        betEligible,

        strength:
          value?.valueLevel ||
          'Sin valor',

        recentForm: {

          home:
            homeStats,

          away:
            awayStats
        },

        averages: {

          home: {

            goalsFor:
              Number(
                homeStats.avgGoalsFor
                  .toFixed(2)
              ),

            goalsAgainst:
              Number(
                homeStats.avgGoalsAgainst
                  .toFixed(2)
              )
          },

          away: {

            goalsFor:
              Number(
                awayStats.avgGoalsFor
                  .toFixed(2)
              ),

            goalsAgainst:
              Number(
                awayStats.avgGoalsAgainst
                  .toFixed(2)
              )
          }
        },

        xG: {

          home:
            Number(
              modelInput.homeXg
                .toFixed(2)
            ),

          away:
            Number(
              modelInput.awayXg
                .toFixed(2)
            ),

          total:
            Number(
              (
                modelInput.homeXg +
                modelInput.awayXg
              ).toFixed(2)
            )
        },

        mostLikelyScore:
          score,

        probabilities: {

          homeWin:
            Number(
              (
                model.homeWin *
                100
              ).toFixed(1)
            ),

          draw:
            Number(
              (
                model.draw *
                100
              ).toFixed(1)
            ),

          awayWin:
            Number(
              (
                model.awayWin *
                100
              ).toFixed(1)
            ),

          over25:
            Number(
              (
                model.over25 *
                100
              ).toFixed(1)
            ),

          under25:
            Number(
              (
                model.under25 *
                100
              ).toFixed(1)
            ),

          btts:
            Number(
              (
                model.btts *
                100
              ).toFixed(1)
            )
        },

        markets,

        oddsAvailable:
          Boolean(
            odds?.available
          ),

        oddsReason:
          odds?.available
            ? null
            : odds?.reason ||
              null,

        bestValue:
          value ||
          null,

        confidence:
          confidenceAdjusted,

        confidenceLevel,

        confidenceExplanation,

        stakeEur:
          STAKE_EUR,

        diagnostics: {

          fixtureSource:
            selected.source ||
            'football-data',

          competitionCode,

          requestedHome,

          requestedAway,

          actualHome:
            actualHomeName,

          actualAway:
            actualAwayName,

          reversedRequest,

          oddsReversed:
            Boolean(
              odds?.reversed
            ),

          homeTeamId:
            homeId,

          awayTeamId:
            awayId,

          recentHomeMatches:
            homeMatches.length,

          recentAwayMatches:
            awayMatches.length,

          homeInjuries:
            injuryAdjusted.homeInjuries,

          awayInjuries:
            injuryAdjusted.awayInjuries,

          valueFilters: {

            minimumProbability:
              55,

            minimumConfidence:
              60,

            minimumReferenceEv:
              2,

            minimumBookmakers:
              2,

            minimumSupport:
              2
          }
        }
      });

    } catch (error) {

      console.error(
        'ANALYZE ERROR:',
        error
      );

      return res
        .status(500)
        .json({

          ok: false,

          error:
            error.message ||
            'Error interno del servidor.',

          modelVersion:
            MODEL_VERSION
        });
    }
  }
);

/* =========================================================
   SIMULADOR DE APUESTAS
========================================================= */

function requireDb(res) {
  if (!pool) {
    res.status(503).json({
      ok: false,
      error: 'La base de datos no está configurada (falta DATABASE_URL). Configúrala en las variables de entorno de Render.'
    });
    return false;
  }
  return true;
}

function computeProfit(status, stakeEur, oddsValue) {
  const stake = Number(stakeEur) || 0;
  const odds = Number(oddsValue) || 0;

  if (status === 'won') {
    return Number((stake * (odds - 1)).toFixed(2));
  }

  if (status === 'lost') {
    return Number((-stake).toFixed(2));
  }

  return 0;
}

app.post(
  '/api/bets',
  async (req, res) => {

    if (!requireDb(res)) {
      return;
    }

    try {
      const {
        home,
        away,
        date,
        competition,
        market,
        outcome,
        marketName,
        odds,
        probability,
        legs
      } = req.body || {};

      if (!home || !away || !market || !outcome || !odds) {
        return res.status(400).json({
          ok: false,
          error: 'Faltan datos para registrar la apuesta simulada.'
        });
      }

      const legsJson =
        Array.isArray(legs) && legs.length
          ? JSON.stringify(legs)
          : null;

      const result = await pool.query(
        `INSERT INTO simulated_bets
          (match_date, home, away, competition, market, outcome, market_name, odds, model_probability, stake_eur, status, legs_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
         RETURNING *`,
        [
          date || null,
          home,
          away,
          competition || null,
          market,
          outcome,
          marketName || market,
          Number(odds),
          probability != null ? Number(probability) : null,
          STAKE_EUR,
          legsJson
        ]
      );

      console.log(
        `[BETS] simulada #${result.rows[0].id}: ${home} vs ${away} (${marketName || market}) @ ${odds}`
      );

      return res.json({
        ok: true,
        bet: result.rows[0]
      });

    } catch (error) {

      console.error('BETS CREATE ERROR:', error);

      return res.status(500).json({
        ok: false,
        error: error.message || 'Error al registrar la apuesta simulada.'
      });
    }
  }
);

app.get(
  '/api/bets',
  async (req, res) => {

    if (!requireDb(res)) {
      return;
    }

    try {
      const status = String(req.query.status || '').trim();
      const period = String(req.query.period || '').trim();

      const conditions = [];
      const params = [];

      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }

      if (period === 'week') {
        conditions.push(`created_at >= now() - interval '7 days'`);
      } else if (period === 'month') {
        conditions.push(`created_at >= now() - interval '30 days'`);
      }

      const whereClause =
        conditions.length
          ? `WHERE ${conditions.join(' AND ')}`
          : '';

      const result = await pool.query(
        `SELECT * FROM simulated_bets ${whereClause} ORDER BY created_at DESC LIMIT 200`,
        params
      );

      return res.json({
        ok: true,
        count: result.rows.length,
        bets: result.rows
      });

    } catch (error) {

      console.error('BETS LIST ERROR:', error);

      return res.status(500).json({
        ok: false,
        error: error.message || 'Error al listar las apuestas simuladas.'
      });
    }
  }
);

app.post(
  '/api/bets/:id/settle',
  async (req, res) => {

    if (!requireDb(res)) {
      return;
    }

    try {
      const id = Number(req.params.id);

      const result = Array.isArray(req.body?.result)
        ? req.body.result[0]
        : req.body?.result;

      if (!['won', 'lost', 'void'].includes(result)) {
        return res.status(400).json({
          ok: false,
          error: "El resultado debe ser 'won', 'lost' o 'void'."
        });
      }

      const existing = await pool.query(
        'SELECT * FROM simulated_bets WHERE id = $1',
        [id]
      );

      if (!existing.rows.length) {
        return res.status(404).json({
          ok: false,
          error: 'Apuesta simulada no encontrada.'
        });
      }

      const bet = existing.rows[0];

      const profitEur = computeProfit(
        result,
        bet.stake_eur,
        bet.odds
      );

      const updated = await pool.query(
        `UPDATE simulated_bets
         SET status = $1, profit_eur = $2, settled_at = now()
         WHERE id = $3
         RETURNING *`,
        [result, profitEur, id]
      );

      console.log(
        `[BETS] #${id} liquidada como ${result} (${profitEur >= 0 ? '+' : ''}${profitEur}€)`
      );

      return res.json({
        ok: true,
        bet: updated.rows[0]
      });

    } catch (error) {

      console.error('BETS SETTLE ERROR:', error);

      return res.status(500).json({
        ok: false,
        error: error.message || 'Error al liquidar la apuesta simulada.'
      });
    }
  }
);

app.get(
  '/api/bets/summary',
  async (req, res) => {

    if (!requireDb(res)) {
      return;
    }

    try {
      const period = String(req.query.period || 'month').trim();

      const interval =
        period === 'week'
          ? '7 days'
          : '30 days';

      const result = await pool.query(
        `SELECT status, COUNT(*)::int AS count, COALESCE(SUM(profit_eur), 0)::float AS profit, COALESCE(SUM(stake_eur), 0)::float AS staked
         FROM simulated_bets
         WHERE created_at >= now() - interval '${interval}'
         GROUP BY status`
      );

      // Desglose por tipo de mercado, para ver en cuáles el modelo
      // acierta más (útil para decidir qué ajustar).
      const byMarketResult = await pool.query(
        `SELECT market,
                COUNT(*) FILTER (WHERE status = 'won')::int AS won,
                COUNT(*) FILTER (WHERE status = 'lost')::int AS lost
         FROM simulated_bets
         WHERE created_at >= now() - interval '${interval}'
           AND status IN ('won','lost')
         GROUP BY market`
      );

      const byMarket = byMarketResult.rows.map(row => ({
        market: row.market,
        won: row.won,
        lost: row.lost,
        accuracyPct: (row.won + row.lost) > 0
          ? Number(((row.won / (row.won + row.lost)) * 100).toFixed(1))
          : null
      }));

      const summary = {
        pending: 0,
        won: 0,
        lost: 0,
        void: 0,
        totalProfitEur: 0,
        totalStakedEur: 0
      };

      for (const row of result.rows) {
        if (summary[row.status] !== undefined) {
          summary[row.status] = row.count;
        }

        summary.totalProfitEur += row.profit;
        summary.totalStakedEur += row.staked;
      }

      const settledCount = summary.won + summary.lost;

      const accuracyPct =
        settledCount > 0
          ? Number(((summary.won / settledCount) * 100).toFixed(1))
          : null;

      const roiPct =
        summary.totalStakedEur > 0
          ? Number(((summary.totalProfitEur / summary.totalStakedEur) * 100).toFixed(1))
          : null;

      return res.json({
        ok: true,
        period,
        pending: summary.pending,
        won: summary.won,
        lost: summary.lost,
        void: summary.void,
        settledCount,
        accuracyPct,
        totalProfitEur: Number(summary.totalProfitEur.toFixed(2)),
        totalStakedEur: Number(summary.totalStakedEur.toFixed(2)),
        roiPct,
        byMarket
      });

    } catch (error) {

      console.error('BETS SUMMARY ERROR:', error);

      return res.status(500).json({
        ok: false,
        error: error.message || 'Error al calcular el resumen.'
      });
    }
  }
);

/* =========================================================
   FRONTEND
========================================================= */

function renderPage() {

  return `<!DOCTYPE html>
<html lang="es">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no"
>

<meta
  http-equiv="Cache-Control"
  content="no-cache,no-store,must-revalidate"
>

<meta
  http-equiv="Pragma"
  content="no-cache"
>

<meta
  http-equiv="Expires"
  content="0"
>

<title>
MK Bets V7.13.0
</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  background:#080b10;
  color:#f5f7fa;
}

button,
input{
  font:inherit;
}

.app{
  max-width:760px;
  margin:auto;
  padding:64px 14px 100px;
}

.header{
  padding:12px 4px 20px;
}

.version{
  display:inline-block;
  padding:6px 10px;
  border-radius:999px;
  background:#171c25;
  font-size:12px;
  font-weight:800;
}

.logo-row{
  display:flex;
  align-items:center;
  gap:10px;
  margin-top:14px;
}

.logo-text{
  font-size:34px;
  font-weight:900;
  letter-spacing:2px;
  color:#fff;
}

h1{
  margin:18px 0 8px;
  font-size:32px;
  line-height:1.05;
}

.subtitle,
.muted{
  color:#9da5b2;
  font-size:15px;
}

.chips{
  display:flex;
  flex-wrap:wrap;
  gap:7px;
  margin:16px 0;
}

.chip{
  background:#151a22;
  border:1px solid #252c37;
  border-radius:999px;
  padding:8px 10px;
  font-size:12px;
}

.league-chips{
  display:flex;
  flex-wrap:wrap;
  gap:7px;
  margin-bottom:12px;
}

.league-chip{
  background:#151a22;
  border:1px solid #303846;
  border-radius:999px;
  padding:8px 12px;
  font-size:12px;
  font-weight:700;
  color:#c7ccd4;
  cursor:pointer;
}

.league-chip.active{
  background:#f4f5f7;
  color:#080b10;
  border-color:#f4f5f7;
}

.league-chip-priority{
  border-color:#ffb45d;
  color:#ffb45d;
}

.league-chip-priority.active{
  background:#ffb45d;
  color:#080b10;
  border-color:#ffb45d;
}

.team-highlight{
  border-color:#ffb45d !important;
  background:#1a140a !important;
}

.team-highlight-badge{
  display:inline-block;
  margin-left:6px;
  padding:2px 7px;
  border-radius:999px;
  font-size:10px;
  font-weight:800;
  background:#ffb45d;
  color:#080b10;
}

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
}

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
}

.primary:disabled{
  opacity:.55;
}

.loading{
  text-align:center;
  color:#9da5b2;
  padding:18px;
}

.error{
  color:#ff7b72;
}

.fixture-list{
  margin-top:14px;
}

.fixture{
  background:#090d13;
  border:1px solid #252c37;
  border-radius:15px;
  padding:14px;
  margin-bottom:9px;
}

.fixture-head{
  display:flex;
  justify-content:space-between;
  gap:10px;
  align-items:flex-start;
}

.fixture-teams{
  font-size:16px;
  font-weight:800;
  line-height:1.3;
}

.fixture-meta{
  color:#8e97a5;
  font-size:12px;
  margin-top:5px;
}

.analyze-small{
  border:0;
  border-radius:10px;
  padding:9px 11px;
  background:#f4f5f7;
  color:#080b10;
  font-size:11px;
  font-weight:900;
  white-space:nowrap;
}

.analysis-panel{
  display:grid;
  grid-template-rows:0fr;
  transition:grid-template-rows .28s ease, margin-top .28s ease;
  border-top:0px solid #252c37;
  margin-top:0;
}

.analysis-panel.open{
  grid-template-rows:1fr;
  margin-top:12px;
  border-top:1px solid #252c37;
}

.analysis-inner{
  overflow:hidden;
  min-height:0;
  padding-top:0;
}

.analysis-panel.open .analysis-inner{
  padding-top:12px;
}

.analysis-close{
  width:100%;
  border:1px solid #303846;
  border-radius:10px;
  padding:10px;
  background:#151a22;
  color:#fff;
  font-weight:800;
  margin-bottom:10px;
}

.analysis-loading{
  text-align:center;
  color:#9da5b2;
  padding:18px 5px;
}

.analysis-error{
  color:#ff7b72;
  background:#1b1012;
  border-radius:10px;
  padding:11px;
  font-size:13px;
}

.analysis-content{
  display:none;
}

.analysis-content.show{
  display:block;
}

.section-label{
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:1px;
  color:#929ba9;
  margin:14px 0 8px;
}

.fixture-decision{
  text-align:center;
  background:#10151d;
  border-radius:13px;
  padding:14px;
}

.fixture-decision h3{
  margin:6px 0;
  font-size:24px;
}

.noBet{
  color:#ffb45d;
}

.bet{
  color:#7ee787;
}

.score{
  font-size:38px;
  font-weight:900;
  margin:10px 0;
}

.scoreProb{
  color:#9da5b2;
}

.prob-grid,
.xg-grid{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:8px;
}

.prob,
.xg{
  background:#090d13;
  border-radius:12px;
  padding:12px 8px;
  text-align:center;
}

.prob span,
.xg span{
  display:block;
  color:#8e97a5;
  font-size:11px;
}

.prob b,
.xg b{
  font-size:20px;
}

.xg b{
  display:block;
  margin-top:5px;
}

.market{
  background:#090d13;
  border-radius:13px;
  padding:12px;
  margin-bottom:8px;
}

.market-top{
  display:flex;
  justify-content:space-between;
  gap:10px;
}

.market-details{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:6px;
  margin-top:10px;
  color:#8e97a5;
  font-size:12px;
}

.market-details b{
  color:white;
}

.value-box{
  border:1px solid #33414d;
  border-radius:13px;
  padding:13px;
}

.value-box h3{
  margin:0 0 8px;
}

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

.simulate-bet-btn:disabled{
  opacity:.6;
  cursor:default;
}

.simulate-result{
  margin-top:8px;
}

.history-summary{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:8px;
  margin-bottom:14px;
}

.history-summary .prob{
  background:#090d13;
  border-radius:12px;
  padding:12px 8px;
  text-align:center;
}

.history-period-toggle{
  display:flex;
  gap:8px;
  margin-bottom:14px;
}

.history-period-toggle button{
  flex:1;
  border:1px solid #303846;
  border-radius:10px;
  padding:9px;
  background:#151a22;
  color:#fff;
  font-weight:800;
  cursor:pointer;
}

.history-period-toggle button.active{
  background:#f4f5f7;
  color:#080b10;
}

.bet-row{
  background:#090d13;
  border:1px solid #252c37;
  border-radius:13px;
  padding:12px;
  margin-bottom:9px;
}

.bet-row-head{
  display:flex;
  justify-content:space-between;
  gap:10px;
}

.bet-row-meta{
  color:#8e97a5;
  font-size:12px;
  margin-top:4px;
}

.bet-row-actions{
  display:flex;
  gap:8px;
  margin-top:10px;
}

.bet-row-actions button{
  flex:1;
  border:0;
  border-radius:10px;
  padding:9px;
  font-weight:900;
  cursor:pointer;
}

.btn-won{
  background:#7ee787;
  color:#080b10;
}

.btn-lost{
  background:#ff7b72;
  color:#080b10;
}

.status-won{
  color:#7ee787;
}

.status-lost{
  color:#ff7b72;
}

.status-pending{
  color:#ffb45d;
}

.parlay-card{
  background:#10151d;
  border:1px solid #33414d;
  border-radius:15px;
  padding:14px;
  margin-bottom:10px;
}

.parlay-head{
  display:flex;
  justify-content:space-between;
  align-items:baseline;
  margin-bottom:8px;
}

.parlay-head b{
  font-size:18px;
}

.parlay-leg{
  background:#090d13;
  border-radius:11px;
  padding:9px 11px;
  margin-bottom:6px;
  font-size:13px;
}

.parlay-leg .tag{
  display:inline-block;
  margin-left:6px;
  padding:2px 7px;
  border-radius:999px;
  font-size:10px;
  font-weight:800;
  background:#252c37;
  color:#ffb45d;
}

.parlay-summary{
  display:flex;
  justify-content:space-between;
  color:#9da5b2;
  font-size:13px;
  margin:8px 0 10px;
}

.bet-slip-bar{
  position:fixed;
  left:0;
  right:0;
  bottom:0;
  max-width:760px;
  margin:auto;
  background:#151a22;
  border-top:1px solid #303846;
  border-left:1px solid #303846;
  border-right:1px solid #303846;
  border-radius:14px 14px 0 0;
  padding:10px 14px;
  z-index:20;
}

.bet-slip-summary{
  display:flex;
  justify-content:space-between;
  align-items:center;
  font-weight:800;
  cursor:pointer;
}

.bet-slip-panel{
  margin-top:12px;
  border-top:1px solid #303846;
  padding-top:12px;
}

.sb-market-row{
  background:#090d13;
  border:1px solid #252c37;
  border-radius:12px;
  padding:11px;
  margin-bottom:8px;
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
}

.sb-market-row .info{
  font-size:13px;
}

.sb-market-row .info b{
  display:block;
  font-size:15px;
}

.sb-add-btn{
  border:0;
  border-radius:10px;
  padding:9px 12px;
  background:#7ee787;
  color:#080b10;
  font-weight:900;
  white-space:nowrap;
  cursor:pointer;
}

.sb-add-btn.added{
  background:#303846;
  color:#9da5b2;
}

.slip-leg-row{
  display:flex;
  justify-content:space-between;
  align-items:center;
  background:#090d13;
  border-radius:10px;
  padding:9px 11px;
  margin-bottom:7px;
  font-size:13px;
}

.slip-leg-remove{
  border:0;
  background:none;
  color:#ff7b72;
  font-weight:900;
  font-size:16px;
  cursor:pointer;
  padding:0 6px;
}

.empty{
  text-align:center;
  color:#9da5b2;
  padding:22px 8px;
}

.search-summary{
  color:#9da5b2;
  font-size:13px;
  margin-top:10px;
}

.nav{
  position:fixed;
  top:0;
  left:0;
  right:0;
  max-width:760px;
  margin:auto;
  background:rgba(10,13,18,.96);
  border-bottom:1px solid #252c37;
  display:flex;
  justify-content:space-around;
  padding:11px 5px;
  font-size:11px;
  color:#929ba9;
  z-index:30;
}

.nav strong{
  color:white;
}

.nav span{
  cursor:pointer;
}

.nav span.active-nav{
  color:white;
  font-weight:800;
}

</style>

</head>

<body>

<div class="app">

<header class="header">

<span class="version">
● V7.13.0 ANALYST
</span>

<div class="logo-row">
<svg width="96" height="40" viewBox="0 0 130 90" xmlns="http://www.w3.org/2000/svg">
<polyline points="10,80 10,10 45,55 80,10 80,80" fill="none" stroke="#ffb45d" stroke-width="11" stroke-linecap="round" stroke-linejoin="round"></polyline>
<line x1="80" y1="45" x2="118" y2="8" stroke="#ffb45d" stroke-width="11" stroke-linecap="round"></line>
<line x1="80" y1="45" x2="118" y2="82" stroke="#ffb45d" stroke-width="11" stroke-linecap="round"></line>
</svg>
<span class="logo-text">BETS</span>
</div>

<h1>
Analiza antes de apostar.
</h1>

<div class="subtitle">
Modelo estadístico + xG + forma + cuotas reales + filtro de valor.
</div>

<div class="chips">

<span class="chip">📊 1X2</span>
<span class="chip">⚽ xG</span>
<span class="chip">🥅 BTTS</span>
<span class="chip">💰 VALUE</span>
<span class="chip">🎯 CONFIDENCE</span>
<span class="chip">🛡️ NO BET</span>

</div>

</header>

<section class="card">

<div class="card-title">
Buscar partidos por fecha
</div>

<div class="league-chips" id="leagueChips">
  <button type="button" class="league-chip active" data-competition="">Todas</button>
  <button type="button" class="league-chip league-chip-priority" data-competition="PD">🇪🇸 LaLiga</button>
  <button type="button" class="league-chip league-chip-priority" data-competition="CL">⭐ Champions</button>
  <button type="button" class="league-chip" data-competition="PL">🏴 Premier League</button>
  <button type="button" class="league-chip" data-competition="FL1">🇫🇷 Ligue 1</button>
  <button type="button" class="league-chip" data-competition="SA">🇮🇹 Serie A</button>
  <button type="button" class="league-chip" data-competition="BL1">🇩🇪 Bundesliga</button>
  <button type="button" class="league-chip" data-competition="EL">🥈 Europa League</button>
</div>

<input
  id="date"
  type="date"
>

<button
  class="primary"
  id="searchBtn"
  type="button"
>
🔎 BUSCAR PARTIDOS
</button>

<div
  id="searchSummary"
  class="search-summary"
></div>

</section>

<div
  id="loading"
  class="loading"
  style="display:none"
>
Buscando partidos...
</div>

<div
  id="error"
  class="card error"
  style="display:none"
></div>

<section
  id="fixturesCard"
  class="card"
  style="display:none"
>

<div class="card-title">
Partidos de la fecha
</div>

<div
  id="fixtureList"
  class="fixture-list"
></div>

<button
  class="primary"
  id="parlayBtn"
  type="button"
  style="margin-top:12px"
>
🎰 GENERAR PARLAY SUGERIDO
</button>

<div id="parlayLoading" class="loading" style="display:none">
Buscando picks fuertes y errores de cuota...
</div>

<div id="parlayError" class="analysis-error" style="display:none"></div>

<div id="parlayResult"></div>

</section>

<section
  id="historyCard"
  class="card"
  style="display:none"
>

<div class="card-title">
Historial de apuestas simuladas
</div>

<div class="history-period-toggle">
  <button type="button" id="periodWeekBtn" class="active" data-period="week">Semana</button>
  <button type="button" id="periodMonthBtn" data-period="month">Mes</button>
</div>

<div id="historyLoading" class="loading" style="display:none">
Cargando historial...
</div>

<div id="historyError" class="analysis-error" style="display:none"></div>

<div id="historySummary" class="history-summary"></div>

<div id="historyList" class="fixture-list"></div>

</section>

<section
  id="homeCard"
  class="card"
>

<div class="card-title">
Bienvenido a MK Bets
</div>

<div class="muted">
Modelo estadístico propio (xG + forma reciente ponderada + lesionados + descanso + historial H2H) sobre partidos reales, con filtro de valor frente a cuotas de mercado.
</div>

<div class="history-summary" style="margin-top:14px">
  <div class="prob">
    <span>ACIERTO (MES)</span>
    <b id="homeAccuracy">—</b>
  </div>
  <div class="prob">
    <span>GANANCIA (MES)</span>
    <b id="homeProfit">—</b>
  </div>
  <div class="prob">
    <span>APUESTAS</span>
    <b id="homeCount">—</b>
  </div>
</div>

<div class="market" style="margin-top:14px">
  <b>🧠 Analyst</b>
  <div class="muted">Busca partidos por liga y fecha, analiza uno y mira el modelo completo.</div>
</div>

<div class="market">
  <b>🎫 Apuestas</b>
  <div class="muted">Arma tu propio boleto eligiendo cualquier mercado, veas o no una recomendación.</div>
</div>

<div class="market">
  <b>📁 Historial</b>
  <div class="muted">Revisa qué tan acertadas han sido tus apuestas simuladas, por semana o mes.</div>
</div>

</section>

<section
  id="sportsbookCard"
  class="card"
  style="display:none"
>

<div class="card-title">
🎫 Casa de apuestas — elige un partido
</div>

<div class="league-chips" id="sbLeagueChips">
  <button type="button" class="league-chip active" data-competition="">Todas</button>
  <button type="button" class="league-chip league-chip-priority" data-competition="PD">🇪🇸 LaLiga</button>
  <button type="button" class="league-chip league-chip-priority" data-competition="CL">⭐ Champions</button>
  <button type="button" class="league-chip" data-competition="PL">🏴 Premier League</button>
  <button type="button" class="league-chip" data-competition="FL1">🇫🇷 Ligue 1</button>
  <button type="button" class="league-chip" data-competition="SA">🇮🇹 Serie A</button>
  <button type="button" class="league-chip" data-competition="BL1">🇩🇪 Bundesliga</button>
  <button type="button" class="league-chip" data-competition="EL">🥈 Europa League</button>
</div>

<input id="sbDate" type="date">

<button class="primary" id="sbSearchBtn" type="button">
🔎 BUSCAR PARTIDOS
</button>

<div id="sbLoading" class="loading" style="display:none">
Buscando partidos...
</div>

<div id="sbError" class="analysis-error" style="display:none"></div>

<div id="sbSummary" class="search-summary"></div>

<div id="sbFixtureList" class="fixture-list"></div>

</section>

</div>

<div id="betSlipBar" class="bet-slip-bar" style="display:none">
  <div class="bet-slip-summary" id="betSlipToggle">
    <span id="betSlipCount">🎫 0 selecciones</span>
    <span id="betSlipOdds">cuota —</span>
  </div>
  <div class="bet-slip-panel" id="betSlipPanel" style="display:none">
    <div id="betSlipLegs"></div>
    <button class="primary" id="betSlipSimulateBtn" type="button">
      🎯 Simular boleto
    </button>
    <button class="analysis-close" id="betSlipClearBtn" type="button">
      Vaciar boleto
    </button>
  </div>
</div>

<nav class="nav">

<span id="navHome" class="active-nav">
⌂<br>
Inicio
</span>

<span id="navAnalyst">
<strong>
🧠<br>
Analyst
</strong>
</span>

<span id="navHistory">
📁<br>
Historial
</span>

<span id="navSportsbook">
🎫<br>
Apuestas
</span>

</nav>

<script>

(function(){

'use strict';

let selectedCompetition = '';
let sbSelectedCompetition = '';

console.log(
  '[V7.13.0] JavaScript cargado correctamente'
);

function esc(value){

  return String(
    value == null
      ? ''
      : value
  )
  .replace(
    /&/g,
    '&amp;'
  )
  .replace(
    /</g,
    '&lt;'
  )
  .replace(
    />/g,
    '&gt;'
  )
  .replace(
    /"/g,
    '&quot;'
  )
  .replace(
    /'/g,
    '&#039;'
  );
}

function pct(value){

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n.toFixed(1) + '%'
    : '-';
}

function money(value){

  const n =
    Number(value);

  if(
    !Number.isFinite(n)
  ){
    return '-';
  }

  return (
    n >= 0
      ? '+'
      : ''
  ) +
  n.toFixed(1) +
  '%';
}

function localDateValue(){

  const d =
    new Date();

  const offset =
    d.getTimezoneOffset();

  return new Date(
    d.getTime() -
    offset * 60000
  )
  .toISOString()
  .slice(0,10);
}

function formatTime(value){

  if(!value){
    return '--:--';
  }

  const d =
    new Date(value);

  if(
    Number.isNaN(
      d.getTime()
    )
  ){
    return '--:--';
  }

  return d.toLocaleTimeString(
    'es-MX',
    {
      hour:'2-digit',
      minute:'2-digit'
    }
  );
}

function formatDate(value){

  if(!value){
    return '';
  }

  const p =
    value.split('-');

  return p.length === 3
    ? p[2] +
      '/' +
      p[1] +
      '/' +
      p[0]
    : value;
}

function closeAllPanels(
  exceptId
){

  document
    .querySelectorAll(
      '.analysis-panel.open'
    )
    .forEach(
      panel => {

        if(
          panel.id !==
          exceptId
        ){

          panel.classList
            .remove('open');
        }
      }
    );
}

async function searchFixtures(){

  console.log(
    '[V7.13.0] searchFixtures ejecutado'
  );

  const date =
    document.getElementById(
      'date'
    ).value;

  const loading =
    document.getElementById(
      'loading'
    );

  const error =
    document.getElementById(
      'error'
    );

  const card =
    document.getElementById(
      'fixturesCard'
    );

  const list =
    document.getElementById(
      'fixtureList'
    );

  const summary =
    document.getElementById(
      'searchSummary'
    );

  const button =
    document.getElementById(
      'searchBtn'
    );

  if(!date){

    error.style.display =
      'block';

    error.textContent =
      'Selecciona una fecha.';

    return;
  }

  error.style.display =
    'none';

  loading.style.display =
    'block';

  card.style.display =
    'none';

  list.innerHTML =
    '';

  summary.textContent =
    '';

  button.disabled =
    true;

  button.textContent =
    '⏳ BUSCANDO...';

  try{

    const response =
      await fetch(
        '/api/fixtures?date=' +
        encodeURIComponent(date) +
        (selectedCompetition ? '&competition=' + encodeURIComponent(selectedCompetition) : '') +
        '&v=790',
        {
          cache:'no-store',

          headers:{
            Accept:
              'application/json'
          }
        }
      );

    const data =
      await response.json();

    console.log(
      '[V7.13.0] fixtures:',
      data
    );

    if(
      !response.ok ||
      !data.ok
    ){

      throw new Error(
        data.error ||
        'No se pudieron cargar los partidos.'
      );
    }

    const fixtures =
      Array.isArray(
        data.fixtures
      )
        ? data.fixtures
        : [];

    card.style.display =
      'block';

    if(!fixtures.length){

      summary.textContent =
        'No se encontraron partidos para ' +
        formatDate(date) +
        '.';

      list.innerHTML =
        '<div class="empty">' +
        'No hay partidos disponibles para esta fecha.' +
        '</div>';

      return;
    }

    summary.textContent =
      fixtures.length +
      (
        fixtures.length === 1
          ? ' partido encontrado.'
          : ' partidos encontrados.'
      );

    list.innerHTML =
      fixtures
        .map(
          (
            fixture,
            index
          ) =>
            fixtureHtml(
              fixture,
              index,
              date
            )
        )
        .join('');

  }catch(errorObject){

    console.error(
      '[V7.13.0] ERROR:',
      errorObject
    );

    error.style.display =
      'block';

    error.textContent =
      errorObject.message ||
      'Error al buscar partidos.';

  }finally{

    loading.style.display =
      'none';

    button.disabled =
      false;

    button.textContent =
      '🔎 BUSCAR PARTIDOS';
  }
}

function fixtureHtml(
  fixture,
  index,
  date
){

  const panelId =
    'analysis-' +
    index +
    '-' +
    String(
      fixture.id ||
      index
    );

  const isFavoriteTeam =
    /real madrid/i.test(fixture.home || '') ||
    /real madrid/i.test(fixture.away || '');

  return \`

    <article class="fixture \${isFavoriteTeam ? 'team-highlight' : ''}">

      <div class="fixture-head">

        <div>

          <div class="fixture-teams">
            ⚽ \${esc(
              fixture.home
            )}
            vs
            \${esc(
              fixture.away
            )}
            \${isFavoriteTeam ? '<span class="team-highlight-badge">⭐ Real Madrid</span>' : ''}
          </div>

          <div class="fixture-meta">

            🕐 \${
              formatTime(
                fixture.kickoff
              )
            }

            · 🏆 \${
              esc(
                fixture.competition ||
                'Competición'
              )
            }

            · \${
              esc(
                fixture.source ||
                'football-data'
              )
            }

          </div>

        </div>

        <button
          class="analyze-small"
          type="button"
          data-panel="\${esc(panelId)}"
          data-home="\${esc(fixture.home)}"
          data-away="\${esc(fixture.away)}"
          data-date="\${esc(date)}"
        >
          🧠 ANALIZAR
        </button>

      </div>

      <div
        id="\${esc(panelId)}"
        class="analysis-panel"
      >
       <div class="analysis-inner">

        <button
          class="analysis-close"
          type="button"
          data-close-panel="\${esc(panelId)}"
        >
          ▲ CERRAR ANÁLISIS
        </button>

        <div
          id="\${esc(panelId)}-loading"
          class="analysis-loading"
        >
          Analizando partido...
        </div>

        <div
          id="\${esc(panelId)}-error"
          class="analysis-error"
          style="display:none"
        ></div>

        <div
          id="\${esc(panelId)}-content"
          class="analysis-content"
        ></div>

       </div>
      </div>

    </article>

  \`;
}

async function openAnalysis(
  panelId,
  home,
  away,
  date
){

  closeAllPanels(
    panelId
  );

  const panel =
    document.getElementById(
      panelId
    );

  if(!panel){
    return;
  }

  panel.classList.add(
    'open'
  );

  const loading =
    document.getElementById(
      panelId +
      '-loading'
    );

  const error =
    document.getElementById(
      panelId +
      '-error'
    );

  const content =
    document.getElementById(
      panelId +
      '-content'
    );

  loading.style.display =
    'block';

  error.style.display =
    'none';

  content.classList
    .remove('show');

  content.innerHTML =
    '';

  try{

    const params =
      new URLSearchParams({
        home,
        away,
        date
      });

    const response =
      await fetch(
        '/api/analyze?' +
        params.toString() +
        '&v=790',
        {
          cache:'no-store',

          headers:{
            Accept:
              'application/json'
          }
        }
      );

    const data =
      await response.json();

    console.log(
      '[V7.13.0] análisis:',
      data
    );

    if(
      !response.ok ||
      !data.ok
    ){

      throw new Error(
        data.error ||
        'No se pudo analizar el partido.'
      );
    }

    content.innerHTML =
      analysisHtml(
        data
      );

    content.classList.add(
      'show'
    );

  }catch(errorObject){

    console.error(
      '[V7.13.0] ANALYZE ERROR:',
      errorObject
    );

    error.style.display =
      'block';

    error.textContent =
      errorObject.message ||
      'Error de análisis.';

  }finally{

    loading.style.display =
      'none';
  }
}

function closeAnalysis(
  panelId
){

  const panel =
    document.getElementById(
      panelId
    );

  if(panel){

    panel.classList
      .remove('open');
  }
}

function marketHtml(
  market,
  match
){

  const isRecommended =
    !market.isOutlier &&
    market.valueEligible &&
    Number(market.referenceEvPct) >= 1;

  const badge =
    market.isOutlier
      ? '<span class="tag">⚠️ Precio atípico</span>'
      : isRecommended
        ? '<span class="team-highlight-badge">✅ Sí</span>'
        : '<span class="tag">❌ No</span>';

  return \`

    <div class="market">

      <div class="market-top">

        <strong>
          \${esc(
            market.name
          )}
          \${badge}
        </strong>

        <span>
          \${pct(
            market.probability
          )}
        </span>

      </div>

      <div class="market-details">

        <span>
          Mejor cuota:
          <b>
            \${
              market.bestOdds
                ? Number(
                    market.bestOdds
                  ).toFixed(2)
                : '-'
            }
          </b>
        </span>

        <span>
          Mercado:
          <b>
            \${
              market.referenceOdds
                ? Number(
                    market.referenceOdds
                  ).toFixed(2)
                : '-'
            }
          </b>
        </span>

        <span>
          EV:
          <b>
            \${money(
              market.referenceEvPct
            )}
          </b>
        </span>

        <span>
          Casas:
          <b>
            \${
              market.bookmakerCount ||
              0
            }
          </b>
        </span>

      </div>

      \${
        market.preferredBookmakerOdds
          ? \`
            <div class="value-box">
              🔥 Caliente MX: <b>\${Number(market.preferredBookmakerOdds).toFixed(2)}</b>
            </div>
          \`
          : ''
      }

      \${
        market.isOutlier
          ? \`

            <div class="value-box">

              ⚠️ Precio atípico.

              No se utiliza para Value Pick.

            </div>

          \`
          : ''
      }

      \${
        market.bestOdds && match
          ? \`
            <button
              class="simulate-bet-btn"
              type="button"
              data-home="\${esc(match.match?.home)}"
              data-away="\${esc(match.match?.away)}"
              data-date="\${esc(match.match?.date)}"
              data-competition="\${esc(match.match?.competition)}"
              data-market="\${esc(market.type)}"
              data-outcome="\${esc(market.outcome)}"
              data-market-name="\${esc(market.name)}"
              data-odds="\${esc(market.bestOdds)}"
              data-probability="\${esc(market.probability)}"
            >
              🎯 Simular esta apuesta (\${esc(match.stakeEur)}€)
            </button>
            <div class="simulate-result muted" style="display:none"></div>
          \`
          : ''
      }

    </div>

  \`;
}

function analysisHtml(
  data
){

  const local =
    data.recentForm?.home;

  const visitor =
    data.recentForm?.away;

  const decisionClass =
    data.betEligible
      ? 'bet'
      : 'noBet';

  const markets =
    data.oddsAvailable
      ? (
          data.markets ||
          []
        )
        .map(
          market => marketHtml(market, data)
        )
        .join('')
      : \`

        <div class="empty">

          Cuotas reales no disponibles.

          <br>

          \${esc(
            data.oddsReason ||
            ''
          )}

        </div>

      \`;

  const value =
    data.bestValue

      ? \`

        <div class="value-box">

          <h3>
            💰 \${esc(
              data.bestValue.name
            )}
          </h3>

          <div class="muted">

            Probabilidad:

            <b>
              \${pct(
                data.bestValue.probability
              )}
            </b>

          </div>

          <div class="muted">

            Cuota:

            <b>

              \${
                data.bestValue.bestOdds
                  ? Number(
                      data.bestValue.bestOdds
                    ).toFixed(2)
                  : '-'
              }

            </b>

          </div>

          <div class="muted">

            EV mercado:

            <b>
              \${money(
                data.bestValue.referenceEvPct
              )}
            </b>

          </div>

          <button
            class="simulate-bet-btn"
            type="button"
            data-home="\${esc(data.match?.home)}"
            data-away="\${esc(data.match?.away)}"
            data-date="\${esc(data.match?.date)}"
            data-competition="\${esc(data.match?.competition)}"
            data-market="\${esc(data.bestValue.type)}"
            data-outcome="\${esc(data.bestValue.outcome)}"
            data-market-name="\${esc(data.bestValue.name)}"
            data-odds="\${esc(data.bestValue.bestOdds)}"
            data-probability="\${esc(data.bestValue.probability)}"
          >
            🎯 Simular apuesta (\${esc(data.stakeEur)}€)
          </button>

          <div class="simulate-result muted" style="display:none"></div>

        </div>

      \`

      : \`

        <div class="value-box">

          <h3>
            🚫 SIN VALUE PICK
          </h3>

          <div class="muted">

            No existe una oportunidad
            que supere todos los filtros.

          </div>

        </div>

      \`;

  return \`

    <div class="fixture-decision">

      <div class="section-label">
        Decisión del modelo
      </div>

      <h3
        class="\${decisionClass}"
      >
        \${esc(
          data.recommendation ||
          'NO BET'
        )}
      </h3>

      <div class="muted">
        \${esc(
          data.reason ||
          ''
        )}
      </div>

    </div>

    <div class="section-label">
      🎯 Marcador más probable
    </div>

    <div class="market">

      <div class="fixture-teams">

        \${esc(
          data.match?.home
        )}

        vs

        \${esc(
          data.match?.away
        )}

      </div>

      <div class="score">

        \${esc(
          data.mostLikelyScore?.score ||
          '-'
        )}

      </div>

      <div class="scoreProb">

        Probabilidad:

        \${pct(
          data.mostLikelyScore?.probability
        )}

      </div>

    </div>

    <div class="section-label">
      📊 Probabilidades
    </div>

    <div class="prob-grid">

      <div class="prob">

        <span>
          🏠 LOCAL
        </span>

        <b>
          \${pct(
            data.probabilities?.homeWin
          )}
        </b>

      </div>

      <div class="prob">

        <span>
          🤝 EMPATE
        </span>

        <b>
          \${pct(
            data.probabilities?.draw
          )}
        </b>

      </div>

      <div class="prob">

        <span>
          ✈️ VISITANTE
        </span>

        <b>
          \${pct(
            data.probabilities?.awayWin
          )}
        </b>

      </div>

    </div>

    <br>

    <div class="prob-grid">

      <div class="prob">

        <span>
          OVER 2.5
        </span>

        <b>
          \${pct(
            data.probabilities?.over25
          )}
        </b>

      </div>

      <div class="prob">

        <span>
          UNDER 2.5
        </span>

        <b>
          \${pct(
            data.probabilities?.under25
          )}
        </b>

      </div>

      <div class="prob">

        <span>
          BTTS
        </span>

        <b>
          \${pct(
            data.probabilities?.btts
          )}
        </b>

      </div>

    </div>

    <div class="section-label">
      ⚽ xG
    </div>

    <div class="xg-grid">

      <div class="xg">

        <span>
          LOCAL
        </span>

        <b>
          \${Number(
            data.xG?.home ||
            0
          ).toFixed(2)}
        </b>

      </div>

      <div class="xg">

        <span>
          VISITANTE
        </span>

        <b>
          \${Number(
            data.xG?.away ||
            0
          ).toFixed(2)}
        </b>

      </div>

      <div class="xg">

        <span>
          TOTAL
        </span>

        <b>
          \${Number(
            data.xG?.total ||
            0
          ).toFixed(2)}
        </b>

      </div>

    </div>

    <div class="section-label">
      🎯 Confianza
    </div>

    <div class="market">

      <div class="fixture-teams">

        \${esc(
          data.confidenceLevel
        )}

      </div>

      <div class="muted">

        \${esc(
          data.confidence
        )}
        / 100

      </div>

      <div class="muted">

        \${esc(
          data.confidenceExplanation
        )}

      </div>

    </div>

    <div class="section-label">
      💪 Forma reciente
    </div>

    <div class="market">

      <b>
        LOCAL
      </b>

      <div class="muted">

        GF:

        \${Number(
          local?.avgGoalsFor ||
          0
        ).toFixed(2)}

        · GA:

        \${Number(
          local?.avgGoalsAgainst ||
          0
        ).toFixed(2)}

        · Form:

        \${pct(
          local?.formPct
        )}

      </div>

    </div>

    <div class="market">

      <b>
        VISITANTE
      </b>

      <div class="muted">

        GF:

        \${Number(
          visitor?.avgGoalsFor ||
          0
        ).toFixed(2)}

        · GA:

        \${Number(
          visitor?.avgGoalsAgainst ||
          0
        ).toFixed(2)}

        · Form:

        \${pct(
          visitor?.formPct
        )}

      </div>

    </div>

    <div class="section-label">
      💰 Cuotas reales
    </div>

    \${markets}

    <div class="section-label">
      🛡️ Value Pick
    </div>

    \${value}

  \`;
}

/* =========================================================
   EVENTOS
========================================================= */

let currentHistoryPeriod = 'week';
let betSlip = [];

function setActiveNav(id){
  ['navHome','navAnalyst','navHistory','navSportsbook'].forEach(navId => {
    const el = document.getElementById(navId);
    if(el){ el.classList.toggle('active-nav', navId === id); }
  });
}

function hideAllCards(){
  ['homeCard','fixturesCard','historyCard','sportsbookCard'].forEach(id => {
    const el = document.getElementById(id);
    if(el){ el.style.display = 'none'; }
  });
  document.getElementById('error').style.display = 'none';
}

async function showHomeView(){

  hideAllCards();
  document.getElementById('homeCard').style.display = 'block';
  setActiveNav('navHome');

  try{
    const response = await fetch('/api/bets/summary?period=month', { cache:'no-store' });
    const data = await response.json();

    if(response.ok && data.ok){
      document.getElementById('homeAccuracy').textContent = data.accuracyPct != null ? data.accuracyPct + '%' : '—';
      document.getElementById('homeProfit').textContent = data.totalProfitEur != null ? (data.totalProfitEur >= 0 ? '+' : '') + data.totalProfitEur.toFixed(2) + '€' : '—';
      document.getElementById('homeCount').textContent = (data.won || 0) + (data.lost || 0) + (data.pending || 0);
    }
  }catch(e){
    // sin datos todavía, se deja el guion
  }
}

function showSearchView(){

  hideAllCards();
  document.getElementById('fixturesCard').style.display =
    document.getElementById('fixtureList').innerHTML
      ? 'block'
      : 'none';

  setActiveNav('navAnalyst');
}

function showHistoryView(){

  hideAllCards();
  document.getElementById('historyCard').style.display = 'block';

  setActiveNav('navHistory');

  loadHistory(currentHistoryPeriod);
}

function showSportsbookView(){

  hideAllCards();
  document.getElementById('sportsbookCard').style.display = 'block';

  setActiveNav('navSportsbook');
}

function betStatusLabel(status){

  if(status === 'won'){ return '✅ Ganó'; }
  if(status === 'lost'){ return '❌ Perdió'; }
  if(status === 'void'){ return '➖ Anulada'; }
  return '⏳ Pendiente';
}

function renderBetRow(bet){

  const profit =
    bet.profit_eur == null
      ? null
      : Number(bet.profit_eur);

  const actions =
    bet.status === 'pending'
      ? \`
        <div class="bet-row-actions">
          <button class="btn-won" type="button" data-settle="\${esc(bet.id)}" data-result="won">✅ Ganó</button>
          <button class="btn-lost" type="button" data-settle="\${esc(bet.id)}" data-result="lost">❌ Perdió</button>
        </div>
      \`
      : '';

  return \`
    <div class="bet-row">
      <div class="bet-row-head">
        <strong>\${esc(bet.home)} vs \${esc(bet.away)}</strong>
        <span class="status-\${esc(bet.status)}">\${betStatusLabel(bet.status)}</span>
      </div>
      <div class="bet-row-meta">
        \${esc(bet.market_name)} · cuota \${Number(bet.odds).toFixed(2)} · stake \${Number(bet.stake_eur).toFixed(2)}€
        \${profit != null ? (' · ' + (profit >= 0 ? '+' : '') + profit.toFixed(2) + '€') : ''}
      </div>
      \${actions}
    </div>
  \`;
}

async function loadHistory(period){

  currentHistoryPeriod = period;

  document.getElementById('periodWeekBtn').classList.toggle('active', period === 'week');
  document.getElementById('periodMonthBtn').classList.toggle('active', period === 'month');

  const loading = document.getElementById('historyLoading');
  const error = document.getElementById('historyError');
  const summaryEl = document.getElementById('historySummary');
  const listEl = document.getElementById('historyList');

  loading.style.display = 'block';
  error.style.display = 'none';

  try{

    const [summaryRes, betsRes] = await Promise.all([
      fetch('/api/bets/summary?period=' + period, { cache:'no-store' }),
      fetch('/api/bets?period=' + period, { cache:'no-store' })
    ]);

    const summary = await summaryRes.json();
    const betsData = await betsRes.json();

    if(!summaryRes.ok || !summary.ok){
      throw new Error(summary.error || 'No se pudo cargar el resumen.');
    }

    if(!betsRes.ok || !betsData.ok){
      throw new Error(betsData.error || 'No se pudieron cargar las apuestas.');
    }

    summaryEl.innerHTML = \`
      <div class="prob">
        <span>ACIERTO</span>
        <b>\${summary.accuracyPct != null ? summary.accuracyPct + '%' : '-'}</b>
      </div>
      <div class="prob">
        <span>GANANCIA</span>
        <b>\${(summary.totalProfitEur >= 0 ? '+' : '') + summary.totalProfitEur.toFixed(2)}€</b>
      </div>
      <div class="prob">
        <span>PENDIENTES</span>
        <b>\${summary.pending}</b>
      </div>
    \`;

    const marketLabels = { h2h: '1X2', totals: 'Over/Under', parlay: 'Boletos combinados' };

    if(Array.isArray(summary.byMarket) && summary.byMarket.length){
      summaryEl.innerHTML += \`
        <div class="market" style="grid-column:1 / -1">
          <b>Acierto por tipo de mercado</b>
          \${summary.byMarket.map(m => \`
            <div class="bet-row-meta">
              \${esc(marketLabels[m.market] || m.market)}: \${m.accuracyPct != null ? m.accuracyPct + '%' : '-'} (\${m.won}G / \${m.lost}P)
            </div>
          \`).join('')}
        </div>
      \`;
    }

    const bets = Array.isArray(betsData.bets) ? betsData.bets : [];

    listEl.innerHTML =
      bets.length
        ? bets.map(renderBetRow).join('')
        : '<div class="empty">Todavía no simulas apuestas en este periodo.</div>';

  }catch(errorObject){

    error.style.display = 'block';
    error.textContent = errorObject.message || 'Error al cargar el historial.';

  }finally{

    loading.style.display = 'none';
  }
}

async function settleBet(id, result){

  try{

    const response = await fetch('/api/bets/' + id + '/settle', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ result })
    });

    const data = await response.json();

    if(!response.ok || !data.ok){
      throw new Error(data.error || 'No se pudo liquidar la apuesta.');
    }

    loadHistory(currentHistoryPeriod);

  }catch(errorObject){

    alert(errorObject.message || 'Error al liquidar la apuesta.');
  }
}

async function simulateBet(button){

  const payload = {
    home: button.dataset.home,
    away: button.dataset.away,
    date: button.dataset.date,
    competition: button.dataset.competition,
    market: button.dataset.market,
    outcome: button.dataset.outcome,
    marketName: button.dataset.marketName,
    odds: button.dataset.odds,
    probability: button.dataset.probability
  };

  const resultEl = button.parentElement.querySelector('.simulate-result');

  button.disabled = true;
  button.textContent = 'Guardando...';

  try{

    const response = await fetch('/api/bets', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if(!response.ok || !data.ok){
      throw new Error(data.error || 'No se pudo simular la apuesta.');
    }

    button.textContent = '✅ Apuesta simulada';

    if(resultEl){
      resultEl.style.display = 'block';
      resultEl.textContent = 'Guardada en tu historial. Márcala como ganada o perdida cuando termine el partido.';
    }

  }catch(errorObject){

    button.disabled = false;
    button.textContent = '🎯 Simular apuesta';

    if(resultEl){
      resultEl.style.display = 'block';
      resultEl.textContent = errorObject.message || 'Error al simular la apuesta.';
    }
  }
}

function parlayLegHtml(leg){

  return \`
    <div class="parlay-leg">
      <strong>\${esc(leg.home)} vs \${esc(leg.away)}</strong>
      <span class="tag">\${esc(leg.tag)}</span>
      <div class="muted">
        \${esc(leg.marketName)} · cuota \${Number(leg.odds).toFixed(2)} · \${pct(leg.probability)}
      </div>
    </div>
  \`;
}

function parlayCardHtml(parlay, stakeEur){

  const legsHtml = parlay.legs.map(parlayLegHtml).join('');

  return \`
    <div class="parlay-card">
      <div class="parlay-head">
        <b>\${parlay.legsCount} combinaciones</b>
        <b>cuota \${parlay.combinedOdds.toFixed(2)}</b>
      </div>
      \${legsHtml}
      <div class="parlay-summary">
        <span>Prob. combinada: \${parlay.combinedProbabilityPct}%</span>
        <span>EV: \${(parlay.combinedEvPct >= 0 ? '+' : '') + parlay.combinedEvPct}%</span>
      </div>
      <button
        class="simulate-bet-btn"
        type="button"
        data-parlay-legs='\${esc(JSON.stringify(parlay.legs))}'
        data-parlay-odds="\${esc(parlay.combinedOdds)}"
        data-parlay-count="\${esc(parlay.legsCount)}"
      >
        🎯 Simular este parlay (\${esc(stakeEur)}€)
      </button>
      <div class="simulate-result muted" style="display:none"></div>
    </div>
  \`;
}

async function loadParlay(){

  const date = document.getElementById('date').value || localDateValue();

  const loading = document.getElementById('parlayLoading');
  const error = document.getElementById('parlayError');
  const result = document.getElementById('parlayResult');
  const button = document.getElementById('parlayBtn');

  loading.style.display = 'block';
  error.style.display = 'none';
  result.innerHTML = '';
  button.disabled = true;

  try{

    const response = await fetch('/api/parlay?date=' + encodeURIComponent(date) + '&legs=4' + (selectedCompetition ? '&competition=' + encodeURIComponent(selectedCompetition) : ''), { cache:'no-store' });
    const data = await response.json();

    if(!response.ok || !data.ok){
      throw new Error(data.error || 'No se pudo generar el parlay.');
    }

    if(!data.parlays || !data.parlays.length){
      result.innerHTML = '<div class="empty">' + (data.message || 'No hay picks fuertes ni errores de cuota para esta fecha.') + '</div>';
      return;
    }

    result.innerHTML = data.parlays.map(p => parlayCardHtml(p, data.stakeEur)).join('');

  }catch(errorObject){

    error.style.display = 'block';
    error.textContent = errorObject.message || 'Error al generar el parlay.';

  }finally{

    loading.style.display = 'none';
    button.disabled = false;
  }
}

async function simulateParlay(button){

  let legs = [];

  try{
    legs = JSON.parse(button.dataset.parlayLegs || '[]');
  }catch(e){
    legs = [];
  }

  const payload = {
    home: 'PARLAY',
    away: legs.map(l => l.home + ' vs ' + l.away).join(' | '),
    date: legs[0]?.date || null,
    competition: 'Combinada',
    market: 'parlay',
    outcome: 'combo',
    marketName: button.dataset.parlayCount + ' combinaciones',
    odds: button.dataset.parlayOdds,
    probability: null,
    legs
  };

  const resultEl = button.parentElement.querySelector('.simulate-result');

  button.disabled = true;
  button.textContent = 'Guardando...';

  try{

    const response = await fetch('/api/bets', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if(!response.ok || !data.ok){
      throw new Error(data.error || 'No se pudo simular el parlay.');
    }

    button.textContent = '✅ Parlay simulado';

    if(resultEl){
      resultEl.style.display = 'block';
      resultEl.textContent = 'Guardado en tu historial.';
    }

  }catch(errorObject){

    button.disabled = false;
    button.textContent = '🎯 Simular este parlay';

    if(resultEl){
      resultEl.style.display = 'block';
      resultEl.textContent = errorObject.message || 'Error al simular el parlay.';
    }
  }
}

/* =========================================================
   CASA DE APUESTAS (boleto propio, tipo bookmaker)
========================================================= */

function sbFixtureHtml(fixture, index, date){

  const panelId = 'sb-analysis-' + index + '-' + String(fixture.id || index);

  const isFavoriteTeam =
    /real madrid/i.test(fixture.home || '') ||
    /real madrid/i.test(fixture.away || '');

  return \`
    <article class="fixture \${isFavoriteTeam ? 'team-highlight' : ''}">
      <div class="fixture-head">
        <div>
          <div class="fixture-teams">
            ⚽ \${esc(fixture.home)} vs \${esc(fixture.away)}
            \${isFavoriteTeam ? '<span class="team-highlight-badge">⭐ Real Madrid</span>' : ''}
          </div>
          <div class="fixture-meta">
            🕐 \${formatTime(fixture.kickoff)} · 🏆 \${esc(fixture.competition || 'Competición')}
          </div>
        </div>
        <button
          class="analyze-small"
          type="button"
          data-sb-panel="\${esc(panelId)}"
          data-home="\${esc(fixture.home)}"
          data-away="\${esc(fixture.away)}"
          data-date="\${esc(date)}"
        >
          🎫 VER CUOTAS
        </button>
      </div>
      <div id="\${esc(panelId)}" class="analysis-panel">
       <div class="analysis-inner">
        <button class="analysis-close" type="button" data-close-panel="\${esc(panelId)}">▲ CERRAR</button>
        <div id="\${esc(panelId)}-loading" class="analysis-loading">Cargando mercados...</div>
        <div id="\${esc(panelId)}-error" class="analysis-error" style="display:none"></div>
        <div id="\${esc(panelId)}-content" class="analysis-content"></div>
       </div>
      </div>
    </article>
  \`;
}

async function sbSearchFixtures(){

  const date = document.getElementById('sbDate').value;
  const loading = document.getElementById('sbLoading');
  const error = document.getElementById('sbError');
  const list = document.getElementById('sbFixtureList');
  const summary = document.getElementById('sbSummary');
  const button = document.getElementById('sbSearchBtn');

  if(!date){
    error.style.display = 'block';
    error.textContent = 'Selecciona una fecha.';
    return;
  }

  error.style.display = 'none';
  loading.style.display = 'block';
  list.innerHTML = '';
  summary.textContent = '';
  button.disabled = true;

  try{

    const response = await fetch(
      '/api/fixtures?date=' + encodeURIComponent(date) +
      (sbSelectedCompetition ? '&competition=' + encodeURIComponent(sbSelectedCompetition) : '') +
      '&v=7110',
      { cache:'no-store' }
    );

    const data = await response.json();

    if(!response.ok || !data.ok){
      throw new Error(data.error || 'No se pudieron cargar los partidos.');
    }

    const fixtures = Array.isArray(data.fixtures) ? data.fixtures : [];

    if(!fixtures.length){
      summary.textContent = 'No se encontraron partidos para ' + formatDate(date) + '.';
      list.innerHTML = '<div class="empty">No hay partidos disponibles para esta fecha.</div>';
      return;
    }

    summary.textContent = fixtures.length + (fixtures.length === 1 ? ' partido encontrado.' : ' partidos encontrados.');

    list.innerHTML = fixtures.map((fixture, index) => sbFixtureHtml(fixture, index, date)).join('');

  }catch(errorObject){

    error.style.display = 'block';
    error.textContent = errorObject.message || 'Error al buscar partidos.';

  }finally{

    loading.style.display = 'none';
    button.disabled = false;
  }
}

function sportsbookMarketRowHtml(market, matchCtx){

  if(!market.bestOdds){ return ''; }

  const legKey = matchCtx.home + '|' + matchCtx.away + '|' + market.type + '|' + market.outcome;
  const alreadyAdded = betSlip.some(l => l.key === legKey);

  return \`
    <div class="sb-market-row">
      <div class="info">
        <span>\${esc(market.name)}</span>
        <b>\${Number(market.bestOdds).toFixed(2)}</b>
      </div>
      <button
        class="sb-add-btn \${alreadyAdded ? 'added' : ''}"
        type="button"
        data-leg-key="\${esc(legKey)}"
        data-home="\${esc(matchCtx.home)}"
        data-away="\${esc(matchCtx.away)}"
        data-date="\${esc(matchCtx.date)}"
        data-competition="\${esc(matchCtx.competition)}"
        data-market="\${esc(market.type)}"
        data-outcome="\${esc(market.outcome)}"
        data-market-name="\${esc(market.name)}"
        data-odds="\${esc(market.bestOdds)}"
        data-probability="\${esc(market.probability)}"
        \${alreadyAdded ? 'disabled' : ''}
      >
        \${alreadyAdded ? '✅ En boleto' : '+ Agregar'}
      </button>
    </div>
  \`;
}

async function openSportsbookMarkets(panelId, home, away, date){

  closeAllPanels(panelId);

  const panel = document.getElementById(panelId);
  if(!panel){ return; }
  panel.classList.add('open');

  const loading = document.getElementById(panelId + '-loading');
  const error = document.getElementById(panelId + '-error');
  const content = document.getElementById(panelId + '-content');

  loading.style.display = 'block';
  error.style.display = 'none';
  content.classList.remove('show');
  content.innerHTML = '';

  try{

    const params = new URLSearchParams({ home, away, date });
    const response = await fetch('/api/analyze?' + params.toString() + '&v=7110', { cache:'no-store' });
    const data = await response.json();

    if(!response.ok || !data.ok){
      throw new Error(data.error || 'No se pudo cargar el partido.');
    }

    if(!data.oddsAvailable){
      content.innerHTML = '<div class="empty">Cuotas reales no disponibles para este partido.</div>';
    }else{
      const matchCtx = {
        home: data.match?.home,
        away: data.match?.away,
        date: data.match?.date,
        competition: data.match?.competition
      };

      content.innerHTML = (data.markets || []).map(m => sportsbookMarketRowHtml(m, matchCtx)).join('');
    }

    content.classList.add('show');

  }catch(errorObject){

    error.style.display = 'block';
    error.textContent = errorObject.message || 'Error al cargar el partido.';

  }finally{

    loading.style.display = 'none';
  }
}

function addLegToSlip(button){

  const leg = {
    key: button.dataset.legKey,
    home: button.dataset.home,
    away: button.dataset.away,
    date: button.dataset.date,
    competition: button.dataset.competition,
    market: button.dataset.market,
    outcome: button.dataset.outcome,
    marketName: button.dataset.marketName,
    odds: Number(button.dataset.odds),
    probability: Number(button.dataset.probability)
  };

  if(betSlip.some(l => l.key === leg.key)){ return; }

  betSlip.push(leg);

  button.classList.add('added');
  button.disabled = true;
  button.textContent = '✅ En boleto';

  renderBetSlip();
}

function removeLegFromSlip(index){
  betSlip.splice(index, 1);
  renderBetSlip();
}

function renderBetSlip(){

  const bar = document.getElementById('betSlipBar');
  const countEl = document.getElementById('betSlipCount');
  const oddsEl = document.getElementById('betSlipOdds');
  const legsEl = document.getElementById('betSlipLegs');

  if(!betSlip.length){
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'block';

  const combinedOdds = betSlip.reduce((acc, leg) => acc * Number(leg.odds || 1), 1);
  const stake = window.appStakeEur || 10;
  const potentialPayout = stake * combinedOdds;

  countEl.textContent = '🎫 ' + betSlip.length + (betSlip.length === 1 ? ' selección' : ' selecciones');
  oddsEl.textContent = 'cuota ' + combinedOdds.toFixed(2);

  legsEl.innerHTML = betSlip.map((leg, index) => \`
    <div class="slip-leg-row">
      <span>\${esc(leg.home)} vs \${esc(leg.away)} · \${esc(leg.marketName)} (\${Number(leg.odds).toFixed(2)})</span>
      <button class="slip-leg-remove" type="button" data-remove-leg="\${index}">✕</button>
    </div>
  \`).join('') + \`
    <div class="slip-leg-row" style="font-weight:900">
      <span>Apuestas \${stake.toFixed(2)}€ → si acierta ganas</span>
      <span>\${potentialPayout.toFixed(2)}€</span>
    </div>
  \`;
}

async function simulateSlipBets(){

  if(!betSlip.length){ return; }

  const button = document.getElementById('betSlipSimulateBtn');
  button.disabled = true;
  button.textContent = 'Guardando...';

  try{

    const payload = betSlip.length === 1
      ? {
          home: betSlip[0].home,
          away: betSlip[0].away,
          date: betSlip[0].date,
          competition: betSlip[0].competition,
          market: betSlip[0].market,
          outcome: betSlip[0].outcome,
          marketName: betSlip[0].marketName,
          odds: betSlip[0].odds,
          probability: betSlip[0].probability
        }
      : {
          home: 'BOLETO',
          away: betSlip.map(l => l.home + ' vs ' + l.away).join(' | '),
          date: betSlip[0].date,
          competition: 'Combinada',
          market: 'parlay',
          outcome: 'combo',
          marketName: betSlip.length + ' selecciones',
          odds: betSlip.reduce((acc, leg) => acc * Number(leg.odds || 1), 1),
          probability: null,
          legs: betSlip
        };

    const response = await fetch('/api/bets', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if(!response.ok || !data.ok){
      throw new Error(data.error || 'No se pudo simular el boleto.');
    }

    betSlip = [];
    renderBetSlip();
    document.getElementById('betSlipPanel').style.display = 'none';
    alert('Boleto guardado en tu Historial.');

  }catch(errorObject){

    alert(errorObject.message || 'Error al simular el boleto.');

  }finally{

    button.disabled = false;
    button.textContent = '🎯 Simular boleto';
  }
}

function initializeApp(){

  console.log(
    '[V7.13.0] inicializando interfaz'
  );

  fetch('/api/status', { cache:'no-store' })
    .then(r => r.json())
    .then(d => { window.appStakeEur = d.stakeEur || 10; })
    .catch(() => { window.appStakeEur = 10; });

  showHomeView();

  const date =
    document.getElementById(
      'date'
    );

  const searchBtn =
    document.getElementById(
      'searchBtn'
    );

  if(date){

    date.value =
      localDateValue();
  }

  if(!searchBtn){

    console.error(
      '[V7.13.0] searchBtn no encontrado'
    );

    return;
  }

  searchBtn.addEventListener(
    'click',
    searchFixtures
  );

  const leagueChips = document.querySelectorAll('.league-chip');

  leagueChips.forEach(chip => {
    chip.addEventListener('click', () => {

      leagueChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');

      selectedCompetition = chip.dataset.competition || '';

      if(document.getElementById('date').value){
        searchFixtures();
      }
    });
  });

  const navHistory = document.getElementById('navHistory');
  const navAnalyst = document.getElementById('navAnalyst');
  const navHome = document.getElementById('navHome');
  const periodWeekBtn = document.getElementById('periodWeekBtn');
  const periodMonthBtn = document.getElementById('periodMonthBtn');

  if(navHistory){
    navHistory.addEventListener('click', showHistoryView);
  }

  if(navAnalyst){
    navAnalyst.addEventListener('click', showSearchView);
  }

  if(navHome){
    navHome.addEventListener('click', showHomeView);
  }

  if(periodWeekBtn){
    periodWeekBtn.addEventListener('click', () => loadHistory('week'));
  }

  if(periodMonthBtn){
    periodMonthBtn.addEventListener('click', () => loadHistory('month'));
  }

  const parlayBtn = document.getElementById('parlayBtn');

  if(parlayBtn){
    parlayBtn.addEventListener('click', loadParlay);
  }

  const navSportsbook = document.getElementById('navSportsbook');

  if(navSportsbook){
    navSportsbook.addEventListener('click', showSportsbookView);
  }

  const sbSearchBtn = document.getElementById('sbSearchBtn');

  if(sbSearchBtn){
    sbSearchBtn.addEventListener('click', sbSearchFixtures);
  }

  const sbLeagueChips = document.querySelectorAll('#sbLeagueChips .league-chip');

  sbLeagueChips.forEach(chip => {
    chip.addEventListener('click', () => {
      sbLeagueChips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      sbSelectedCompetition = chip.dataset.competition || '';
      if(document.getElementById('sbDate').value){
        sbSearchFixtures();
      }
    });
  });

  const betSlipToggle = document.getElementById('betSlipToggle');

  if(betSlipToggle){
    betSlipToggle.addEventListener('click', () => {
      const panel = document.getElementById('betSlipPanel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
  }

  const betSlipSimulateBtn = document.getElementById('betSlipSimulateBtn');

  if(betSlipSimulateBtn){
    betSlipSimulateBtn.addEventListener('click', simulateSlipBets);
  }

  const betSlipClearBtn = document.getElementById('betSlipClearBtn');

  if(betSlipClearBtn){
    betSlipClearBtn.addEventListener('click', () => {
      betSlip = [];
      renderBetSlip();
    });
  }

  document.addEventListener(
    'click',
    event => {

      const sbOpen =
        event.target.closest(
          '[data-sb-panel]'
        );

      if(sbOpen){

        openSportsbookMarkets(
          sbOpen.dataset.sbPanel,
          sbOpen.dataset.home,
          sbOpen.dataset.away,
          sbOpen.dataset.date
        );

        return;
      }

      const analyze =
        event.target.closest(
          '.analyze-small'
        );

      if(analyze){

        openAnalysis(
          analyze.dataset.panel,
          analyze.dataset.home,
          analyze.dataset.away,
          analyze.dataset.date
        );

        return;
      }

      const close =
        event.target.closest(
          '[data-close-panel]'
        );

      if(close){

        closeAnalysis(
          close.dataset.closePanel
        );

        return;
      }

      const simulate =
        event.target.closest(
          '.simulate-bet-btn'
        );

      if(simulate){

        if(simulate.dataset.parlayLegs){
          simulateParlay(simulate);
        }else{
          simulateBet(simulate);
        }

        return;
      }

      const settle =
        event.target.closest(
          '[data-settle]'
        );

      if(settle){

        settleBet(
          settle.dataset.settle,
          settle.dataset.result
        );

        return;
      }

      const sbAdd =
        event.target.closest(
          '.sb-add-btn'
        );

      if(sbAdd && !sbAdd.disabled){

        addLegToSlip(sbAdd);

        return;
      }

      const slipRemove =
        event.target.closest(
          '[data-remove-leg]'
        );

      if(slipRemove){

        removeLegFromSlip(
          Number(slipRemove.dataset.removeLeg)
        );
      }

    }
  );

  console.log(
    '[V7.13.0] interfaz inicializada correctamente'
  );
}

window.searchFixtures =
  searchFixtures;

window.openAnalysis =
  openAnalysis;

window.closeAnalysis =
  closeAnalysis;

if(
  document.readyState ===
  'loading'
){

  document.addEventListener(
    'DOMContentLoaded',
    initializeApp
  );

}else{

  initializeApp();
}

})();

</script>

</body>
</html>`;
}

/* =========================================================
   HOME
========================================================= */

app.get(
  '/',
  (req, res) => {

    res.set(
      'Cache-Control',
      'no-store,no-cache,must-revalidate,proxy-revalidate'
    );

    res.set(
      'Pragma',
      'no-cache'
    );

    res.set(
      'Expires',
      '0'
    );

    res.type('html')
      .send(
        renderPage()
      );
  }
);

/* =========================================================
   DEBUG TEMPORAL — BIG BALLS SPORTS DATA
   (Quitar esta ruta una vez confirmada la cobertura)
========================================================= */

app.get(
  '/api/debug/bigballs',
  async (req, res) => {

    const BIGBALLS_KEY = process.env.BIGBALLS_KEY || '';

    if (!BIGBALLS_KEY) {
      return res.status(400).json({
        ok: false,
        error: 'BIGBALLS_KEY no configurada en las variables de entorno.'
      });
    }

    async function callBigBalls(path) {
      const url = `https://api.bigballsdata.com${path}`;

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${BIGBALLS_KEY}`,
          'x-api-key': BIGBALLS_KEY
        }
      });

      let data = null;

      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }

      return {
        path,
        status: response.status,
        ok: response.ok,
        keysFound: data && typeof data === 'object' ? Object.keys(data) : null,
        sample:
          Array.isArray(data?.data)
            ? data.data.slice(0, 2)
            : (data?.data || data)
      };
    }

    try {
      const results = {};

      // 1) Descubrir las ligas disponibles y sus claves
      results.leagues = await callBigBalls('/v1/leagues?sport=football');

      // 2) Lista de partidos de LaLiga (probamos un par de claves posibles)
      results.matchesLaligaTry1 = await callBigBalls('/v1/matches?league=laliga&sport=football');
      results.matchesLaligaTry2 = await callBigBalls('/v1/matches?league=la-liga&sport=football');

      const allMatches = results.matchesLaligaTry1.sample || [];

      const scheduledMatch =
        allMatches.find(m => m?.status === 'scheduled' && m?.has_odds) ||
        allMatches.find(m => m?.status === 'scheduled') ||
        null;

      const sampleMatch = scheduledMatch || allMatches[0] || null;

      const matchId = sampleMatch?.id || sampleMatch?.match_id || null;

      if (matchId) {
        // La prueba más importante: ¿las cuotas de verdad son gratis?
        results.oddsTry = await callBigBalls(`/v1/matches/${matchId}/odds`);

        results.lineupsTry1 = await callBigBalls(`/v1/matches/${matchId}/lineups`);
        results.lineupsStoredTry = await callBigBalls(`/v1/stored/matches/${matchId}/lineups`);
        results.statsTry1 = await callBigBalls(`/v1/stored/matches/${matchId}/stats`);
      } else {
        results.note = 'No se encontró un partido de muestra para probar odds/lineups/stats.';
      }

      results.injuriesTry1 = await callBigBalls('/v1/injuries?sport=football&league=laliga');

      return res.json({ ok: true, results });

    } catch (error) {

      console.error('BIGBALLS DEBUG ERROR:', error);

      return res.status(500).json({
        ok: false,
        error: error.message || 'Error probando Big Balls Sports Data.'
      });
    }
  }
);

/* =========================================================
   DEBUG TEMPORAL — API-FOOTBALL
   (Quitar esta ruta una vez confirmada la cobertura;
   solo sirve para diagnosticar sin exponer la API key)
========================================================= */

app.get(
  '/api/debug/apifootball',
  async (req, res) => {

    const API_FOOTBALL_KEY = process.env.API_FOOTBALL || '';

    if (!API_FOOTBALL_KEY) {
      return res.status(400).json({
        ok: false,
        error: 'API_FOOTBALL no configurada en las variables de entorno.'
      });
    }

    const LEAGUES = {
      laliga: 140,
      premier: 39,
      ligue1: 61,
      seriea: 135,
      bundesliga: 78
    };

    const SEASON = Number(req.query.season) || 2026;

    async function callApiFootball(path) {
      const url = `https://v3.football.api-sports.io${path}`;

      const response = await fetch(url, {
        headers: { 'x-apisports-key': API_FOOTBALL_KEY }
      });

      const data = await response.json().catch(() => null);

      return {
        status: response.status,
        remaining: response.headers.get('x-ratelimit-requests-remaining'),
        limit: response.headers.get('x-ratelimit-requests-limit'),
        errors: data?.errors || null,
        resultsCount: Array.isArray(data?.response) ? data.response.length : null,
        sample: Array.isArray(data?.response) ? data.response.slice(0, 1) : data?.response || null
      };
    }

    try {
      const results = {};

      // 1) Confirmar que la key funciona y ver estado de cuota
      results.status = await callApiFootball('/status');

      // 2) Ver si LaLiga temporada actual está disponible en el plan free
      results.laligaSeasonCheck = await callApiFootball(
        `/leagues?id=${LEAGUES.laliga}&season=${SEASON}`
      );

      // 3) Próximos partidos de LaLiga
      results.laligaFixtures = await callApiFootball(
        `/fixtures?league=${LEAGUES.laliga}&season=${SEASON}&next=5`
      );

      // 4) Cuotas disponibles para esos partidos (si hay alguno)
      const firstFixtureId = results.laligaFixtures.sample?.[0]?.fixture?.id;

      if (firstFixtureId) {
        results.oddsCheck = await callApiFootball(
          `/odds?fixture=${firstFixtureId}`
        );

        results.lineupsCheck = await callApiFootball(
          `/fixtures/lineups?fixture=${firstFixtureId}`
        );

        results.injuriesCheck = await callApiFootball(
          `/injuries?fixture=${firstFixtureId}`
        );
      } else {
        results.note = 'No se encontró un fixture próximo de LaLiga para probar odds/lineups/injuries.';
      }

      return res.json({ ok: true, season: SEASON, results });

    } catch (error) {

      console.error('APIFOOTBALL DEBUG ERROR:', error);

      return res.status(500).json({
        ok: false,
        error: error.message || 'Error probando API-Football.'
      });
    }
  }
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/health',
  (req, res) => {

    res.set(
      'Cache-Control',
      'no-store'
    );

    res.json({

      ok: true,

      modelVersion:
        MODEL_VERSION,

      uptime:
        process.uptime()
    });

  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  async () => {

    console.log(
      `V7.13.0 ANALYST running on port ${PORT}`
    );

    console.log(
      `Football-Data configurado: ${Boolean(
        FOOTBALL_DATA_TOKEN
      )}`
    );

    console.log(
      `Odds API configurado: ${Boolean(
        ODDS_API_KEY
      )}`
    );

    console.log(
      `Base de datos configurada: ${Boolean(DATABASE_URL)}`
    );

    await ensureSchema();

  }
);
