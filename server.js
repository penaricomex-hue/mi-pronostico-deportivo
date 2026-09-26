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

// Importar motor o usar fallback interno autónomo
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
   ACCESO PRIVADO (usuario/contraseña)
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
    // Permitir health check y descargas públicas
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
  console.log('[AUTH] Acceso protegido con usuario/contraseña activado.');
}

const MODEL_VERSION = 'V7.18.0';
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
   VENTAJA DE LOCAL AJUSTADA POR LIGA
   Antes: 1.08x fijo para todas.
   Ahora: factor calibrado según el impacto histórico real.
========================================================= */
const HOME_ADVANTAGE_BY_LEAGUE = {
  PD: 1.14,  // LaLiga (España): localía muy dominante
  SA: 1.13,  // Serie A (Italia): campos complicados y planteos conservadores
  EL: 1.13,  // Europa League: viajes largos y ambientes hostiles
  BL1: 1.10, // Bundesliga (Alemania): alta intensidad y estadios llenos
  CL: 1.10,  // Champions League: alta competencia, ventaja moderada
  FL1: 1.09, // Ligue 1 (Francia): factor intermedio
  PL: 1.07   // Premier League (Inglaterra): máxima paridad y muchas victorias visitantes
};

function getHomeAdvantage(competitionCode) {
  return HOME_ADVANTAGE_BY_LEAGUE[competitionCode] || 1.08;
}

const CACHE_MINUTES = 30; // V7.18
const STAKE_EUR = Number(process.env.STAKE_EUR) || 10;
const DATABASE_URL = process.env.DATABASE_URL || '';

const pool = (DATABASE_URL && Pool)
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

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

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_MINUTES * 60 * 1000) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function cacheGetTimestamp(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_MINUTES * 60 * 1000) return null;
  return item.time;
}

function cacheSet(key, data) {
  cache.set(key, { time: Date.now(), data });
  return data;
}

function cacheSetIfNotEmpty(key, data) {
  if (Array.isArray(data) && data.length === 0) return data;
  return cacheSet(key, data);
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

async function getInjuryCountForTeam(teamName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];
  if (!bbLeagueKey || !BIGBALLS_KEY) return 0;
  try {
    const [teams, injuries] = await Promise.all([
      getBigBallsTeams(bbLeagueKey),
      getBigBallsInjuries(bbLeagueKey)
    ]);
    const matchedTeam = teams.find(t => namesMatch(t?.name, teamName));
    if (!matchedTeam?.id) return 0;
    return injuries.filter(inj => inj?.current_team_id === matchedTeam.id).length;
  } catch (error) {
    return 0;
  }
}

async function applyInjuryAdjustment(homeStats, awayStats, homeName, awayName, competitionCode) {
  try {
    const [homeInjuries, awayInjuries] = await Promise.all([
      getInjuryCountForTeam(homeName, competitionCode),
      getInjuryCountForTeam(awayName, competitionCode)
    ]);
    const homeFactor = clamp(1 - homeInjuries * 0.03, 0.85, 1);
    const awayFactor = clamp(1 - awayInjuries * 0.03, 0.85, 1);
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
    return { homeStats, awayStats, homeInjuries: 0, awayInjuries: 0 };
  }
}

/* =========================================================
   1. CALCULAR EL DESCANSO NOSOTROS MISMOS (GRATIS)
   Usa el historial de Football-Data que ya tenemos sin pagar
   la ruta de Big Balls.
========================================================= */
function calculateRestDaysFromMatches(matches, matchUtcDate) {
  if (!Array.isArray(matches) || !matches.length) return null;
  const targetTime = matchUtcDate ? new Date(matchUtcDate).getTime() : Date.now();

  // Partidos terminados antes de la fecha del encuentro
  const pastMatches = matches
    .filter(m => m.utcDate && new Date(m.utcDate).getTime() < targetTime)
    .sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime());

  if (!pastMatches.length) return null;

  const lastMatchTime = new Date(pastMatches[0].utcDate).getTime();
  const diffDays = Math.max(0, Math.floor((targetTime - lastMatchTime) / (1000 * 60 * 60 * 24)));
  return diffDays;
}

function getRestImpact(restDays) {
  if (restDays == null) return { factor: 1.0, label: 'Sin datos', impact: 0 };
  if (restDays <= 2) return { factor: 0.88, label: 'Fatiga severa (≤2 días)', impact: -12 };
  if (restDays === 3) return { factor: 0.93, label: 'Cansancio moderado (3 días)', impact: -7 };
  if (restDays === 4) return { factor: 0.97, label: 'Descanso justo (4 días)', impact: -3 };
  if (restDays >= 5 && restDays <= 12) return { factor: 1.00, label: 'Descanso óptimo (' + restDays + 'd)', impact: 0 };
  return { factor: 0.97, label: 'Falta de ritmo (' + restDays + 'd)', impact: -3 };
}

function applyCalculatedRestAdjustment(homeStats, awayStats, homeRestDays, awayRestDays) {
  const homeImpact = getRestImpact(homeRestDays);
  const awayImpact = getRestImpact(awayRestDays);

  return {
    homeStats: {
      ...homeStats,
      attackStrength: clamp(homeStats.attackStrength * homeImpact.factor, 0.45, 1.8),
      defenseStrength: clamp(homeStats.defenseStrength * homeImpact.factor, 0.45, 1.8)
    },
    awayStats: {
      ...awayStats,
      attackStrength: clamp(awayStats.attackStrength * awayImpact.factor, 0.45, 1.8),
      defenseStrength: clamp(awayStats.defenseStrength * awayImpact.factor, 0.45, 1.8)
    },
    homeRest: { days: homeRestDays, status: homeImpact.label, impactPct: homeImpact.impact },
    awayRest: { days: awayRestDays, status: awayImpact.label, impactPct: awayImpact.impact }
  };
}

/* =========================================================
   3. PREDICCIONES BIG BALLS (/v1/predictions) - SEGUNDA OPINIÓN
========================================================= */
async function getBigBallsPrediction(homeName, awayName, competitionCode) {
  const bbLeagueKey = BIGBALLS_LEAGUE_MAP[competitionCode];
  if (!bbLeagueKey || !BIGBALLS_KEY) return null;
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

    return {
      homeProb: Math.round(hp <= 1 ? hp * 100 : hp),
      drawProb: Math.round(dp <= 1 ? dp * 100 : dp),
      awayProb: Math.round(ap <= 1 ? ap * 100 : ap),
      predictedWinner: winner
    };
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

  const agreement = mkWinner === bbPred.predictedWinner;
  const labels = { home: 'Local', draw: 'Empate', away: 'Visitante' };

  if (agreement) {
    return {
      available: true,
      agrees: true,
      status: 'Consenso (+5% confianza)',
      mkPick: labels[mkWinner],
      bbPick: labels[bbPred.predictedWinner],
      bbProbs: { home: bbPred.homeProb, draw: bbPred.drawProb, away: bbPred.awayProb },
      confidenceDelta: 5,
      message: `Big Balls coincide con nuestro modelo eligiendo ${labels[mkWinner]}. Señal reforzada.`
    };
  } else {
    return {
      available: true,
      agrees: false,
      status: 'Divergencia (Alerta)',
      mkPick: labels[mkWinner],
      bbPick: labels[bbPred.predictedWinner] || 'Otro resultado',
      bbProbs: { home: bbPred.homeProb, draw: bbPred.drawProb, away: bbPred.awayProb },
      confidenceDelta: -6,
      message: `Alerta: Big Balls proyecta ${labels[bbPred.predictedWinner] || 'resultado opuesto'}. Discrepancia entre modelos.`
    };
  }
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
  if (!sport) return { available: false, reason: 'Competición no soportada' };

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
  if (info.isOutlier) valueLevel = 'Precio atípico';
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
  const serverPath = path.join(__dirname, 'server.js');
  if (fs.existsSync(serverPath)) {
    res.download(serverPath, 'server.js');
  } else {
    res.status(404).send('server.js no encontrado.');
  }
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
    // Football-Data.org limita las consultas a ventanas de máximo 10 días.
    const matches = [];

    for (let offset = 0; offset <= 14; offset += 10) {
      const from = addDaysToDateStr(todayStr, offset);
      const to = addDaysToDateStr(
        todayStr,
        Math.min(offset + 9, 14)
      );

      const data = await footballData(
        `/matches?dateFrom=${from}&dateTo=${to}`
      );

      if (Array.isArray(data?.matches)) {
        matches.push(...data.matches);
      }
    }
    const filtered = matches.filter(m =>
      teams.some(t => namesMatch(m?.homeTeam?.name, t) || namesMatch(m?.awayTeam?.name, t))
    );

    const fixtures = filtered.map(m => ({
      home: m.homeTeam?.name || null,
      away: m.awayTeam?.name || null,
      homeCrest: m.homeTeam?.crest || null,
      awayCrest: m.awayTeam?.crest || null,
      kickoff: m.utcDate || null,
      competition: m.competition?.name || m.competition?.code || null
    })).sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));

    const result = { ok: true, fixtures };
    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/api/fixtures/next', async (req, res) => {
  const comp = String(req.query.competition || '').trim().toUpperCase();
  if (!comp) {
    return res.status(400).json({ ok: false, error: 'Debes indicar una liga específica.' });
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
      : { ok: true, found: false, message: 'No se encontraron partidos próximos en 45 días.' };

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
   ANÁLISIS DE UN PARTIDO (con Descanso Propio + Home Advantage + Big Balls)
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

  // Estabilización
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

  // H2H Histórico
  const [bbHomeTeamId, bbAwayTeamId] = await Promise.all([
    getBigBallsTeamId(homeName, compCode),
    getBigBallsTeamId(awayName, compCode)
  ]);
  const h2hDrawRate = await getH2HDrawRate(bbHomeTeamId, bbAwayTeamId);
  model = applyH2HAdjustment(model, h2hDrawRate);

  // 3. Predicción Big Balls (Segunda Opinión)
  const bbPred = await getBigBallsPrediction(homeName, awayName, compCode);
  const bbComparison = evaluateSecondOpinion(model, bbPred);

  // Confianza
  let modelConf = 50;
  try {
    const bestP = Math.max(model.homeWin, model.draw, model.awayWin);
    const n = Math.min(homeStats.matches, awayStats.matches);
    modelConf = confidence(bestP, n);
  } catch (e) {
    modelConf = 50;
  }

  // Ajuste de confianza por acuerdo con Big Balls
  if (bbComparison?.confidenceDelta) {
    modelConf += bbComparison.confidenceDelta;
  }

  const confidenceAdjusted = clamp(Math.round(modelConf), 20, 95);

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
      return res.status(404).json({ ok: false, error: 'No se encontró el partido solicitado.', modelVersion: MODEL_VERSION });
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
        error: 'Football-Data no pudo identificar uno de los equipos para estadísticas.',
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

    // 3. Predicción Big Balls (Segunda Opinión)
    const bbPrediction = await getBigBallsPrediction(actualHomeName, actualAwayName, competitionCode);
    const bbComparison = evaluateSecondOpinion(model, bbPrediction);

    // Confianza base
    let modelConfidence = 50;
    try {
      const bestProbability = Math.max(model.homeWin, model.draw, model.awayWin);
      const confidenceSampleSize = Math.min(homeStats.matches, awayStats.matches);
      modelConfidence = confidence(bestProbability, confidenceSampleSize);
    } catch (e) {
      modelConfidence = 50;
    }

    // Impacto de Big Balls en la confianza (+5 si acuerdan, -6 si discrepan)
    if (bbComparison?.confidenceDelta) {
      modelConfidence += bbComparison.confidenceDelta;
    }

    const confidenceAdjusted = clamp(Math.round(modelConfidence), 20, 95);

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
      ? 'Señal estadística fuerte respaldada por métricas sólidas.'
      : (confidenceAdjusted >= 60 ? 'Señal moderada. Recomendada gestión de banca disciplinada.' : 'Señal insuficiente para recomendar apuesta de alto riesgo.');

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
   SIMULADOR DE APUESTAS & AUTO-SETTLE
========================================================= */
function requireDb(res) {
  if (!pool) {
    res.status(503).json({
      ok: false,
      error: 'La base de datos PostgreSQL no está configurada (DATABASE_URL).'
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
   FRONTEND - RENDER PAGE (V7.18.0)
   Incluye:
   - Banner VS con escudos grandes
   - Medidor circular SVG de confianza
   - Skeletons animados de carga
   - Descanso propio gratis
   - Ventaja local ajustada
   - Segunda opinión Big Balls
   - Favicon embebido e ícono
========================================================= */
function renderPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no,viewport-fit=cover">
<meta http-equiv="Cache-Control" content="no-cache,no-store,must-revalidate">
<title>MK Bets V7.18.0 - Pronósticos Deportivos</title>
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

/* 4. BANNER "VS" EN EL ANÁLISIS */
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
  <div style="display:flex;justify-content:space-between;align-items:center">
    <span class="version">● V7.17.0 ANALYST</span>
    <a href="/api/download-server" class="btn-download" style="margin-top:0;width:auto;padding:5px 12px;font-size:11px">⬇️ Descargar server.js</a>
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
  <div class="subtitle">Modelo estadístico + Descanso gratis + Ventaja local por liga + 2ª opinión Big Balls + Cuotas reales.</div>

  <div class="chips">
    <span class="chip">⏱️ Descanso propio</span>
    <span class="chip">🏟️ Localía x Liga</span>
    <span class="chip">🔮 Big Balls Opinion</span>
    <span class="chip">🛡️ Value Bets</span>
  </div>
</header>

<section class="card">
  <div class="card-title">Buscar partidos por fecha</div>

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

  <input id="date" type="date">

  <button class="primary" id="searchBtn" type="button">🔎 BUSCAR PARTIDOS</button>
  <button class="analysis-close" id="nextFixtureBtn" type="button" style="margin-top:8px">⏭️ Buscar próximo partido disponible</button>

  <div id="searchSummary" style="color:#9da5b2;font-size:13px;margin-top:10px"></div>
</section>

<!-- 6. SKELETON LOADER CONTAINER -->
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

  <button class="primary" id="parlayBtn" type="button" style="margin-top:12px">🎰 GENERAR PARLAY SUGERIDO</button>
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

  <div class="card-title">Novedades V7.17.0</div>
  <div class="muted">
    1. <b>Descanso Gratis:</b> Calculado automáticamente del historial de partidos de Football-Data (días desde el último juego).<br>
    2. <b>Ventaja Local por Liga:</b> Ponderación dinámica (LaLiga 1.14x, Serie A 1.13x, Premier 1.07x).<br>
    3. <b>Big Balls 2ª Opinión:</b> Contraste automático contra predicciones externas.<br>
    4. <b>Banner VS y Medidor Circular:</b> Interfaz visual de alta gama con escudos reales y medidor de confianza.
  </div>

  <a href="/api/download-server" class="btn-download" style="margin-top:16px">
    📥 Descargar este archivo server.js listo para subir a Render
  </a>
</section>

</div>

<nav class="nav">
  <span id="navHome" class="active-nav">⌂<br>Inicio</span>
  <span id="navAnalyst"><strong>🧠<br>Analyst</strong></span>
  <span id="navDownload"><strong>⬇️<br>Descargar</strong></span>
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
    const icon = bbComp.agrees ? '🤝' : '⚠️';
    consensusBadge = '<div class="badge-tag ' + badgeCls + '">' + icon + ' ' + esc(bbComp.status) + '</div>';
  }

  let restBadge = '';
  if (restData) {
    restBadge = '<div class="badge-tag">⏱️ Descanso: Loc ' + esc(restData.home?.days != null ? restData.home.days + 'd' : '?') + ' vs Vis ' + esc(restData.away?.days != null ? restData.away.days + 'd' : '?') + '</div>';
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
        <strong style="display:block;font-size:14px;color:#fff">Confianza del Análisis: \${esc(level)}</strong>
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
            🕐 \${formatTime(f.kickoff)} · 🏆 \${esc(f.competition || 'Liga')}
          </div>
        </div>
        <button class="analyze-small" type="button" data-panel="\${panelId}" data-home="\${esc(f.home)}" data-away="\${esc(f.away)}" data-date="\${esc(date)}">
          🧠 ANALIZAR
        </button>
      </div>

      <div id="\${panelId}" class="analysis-panel">
        <div class="analysis-inner">
          <button class="analysis-close" type="button" data-close="\${panelId}">▲ CERRAR ANÁLISIS</button>

          <!-- Skeleton interno del análisis -->
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
    const data = await res.json();

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
    const data = await res.json();

    if (!res.ok || !data.ok) throw new Error(data.error || 'No se pudo analizar el partido.');

    // RENDERIZAR ANÁLISIS COMPLETO
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
        <div class="banner-meta-comp">🏆 \${esc(m.competition || 'Competición')}</div>
        <div class="banner-vs-circle">VS</div>
        <div class="banner-meta-time">🕐 \${formatTime(m.kickoff)}</div>
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

  // DECISIÓN VALUE BET
  const decisionClass = data.betEligible ? 'bet' : 'noBet';

  return \`
    \${bannerHtml}

    <div class="fixture-decision">
      <div class="section-label">Decisión del modelo</div>
      <h3 class="\${decisionClass}">\${esc(data.recommendation)}</h3>
      <div class="muted">\${esc(data.reason)}</div>
    </div>

    \${confidenceGaugeHtml}

    <!-- 2ª OPINIÓN BIG BALLS -->
    \${data.bigBallsComparison && data.bigBallsComparison.available ? \`
      <div class="value-box" style="border-color:\${data.bigBallsComparison.agrees ? '#1a5230' : '#5a261c'};background:\${data.bigBallsComparison.agrees ? '#0b1f14' : '#1e110f'}">
        <b style="color:\${data.bigBallsComparison.agrees ? '#7ee787' : '#ff7b72'}">
          \${data.bigBallsComparison.agrees ? '🤝 Consenso Big Balls' : '⚠️ Alerta de Divergencia Big Balls'}
        </b>
        <div class="muted" style="margin-top:4px">\${esc(data.bigBallsComparison.message)}</div>
      </div>
    \` : ''}

    <div class="section-label">📊 Probabilidades 1X2</div>
    <div class="prob-grid">
      <div class="prob"><span>🏠 LOCAL</span><b>\${pct(data.probabilities?.homeWin)}</b></div>
      <div class="prob"><span>🤝 EMPATE</span><b>\${pct(data.probabilities?.draw)}</b></div>
      <div class="prob"><span>✈️ VISITANTE</span><b>\${pct(data.probabilities?.awayWin)}</b></div>
    </div>

    <div class="section-label">⚽ xG Esperados (Localía \${data.homeAdvantage?.factor || 1.08}x)</div>
    <div class="xg-grid">
      <div class="xg"><span>LOCAL</span><b>\${data.xG?.home}</b></div>
      <div class="xg"><span>VISITANTE</span><b>\${data.xG?.away}</b></div>
      <div class="xg"><span>TOTAL</span><b>\${data.xG?.total}</b></div>
    </div>

    <div class="section-label">⏱️ Descanso Calculado (Football-Data)</div>
    <div class="market">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px">
        <span><b>\${esc(m.home)}:</b> \${esc(data.rest?.home?.status || 'Sin datos')}</span>
        <span>\${data.rest?.home?.impactPct ? data.rest.home.impactPct + '%' : '0%'}</span>
      </div>
      <div style="display:flex;justify-content:space-between">
        <span><b>\${esc(m.away)}:</b> \${esc(data.rest?.away?.status || 'Sin datos')}</span>
        <span>\${data.rest?.away?.impactPct ? data.rest.away.impactPct + '%' : '0%'}</span>
      </div>
    </div>

    <div class="section-label">🎯 Marcador Más Probable</div>
    <div class="market" style="text-align:center">
      <div style="font-size:32px;font-weight:900">\${esc(data.mostLikelyScore?.score)}</div>
      <div class="muted">Probabilidad: \${pct(data.mostLikelyScore?.probability)}</div>
    </div>
  \`;
}

// INICIALIZACIÓN
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

  document.getElementById('navHome')?.addEventListener('click', () => {
    document.getElementById('homeCard').style.display = 'block';
    document.getElementById('fixturesCard').style.display = 'none';
  });
  document.getElementById('navAnalyst')?.addEventListener('click', () => {
    document.getElementById('homeCard').style.display = 'none';
    searchFixtures();
  });
});
})();
</script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store,no-cache,must-revalidate,proxy-revalidate');
  res.type('html').send(renderPage());
});

app.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, modelVersion: MODEL_VERSION, uptime: process.uptime() });
});

app.listen(PORT, async () => {
  console.log(`MK Bets ${MODEL_VERSION} running on port ${PORT}`);
  await ensureSchema();
});
