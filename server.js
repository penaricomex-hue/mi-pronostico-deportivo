const express = require('express');

const {
  matchModel,
  pct,
  implied,
  ev,
  confidence,
  stabilizeStats,
  shrinkToMean
} = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const MODEL_VERSION = 'V7.6.1';

const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const ODDS_API_KEY = process.env.ODDS_API_KEY;

const ODDS_SPORT_BY_COMPETITION = {
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  BL1: 'soccer_germany_bundesliga',
  SA: 'soccer_italy_serie_a',
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
  EL: 'soccer_uefa_europa_league'
};

const CACHE_MINUTES = 5;

const cache = new Map();

function now() {
  return Date.now();
}

function cacheGet(key) {
  const item = cache.get(key);

  if (!item) return null;

  if (now() - item.time > CACHE_MINUTES * 60 * 1000) {
    cache.delete(key);
    return null;
  }

  return item.data;
}

function cacheSet(key, data) {
  cache.set(key, {
    time: now(),
    data
  });
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function namesMatch(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);

  if (!x || !y) return false;
  if (x === y) return true;

  if (x.length < 6 || y.length < 6) return false;

  return x.includes(y) || y.includes(x);
}

function median(values) {
  const nums = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!nums.length) return null;

  const middle = Math.floor(nums.length / 2);

  if (nums.length % 2) {
    return nums[middle];
  }

  return (nums[middle - 1] + nums[middle]) / 2;
}

function uniqueNumbers(values) {
  return [...new Set(
    values
      .map(Number)
      .filter(Number.isFinite)
      .map(v => Number(v.toFixed(4)))
  )];
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);

  let data = null;

  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message =
      data?.message ||
      data?.error ||
      data?.errors?.message ||
      `HTTP ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

async function footballData(path) {
  if (!FOOTBALL_DATA_TOKEN) {
    throw new Error('FOOTBALL_DATA_TOKEN no configurado');
  }

  const key = `football:${path}`;
  const cached = cacheGet(key);

  if (cached) return cached;

  const data = await fetchJson(
    `${FOOTBALL_DATA_BASE}${path}`,
    {
      headers: {
        'X-Auth-Token': FOOTBALL_DATA_TOKEN
      }
    }
  );

  cacheSet(key, data);

  return data;
}

async function getTeamRecentMatches(teamId) {
  const key = `team:${teamId}:recent`;

  const cached = cacheGet(key);

  if (cached) return cached;

  const data = await footballData(
    `/teams/${teamId}/matches?status=FINISHED&limit=20`
  );

  const matches = Array.isArray(data?.matches)
    ? data.matches
    : [];

  cacheSet(key, matches);

  return matches;
}

function calculateRecentTeamStats(teamId, matches) {
  const relevant = matches
    .filter(match =>
      match?.homeTeam?.id === teamId ||
      match?.awayTeam?.id === teamId
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

  for (const match of relevant) {
    const home = Number(match?.score?.fullTime?.home ?? 0);
    const away = Number(match?.score?.fullTime?.away ?? 0);

    const isHome = match?.homeTeam?.id === teamId;

    const gf = isHome ? home : away;
    const ga = isHome ? away : home;

    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) points += 3;
    else if (gf === ga) points += 1;
  }

  const avgGoalsFor = goalsFor / relevant.length;
  const avgGoalsAgainst = goalsAgainst / relevant.length;

  const attackStrength = Math.max(
    0.45,
    Math.min(1.8, avgGoalsFor / 1.35)
  );

  const defenseStrength = Math.max(
    0.45,
    Math.min(1.8, 1.35 / Math.max(avgGoalsAgainst, 0.25))
  );

  return {
    matches: relevant.length,
    goalsFor,
    goalsAgainst,
    avgGoalsFor,
    avgGoalsAgainst,
    attackStrength,
    defenseStrength,
    formPoints: points,
    formPct: (points / (relevant.length * 3)) * 100
  };
}

async function getFixture(date) {
  const key = `fixtures:${date}`;

  const cached = cacheGet(key);

  if (cached) return cached;

  const competitions = Object.keys(ODDS_SPORT_BY_COMPETITION);

  const allMatches = [];

  for (const code of competitions) {
    try {
      const data = await footballData(
        `/competitions/${code}/matches?dateFrom=${date}&dateTo=${date}`
      );

      if (Array.isArray(data?.matches)) {
        allMatches.push(
          ...data.matches.map(match => ({
            ...match,
            competitionCode: code
          }))
        );
      }
    } catch {
      // Una competición que falle no debe tumbar todo el análisis.
    }
  }

  cacheSet(key, allMatches);

  return allMatches;
}

function parseDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function selectFixture(matches, homeName, awayName) {
  const direct = matches.find(match =>
    namesMatch(match?.homeTeam?.name, homeName) &&
    namesMatch(match?.awayTeam?.name, awayName)
  );

  if (direct) {
    return {
      fixture: direct,
      reversed: false
    };
  }

  const reversed = matches.find(match =>
    namesMatch(match?.homeTeam?.name, awayName) &&
    namesMatch(match?.awayTeam?.name, homeName)
  );

  if (reversed) {
    return {
      fixture: reversed,
      reversed: true
    };
  }

  return null;
}

function collectPrice(prices, bookmaker, odds) {
  if (!Number.isFinite(odds) || odds <= 1) return;

  prices.push({
    bookmaker,
    odds: Number(odds)
  });
}

/*
 * Analizador robusto de precios.
 *
 * La idea V7.6.1:
 *
 * bestOdds      = mejor precio disponible.
 * referenceOdds = mediana del mercado.
 * secondBest    = segunda mejor cuota.
 *
 * Una cuota exageradamente alta frente al consenso se considera
 * sospechosa y NO puede generar Value Pick.
 */
function analyzePriceSet(prices) {
  const valid = prices
    .filter(item =>
      item &&
      Number.isFinite(Number(item.odds)) &&
      Number(item.odds) > 1
    )
    .map(item => ({
      bookmaker: item.bookmaker || 'Unknown',
      odds: Number(item.odds)
    }));

  if (!valid.length) {
    return {
      bestOdds: null,
      referenceOdds: null,
      secondBestOdds: null,
      bookmakerCount: 0,
      supportCount: 0,
      priceGapPct: 0,
      secondGapPct: 0,
      isOutlier: false,
      marketDepth: 'none',
      prices: []
    };
  }

  const odds = valid
    .map(x => x.odds)
    .sort((a, b) => a - b);

  const referenceOdds = median(odds);
  const bestOdds = odds[odds.length - 1];

  const uniqueDescending = uniqueNumbers(odds)
    .sort((a, b) => b - a);

  const secondBestOdds =
    uniqueDescending.length > 1
      ? uniqueDescending[1]
      : null;

  /*
   * Una cuota cuenta como respaldada si está dentro de 10%
   * de la referencia del mercado.
   */
  const supportCount = odds.filter(odd =>
    referenceOdds &&
    Math.abs(odd - referenceOdds) / referenceOdds <= 0.10
  ).length;

  const priceGapPct = referenceOdds
    ? ((bestOdds / referenceOdds) - 1) * 100
    : 0;

  const secondGapPct =
    secondBestOdds
      ? ((bestOdds / secondBestOdds) - 1) * 100
      : 0;

  /*
   * Reglas anti-outlier:
   *
   * 1. Si la mejor cuota supera 30% la mediana:
   *    sospechosa automáticamente.
   *
   * 2. Si supera 20% y además no tiene suficiente respaldo:
   *    sospechosa.
   *
   * 3. Si supera 20% a la segunda mejor cuota:
   *    sospechosa.
   */
  const extremeAgainstReference =
    bestOdds > referenceOdds * 1.30;

  const weakAgainstReference =
    bestOdds > referenceOdds * 1.20 &&
    supportCount < 2;

  const extremeAgainstSecond =
    secondBestOdds !== null &&
    bestOdds > secondBestOdds * 1.20;

  const isOutlier =
    odds.length >= 2 &&
    (
      extremeAgainstReference ||
      weakAgainstReference ||
      extremeAgainstSecond
    );

  let marketDepth = 'low';

  if (odds.length >= 6 && supportCount >= 4) {
    marketDepth = 'strong';
  } else if (odds.length >= 3 && supportCount >= 2) {
    marketDepth = 'medium';
  }

  return {
    bestOdds,
    referenceOdds,
    secondBestOdds,
    bookmakerCount: valid.length,
    supportCount,
    priceGapPct,
    secondGapPct,
    isOutlier,
    marketDepth,
    prices: valid
  };
}

function marketName(type, outcome) {
  if (type === 'h2h') {
    if (outcome === 'home') return 'Gana local';
    if (outcome === 'draw') return 'Empate';
    if (outcome === 'away') return 'Gana visitante';
  }

  if (type === 'totals') {
    if (outcome === 'over') return 'Over 2.5';
    if (outcome === 'under') return 'Under 2.5';
  }

  return outcome;
}

function buildMarket({
  type,
  outcome,
  probability,
  prices
}) {
  const priceInfo = analyzePriceSet(prices);

  const modelProbability = Number(probability);

  const bestEvPct =
    priceInfo.bestOdds
      ? ev(modelProbability, priceInfo.bestOdds)
      : null;

  const referenceEvPct =
    priceInfo.referenceOdds
      ? ev(modelProbability, priceInfo.referenceOdds)
      : null;

  const impliedBest =
    priceInfo.bestOdds
      ? implied(priceInfo.bestOdds)
      : null;

  const impliedReference =
    priceInfo.referenceOdds
      ? implied(priceInfo.referenceOdds)
      : null;

  const valueEligible =
    priceInfo.bookmakerCount >= 2 &&
    priceInfo.supportCount >= 2 &&
    !priceInfo.isOutlier &&
    Number.isFinite(referenceEvPct) &&
    referenceEvPct > 0;

  return {
    type,
    outcome,
    name: marketName(type, outcome),

    probability: modelProbability,

    odds: priceInfo.bestOdds,
    bestOdds: priceInfo.bestOdds,
    referenceOdds: priceInfo.referenceOdds,
    secondBestOdds: priceInfo.secondBestOdds,

    impliedProbability: impliedBest,
    referenceImpliedProbability: impliedReference,

    evPct: bestEvPct,
    bestEvPct,
    referenceEvPct,

    bookmaker: priceInfo.prices
      .find(x => x.odds === priceInfo.bestOdds)
      ?.bookmaker || null,

    bookmakerCount: priceInfo.bookmakerCount,
    supportCount: priceInfo.supportCount,

    priceGapPct: Number(priceInfo.priceGapPct.toFixed(1)),
    secondGapPct: Number(priceInfo.secondGapPct.toFixed(1)),

    isOutlier: priceInfo.isOutlier,
    marketDepth: priceInfo.marketDepth,

    valueEligible,

    valueLevel:
      priceInfo.isOutlier
        ? 'Precio atípico'
        : referenceEvPct >= 10
          ? 'Valor fuerte'
          : referenceEvPct >= 5
            ? 'Valor'
            : referenceEvPct > 0
              ? 'Valor leve'
              : 'Sin valor'
  };
}

function buildMarkets(model, oddsData, fixture) {
  const markets = [];

  const h2hPrices = {
    home: [],
    draw: [],
    away: []
  };

  const totalPrices = {
    over: [],
    under: []
  };

  const bookmakers = Array.isArray(oddsData?.bookmakers)
    ? oddsData.bookmakers
    : [];

  for (const bookmaker of bookmakers) {
    const bookmakerName =
      bookmaker?.title ||
      bookmaker?.key ||
      'Unknown';

    const marketsList = Array.isArray(bookmaker?.markets)
      ? bookmaker.markets
      : [];

    for (const market of marketsList) {
      if (market?.key === 'h2h') {
        for (const outcome of market.outcomes || []) {
          const name = outcome?.name;
          const price = Number(outcome?.price);

          if (namesMatch(name, fixture.homeName)) {
            collectPrice(
              h2hPrices.home,
              bookmakerName,
              price
            );
          } else if (namesMatch(name, fixture.awayName)) {
            collectPrice(
              h2hPrices.away,
              bookmakerName,
              price
            );
          } else if (
            normalizeName(name) === 'draw' ||
            normalizeName(name) === 'tie' ||
            normalizeName(name) === 'empate'
          ) {
            collectPrice(
              h2hPrices.draw,
              bookmakerName,
              price
            );
          }
        }
      }

      if (market?.key === 'totals') {
        for (const outcome of market.outcomes || []) {
          const point = Number(outcome?.point);
          const name = normalizeName(outcome?.name);
          const price = Number(outcome?.price);

          if (point !== 2.5) continue;

          if (name === 'over') {
            collectPrice(
              totalPrices.over,
              bookmakerName,
              price
            );
          }

          if (name === 'under') {
            collectPrice(
              totalPrices.under,
              bookmakerName,
              price
            );
          }
        }
      }
    }
  }

  markets.push(
    buildMarket({
      type: 'h2h',
      outcome: 'home',
      probability: model.homeWin,
      prices: h2hPrices.home
    })
  );

  markets.push(
    buildMarket({
      type: 'h2h',
      outcome: 'draw',
      probability: model.draw,
      prices: h2hPrices.draw
    })
  );

  markets.push(
    buildMarket({
      type: 'h2h',
      outcome: 'away',
      probability: model.awayWin,
      prices: h2hPrices.away
    })
  );

  markets.push(
    buildMarket({
      type: 'totals',
      outcome: 'over',
      probability: model.over25,
      prices: totalPrices.over
    })
  );

  markets.push(
    buildMarket({
      type: 'totals',
      outcome: 'under',
      probability: model.under25,
      prices: totalPrices.under
    })
  );

  return markets;
}

/*
 * Value Pick V7.6.1
 *
 * IMPORTANTE:
 * No usamos solamente bestEvPct.
 *
 * El EV de una cuota aislada puede ser enorme y falso.
 * El filtro principal utiliza referenceEvPct, basado en
 * el consenso del mercado.
 */
function bestValue(markets, modelConfidence) {
  const candidates = markets
    .filter(market =>
      market.valueEligible &&
      market.bookmakerCount >= 2 &&
      market.supportCount >= 2 &&
      !market.isOutlier &&
      market.probability >= 55 &&
      Number(market.referenceEvPct) >= 2 &&
      Number(market.bestEvPct) >= 2 &&
      Number(modelConfidence) >= 60
    )
    .sort((a, b) => {
      if (b.referenceEvPct !== a.referenceEvPct) {
        return b.referenceEvPct - a.referenceEvPct;
      }

      if (b.probability !== a.probability) {
        return b.probability - a.probability;
      }

      return b.supportCount - a.supportCount;
    });

  return candidates[0] || null;
}

function buildValueAlert(markets) {
  const outliers = markets
    .filter(market =>
      market.isOutlier &&
      market.odds
    )
    .sort((a, b) =>
      Number(b.bestEvPct || 0) -
      Number(a.bestEvPct || 0)
    );

  if (outliers.length) {
    const market = outliers[0];

    return {
      type: 'outlier',
      market: market.name,
      odds: market.bestOdds,
      bestEvPct: market.bestEvPct,
      referenceOdds: market.referenceOdds,
      referenceEvPct: market.referenceEvPct,
      bookmaker: market.bookmaker,
      message:
        `La cuota ${market.bestOdds.toFixed(2)} está muy ` +
        `alejada del consenso del mercado. Se excluye del ` +
        `Value Pick para evitar una falsa oportunidad.`
    };
  }

  const positive = markets
    .filter(market =>
      Number(market.referenceEvPct) > 0 &&
      market.odds
    )
    .sort((a, b) =>
      Number(b.referenceEvPct) -
      Number(a.referenceEvPct)
    );

  if (positive.length) {
    const market = positive[0];

    return {
      type: 'normal',
      market: market.name,
      odds: market.bestOdds,
      bestEvPct: market.bestEvPct,
      referenceOdds: market.referenceOdds,
      referenceEvPct: market.referenceEvPct,
      bookmaker: market.bookmaker,
      message:
        `El modelo detecta una ventaja moderada, ` +
        `pero debe superar todos los filtros antes de recomendar apuesta.`
    };
  }

  return null;
}

function mostLikelyScore(homeXg, awayXg) {
  let best = {
    home: 0,
    away: 0,
    probability: 0
  };

  const homeLambda = Math.max(0.01, Number(homeXg));
  const awayLambda = Math.max(0.01, Number(awayXg));

  function poisson(k, lambda) {
    let factorial = 1;

    for (let i = 2; i <= k; i++) {
      factorial *= i;
    }

    return (
      Math.exp(-lambda) *
      Math.pow(lambda, k) /
      factorial
    );
  }

  for (let home = 0; home <= 7; home++) {
    for (let away = 0; away <= 7; away++) {
      const probability =
        poisson(home, homeLambda) *
        poisson(away, awayLambda);

      if (probability > best.probability) {
        best = {
          home,
          away,
          probability
        };
      }
    }
  }

  return {
    score: `${best.home}-${best.away}`,
    probability: Number((best.probability * 100).toFixed(1))
  };
}

function createModelInput(homeStats, awayStats) {
  const homeAttack =
    homeStats.avgGoalsFor *
    Math.max(0.75, Math.min(1.35, homeStats.attackStrength));

  const awayAttack =
    awayStats.avgGoalsFor *
    Math.max(0.75, Math.min(1.35, awayStats.attackStrength));

  const homeDefense =
    homeStats.avgGoalsAgainst;

  const awayDefense =
    awayStats.avgGoalsAgainst;

  let homeXg =
    (
      homeAttack +
      awayDefense
    ) / 2;

  let awayXg =
    (
      awayAttack +
      homeDefense
    ) / 2;

  /*
   * Ventaja local moderada.
   */
  homeXg *= 1.08;

  /*
   * Evitamos valores extremos derivados de muestras pequeñas.
   */
  homeXg = Math.max(0.25, Math.min(3.8, homeXg));
  awayXg = Math.max(0.20, Math.min(3.5, awayXg));

  return {
    homeXg,
    awayXg
  };
}

async function getOdds(homeName, awayName, competitionCode, kickoff) {
  if (!ODDS_API_KEY) {
    return {
      available: false,
      reason: 'ODDS_API_KEY no configurada'
    };
  }

  const sport =
    ODDS_SPORT_BY_COMPETITION[competitionCode];

  if (!sport) {
    return {
      available: false,
      reason: 'Competición no soportada por The Odds API'
    };
  }

  const cacheKey =
    `odds:${sport}:${normalizeName(homeName)}:${normalizeName(awayName)}`;

  const cached = cacheGet(cacheKey);

  if (cached) return cached;

  const url =
    `${ODDS_BASE}/sports/${sport}/odds` +
    `?regions=us,uk` +
    `&markets=h2h,totals` +
    `&oddsFormat=decimal` +
    `&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;

  let data;

  try {
    data = await fetchJson(url);
  } catch (error) {
    return {
      available: false,
      reason: error.message,
      errorStatus: error.status || null
    };
  }

  const events = Array.isArray(data)
    ? data
    : [];

  /*
   * Primero buscamos coincidencia directa.
   * Si viene invertida, se corrige la orientación.
   */
  let event = events.find(item =>
    namesMatch(item?.home_team, homeName) &&
    namesMatch(item?.away_team, awayName)
  );

  let reversed = false;

  if (!event) {
    event = events.find(item =>
      namesMatch(item?.home_team, awayName) &&
      namesMatch(item?.away_team, homeName)
    );

    reversed = Boolean(event);
  }

  if (!event) {
    return {
      available: false,
      reason: 'Partido no encontrado en The Odds API'
    };
  }

  const bookmakers = Array.isArray(event?.bookmakers)
    ? event.bookmakers
    : [];

  const normalizedBookmakers = bookmakers.map(bookmaker => {
    if (!reversed) {
      return bookmaker;
    }

    /*
     * Si el evento viene invertido, intercambiamos los nombres
     * de las selecciones para que buildMarkets vea correctamente
     * Local y Visitante.
     */
    const clone = {
      ...bookmaker,
      markets: (bookmaker.markets || []).map(market => {
        if (market.key !== 'h2h') {
          return market;
        }

        return {
          ...market,
          outcomes: (market.outcomes || []).map(outcome => {
            if (namesMatch(outcome.name, event.home_team)) {
              return {
                ...outcome,
                name: homeName
              };
            }

            if (namesMatch(outcome.name, event.away_team)) {
              return {
                ...outcome,
                name: awayName
              };
            }

            return outcome;
          })
        };
      })
    };

    return clone;
  });

  const result = {
    available: true,
    eventId: event.id || null,
    commenceTime: event.commence_time || kickoff || null,
    homeTeam: homeName,
    awayTeam: awayName,
    reversed,
    bookmakers: normalizedBookmakers
  };

  cacheSet(cacheKey, result);

  return result;
}

function formatPct(value) {
  if (!Number.isFinite(Number(value))) {
    return '-';
  }

  return `${Number(value).toFixed(1)}%`;
}

function marketHtml(market) {
  const outlier = market.isOutlier;

  return `
    <div class="market">
      <div class="market-top">
        <strong>${market.name}</strong>
        <span>${formatPct(market.probability)}</span>
      </div>

      <div class="market-details">
        <span>
          Mejor cuota:
          <b>${market.bestOdds ? market.bestOdds.toFixed(2) : '-'}</b>
        </span>

        <span>
          Mercado:
          <b>${market.referenceOdds ? market.referenceOdds.toFixed(2) : '-'}</b>
        </span>

        <span>
          EV mercado:
          <b>${market.referenceEvPct !== null
            ? `${market.referenceEvPct >= 0 ? '+' : ''}${market.referenceEvPct.toFixed(1)}%`
            : '-'}</b>
        </span>

        <span>
          Casas:
          <b>${market.bookmakerCount}</b>
        </span>
      </div>

      ${
        outlier
          ? `
            <div class="warning">
              ⚠️ Precio atípico · excluido de Value Pick
            </div>
          `
          : ''
      }
    </div>
  `;
}

function renderPage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport"
      content="width=device-width, initial-scale=1.0,
      maximum-scale=1.0,user-scalable=no">

<title>Pronóstico Deportivo V7.6.1</title>

<style>
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  background: #080b10;
  color: #f5f7fa;
}

button,
input,
select {
  font: inherit;
}

.app {
  max-width: 760px;
  margin: 0 auto;
  padding: 18px 14px 90px;
}

.header {
  padding: 12px 4px 20px;
}

.version {
  display: inline-block;
  padding: 6px 10px;
  border-radius: 999px;
  background: #171c25;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .5px;
}

h1 {
  margin: 18px 0 8px;
  font-size: 32px;
  line-height: 1.05;
}

.subtitle {
  color: #9da5b2;
  font-size: 15px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin: 16px 0;
}

.chip {
  background: #151a22;
  border: 1px solid #252c37;
  border-radius: 999px;
  padding: 8px 10px;
  font-size: 12px;
}

.card {
  background: #10151d;
  border: 1px solid #242b36;
  border-radius: 18px;
  padding: 16px;
  margin-top: 14px;
}

.card-title {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #929ba9;
  margin-bottom: 12px;
}

input,
select {
  width: 100%;
  background: #090d13;
  border: 1px solid #303846;
  color: white;
  border-radius: 12px;
  padding: 13px;
  margin-bottom: 10px;
  outline: none;
}

.primary {
  width: 100%;
  border: 0;
  border-radius: 13px;
  padding: 14px;
  background: #f4f5f7;
  color: #080b10;
  font-weight: 900;
  cursor: pointer;
}

.primary:disabled {
  opacity: .55;
}

.result {
  display: none;
}

.decision {
  text-align: center;
  padding: 22px 10px;
}

.decision h2 {
  margin: 8px 0;
  font-size: 30px;
}

.noBet {
  color: #ffb45d;
}

.bet {
  color: #7ee787;
}

.score {
  font-size: 38px;
  font-weight: 900;
  margin: 10px 0;
}

.scoreProb {
  color: #9da5b2;
}

.prob-grid {
  display: grid;
  grid-template-columns: repeat(3,1fr);
  gap: 8px;
}

.prob {
  background: #090d13;
  border-radius: 12px;
  padding: 12px 8px;
  text-align: center;
}

.prob span {
  display: block;
  color: #8e97a5;
  font-size: 11px;
  margin-bottom: 5px;
}

.prob b {
  font-size: 20px;
}

.xg-grid {
  display: grid;
  grid-template-columns: repeat(3,1fr);
  gap: 8px;
}

.xg {
  background: #090d13;
  border-radius: 12px;
  padding: 12px 8px;
  text-align: center;
}

.xg span {
  display: block;
  color: #8e97a5;
  font-size: 11px;
}

.xg b {
  display: block;
  margin-top: 5px;
  font-size: 21px;
}

.market {
  background: #090d13;
  border-radius: 13px;
  padding: 12px;
  margin-bottom: 8px;
}

.market-top {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.market-top span {
  font-weight: 800;
}

.market-details {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 10px;
  color: #8e97a5;
  font-size: 12px;
}

.market-details b {
  color: white;
}

.warning {
  margin-top: 9px;
  padding: 8px;
  border-radius: 9px;
  background: #291b0d;
  color: #ffc078;
  font-size: 12px;
}

.value-box {
  border: 1px solid #33414d;
  border-radius: 13px;
  padding: 13px;
}

.value-box h3 {
  margin: 0 0 8px;
}

.muted {
  color: #9099a7;
}

.loading {
  text-align: center;
  color: #9da5b2;
  padding: 18px;
}

.error {
  color: #ff7b72;
}

.nav {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  max-width: 760px;
  margin: auto;
  background: rgba(10,13,18,.96);
  border-top: 1px solid #252c37;
  display: flex;
  justify-content: space-around;
  padding: 11px 5px;
  font-size: 11px;
  color: #929ba9;
}

.nav strong {
  color: white;
}
</style>
</head>

<body>

<div class="app">

  <header class="header">
    <span class="version">● V7.6.1 ANALYST</span>

    <h1>Analiza antes de apostar.</h1>

    <div class="subtitle">
      Modelo estadístico + xG + forma + cuotas reales +
      filtro de valor.
    </div>

    <div class="chips">
      <span class="chip">📊 1X2</span>
      <span class="chip">⚽ xG</span>
      <span class="chip">🥅 BTTS</span>
      <span class="chip">💰 VALUE</span>
      <span class="chip">🎯 CONFIDENCE</span>
      <span class="chip">🛡️ NO BET FILTER</span>
    </div>
  </header>

  <section class="card">
    <div class="card-title">Partido</div>

    <input
      id="home"
      placeholder="Equipo local"
      autocomplete="off"
    >

    <input
      id="away"
      placeholder="Equipo visitante"
      autocomplete="off"
    >

    <input
      id="date"
      type="date"
    >

    <button
      class="primary"
      id="analyzeBtn"
      onclick="analyze()">
      🧠 ANALIZAR CON V7.6.1
    </button>
  </section>

  <div id="loading" class="loading" style="display:none">
    Analizando partido...
  </div>

  <div id="error" class="card error" style="display:none"></div>

  <main id="result" class="result">

    <section class="card decision">
      <div class="card-title">Decisión del modelo</div>
      <h2 id="decision"></h2>
      <div id="decisionText" class="muted"></div>
    </section>

    <section class="card">
      <div class="card-title">🎯 Marcador más probable</div>

      <div id="teams" class="muted"></div>
      <div id="score" class="score"></div>
      <div id="scoreProb" class="scoreProb"></div>
    </section>

    <section class="card">
      <div class="card-title">📊 Probabilidades</div>

      <div class="prob-grid">
        <div class="prob">
          <span>🏠 LOCAL</span>
          <b id="homeProb">-</b>
        </div>

        <div class="prob">
          <span>🤝 EMPATE</span>
          <b id="drawProb">-</b>
        </div>

        <div class="prob">
          <span>✈️ VISITANTE</span>
          <b id="awayProb">-</b>
        </div>
      </div>

      <br>

      <div class="prob-grid">
        <div class="prob">
          <span>OVER 2.5</span>
          <b id="overProb">-</b>
        </div>

        <div class="prob">
          <span>UNDER 2.5</span>
          <b id="underProb">-</b>
        </div>

        <div class="prob">
          <span>BTTS</span>
          <b id="bttsProb">-</b>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-title">⚽ Goles esperados · xG</div>

      <div class="xg-grid">
        <div class="xg">
          <span>LOCAL</span>
          <b id="homeXg">-</b>
        </div>

        <div class="xg">
          <span>VISITANTE</span>
          <b id="awayXg">-</b>
        </div>

        <div class="xg">
          <span>TOTAL</span>
          <b id="totalXg">-</b>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-title">🎯 Confianza del análisis</div>

      <h2 id="confidenceLevel"></h2>

      <div class="muted">
        Puntuación técnica:
        <b id="confidenceScore"></b> / 100
      </div>

      <p id="confidenceExplanation" class="muted"></p>
    </section>

    <section class="card">
      <div class="card-title">💪 Fuerza reciente</div>
      <div id="form"></div>
    </section>

    <section class="card">
      <div class="card-title">💰 Cuotas reales</div>
      <div id="markets"></div>
    </section>

    <section class="card">
      <div class="card-title">🛡️ Value Pick</div>
      <div id="value"></div>
    </section>

    <section class="card">
      <div class="card-title">⚠️ Revisión de valor</div>
      <div id="alert"></div>
    </section>

  </main>
</div>

<nav class="nav">
  <span>⌂<br>Inicio</span>
  <span><strong>🧠<br>Analyst</strong></span>
  <span>💰<br>Value</span>
</nav>

<script>
function pctText(value) {
  if (value === null || value === undefined) return '-';
  return Number(value).toFixed(1) + '%';
}

function moneyPct(value) {
  if (value === null || value === undefined) return '-';

  const n = Number(value);

  return (n >= 0 ? '+' : '') +
    n.toFixed(1) + '%';
}

async function analyze() {
  const home =
    document.getElementById('home').value.trim();

  const away =
    document.getElementById('away').value.trim();

  const date =
    document.getElementById('date').value;

  const loading =
    document.getElementById('loading');

  const error =
    document.getElementById('error');

  const result =
    document.getElementById('result');

  if (!home || !away) {
    error.style.display = 'block';
    error.textContent =
      'Escribe el equipo local y el visitante.';
    result.style.display = 'none';
    return;
  }

  error.style.display = 'none';
  result.style.display = 'none';
  loading.style.display = 'block';

  try {
    const params =
      new URLSearchParams({
        home,
        away,
        ...(date ? { date } : {})
      });

    const response =
      await fetch('/api/analyze?' + params.toString(), {
        cache: 'no-store'
      });

    const data =
      await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(
        data.message ||
        data.error ||
        'No se pudo analizar el partido.'
      );
    }

    render(data);

    result.style.display = 'block';

  } catch (err) {
    error.style.display = 'block';
    error.textContent =
      err.message || 'Error de análisis.';
  } finally {
    loading.style.display = 'none';
  }
}

function render(data) {
  const decision =
    document.getElementById('decision');

  decision.textContent =
    data.recommendation || 'NO BET';

  decision.className =
    data.betEligible ? 'bet' : 'noBet';

  document.getElementById('decisionText')
    .textContent =
      data.reason || '';

  document.getElementById('teams')
    .textContent =
      data.match?.home +
      ' vs ' +
      data.match?.away;

  document.getElementById('score')
    .textContent =
      data.mostLikelyScore?.score || '-';

  document.getElementById('scoreProb')
    .textContent =
      'Probabilidad estimada: ' +
      pctText(data.mostLikelyScore?.probability);

  document.getElementById('homeProb')
    .textContent =
      pctText(data.probabilities?.homeWin);

  document.getElementById('drawProb')
    .textContent =
      pctText(data.probabilities?.draw);

  document.getElementById('awayProb')
    .textContent =
      pctText(data.probabilities?.awayWin);

  document.getElementById('overProb')
    .textContent =
      pctText(data.probabilities?.over25);

  document.getElementById('underProb')
    .textContent =
      pctText(data.probabilities?.under25);

  document.getElementById('bttsProb')
    .textContent =
      pctText(data.probabilities?.btts);

  document.getElementById('homeXg')
    .textContent =
      Number(data.xG?.home || 0).toFixed(2);

  document.getElementById('awayXg')
    .textContent =
      Number(data.xG?.away || 0).toFixed(2);

  document.getElementById('totalXg')
    .textContent =
      Number(data.xG?.total || 0).toFixed(2);

  document.getElementById('confidenceLevel')
    .textContent =
      data.confidenceLevel || '-';

  document.getElementById('confidenceScore')
    .textContent =
      data.confidence ?? '-';

  document.getElementById('confidenceExplanation')
    .textContent =
      data.confidenceExplanation || '';

  const form =
    document.getElementById('form');

  const local =
    data.recentForm?.home;

  const visitor =
    data.recentForm?.away;

  form.innerHTML = `
    <div class="market">
      <b>LOCAL · ATAQUE</b>
      <div class="muted">
        ${Number(local?.avgGoalsFor || 0).toFixed(2)}
        · Form ${pctText(local?.formPct)}
      </div>
    </div>

    <div class="market">
      <b>VISITANTE · ATAQUE</b>
      <div class="muted">
        ${Number(visitor?.avgGoalsFor || 0).toFixed(2)}
        · Form ${pctText(visitor?.formPct)}
      </div>
    </div>
  `;

  const markets =
    document.getElementById('markets');

  if (!data.oddsAvailable) {
    markets.innerHTML =
      '<div class="muted">Cuotas reales no disponibles.</div>';
  } else {
    markets.innerHTML =
      (data.markets || [])
        .map(marketHtml)
        .join('');
  }

  const value =
    document.getElementById('value');

  if (data.bestValue) {
    const v = data.bestValue;

    value.innerHTML = `
      <div class="value-box">
        <h3>💰 ${v.name}</h3>

        <div class="muted">
          Probabilidad modelo:
          <b>${pctText(v.probability)}</b>
        </div>

        <div class="muted">
          Mejor cuota:
          <b>${v.bestOdds?.toFixed(2) || '-'}</b>
        </div>

        <div class="muted">
          Cuota mercado:
          <b>${v.referenceOdds?.toFixed(2) || '-'}</b>
        </div>

        <div class="muted">
          EV mercado:
          <b>${moneyPct(v.referenceEvPct)}</b>
        </div>

        <div class="muted">
          EV mejor cuota:
          <b>${moneyPct(v.bestEvPct)}</b>
        </div>

        <div class="muted">
          ${v.bookmaker || 'Casa no disponible'}
          · ${v.bookmakerCount} casas
        </div>
      </div>
    `;
  } else {
    value.innerHTML = `
      <div class="value-box">
        <h3>🚫 SIN VALUE PICK</h3>
        <div class="muted">
          No existe una oportunidad que cumpla
          simultáneamente los filtros de probabilidad,
          EV, confianza, respaldo de mercado y
          control de outliers.
        </div>
      </div>
    `;
  }

  const alert =
    document.getElementById('alert');

  if (data.valueAlert) {
    const a = data.valueAlert;

    alert.innerHTML = `
      <div class="value-box">
        <h3>
          ${
            a.type === 'outlier'
              ? '🟠 PRECIO ATÍPICO'
              : '📊 REVISIÓN'
          }
        </h3>

        <div>
          <b>${a.market}</b>
        </div>

        <div class="muted">
          Mejor cuota:
          ${a.odds ? Number(a.odds).toFixed(2) : '-'}
        </div>

        <div class="muted">
          Cuota de mercado:
          ${
            a.referenceOdds
              ? Number(a.referenceOdds).toFixed(2)
              : '-'
          }
        </div>

        <p class="muted">
          ${a.message}
        </p>
      </div>
    `;
  } else {
    alert.innerHTML =
      '<div class="muted">No se detectaron anomalías relevantes.</div>';
  }
}
</script>

</body>
</html>`;
}

/*
 * API STATUS
 */
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    footballDataConfigured: Boolean(FOOTBALL_DATA_TOKEN),
    oddsApiConfigured: Boolean(ODDS_API_KEY),
    provider:
      'football-data.org + The Odds API',
    cacheMinutes: CACHE_MINUTES,
    modelVersion: MODEL_VERSION
  });
});

/*
 * API ANALYZE
 */
app.get('/api/analyze', async (req, res) => {
  try {
    const homeName =
      String(req.query.home || '').trim();

    const awayName =
      String(req.query.away || '').trim();

    const requestedDate =
      String(req.query.date || '').trim();

    if (!homeName || !awayName) {
      return res.status(400).json({
        ok: false,
        error:
          'Debes proporcionar home y away.'
      });
    }

    let date = requestedDate;

    if (!date) {
      date = new Date()
        .toISOString()
        .slice(0, 10);
    }

    const fixtures =
      await getFixture(date);

    let selected =
      selectFixture(
        fixtures,
        homeName,
        awayName
      );

    /*
     * Si no aparece en la fecha solicitada,
     * buscamos el siguiente día como tolerancia.
     */
    if (!selected) {
      const nextDate =
        new Date(`${date}T12:00:00`);

      nextDate.setDate(
        nextDate.getDate() + 1
      );

      const next =
        nextDate
          .toISOString()
          .slice(0, 10);

      const nextFixtures =
        await getFixture(next);

      selected =
        selectFixture(
          nextFixtures,
          homeName,
          awayName
        );

      if (selected) {
        date = next;
      }
    }

    if (!selected) {
      return res.status(404).json({
        ok: false,
        error:
          'No se encontró el partido solicitado en las competiciones configuradas.'
      });
    }

    const fixture =
      selected.fixture;

    /*
     * Normalizamos nombres siempre a la perspectiva
     * que solicita el usuario.
     */
    const homeId =
      selected.reversed
        ? fixture.awayTeam.id
        : fixture.homeTeam.id;

    const awayId =
      selected.reversed
        ? fixture.homeTeam.id
        : fixture.awayTeam.id;

    const actualHomeName = homeName;
    const actualAwayName = awayName;

    const [
      homeMatches,
      awayMatches
    ] = await Promise.all([
      getTeamRecentMatches(homeId),
      getTeamRecentMatches(awayId)
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
     * Estabilización para evitar que una muestra pequeña
     * produzca xG exagerado.
     */
    try {
      homeStats =
        stabilizeStats(homeStats) ||
        homeStats;

      awayStats =
        stabilizeStats(awayStats) ||
        awayStats;
    } catch {
      // Continuamos con las estadísticas originales.
    }

    try {
      homeStats =
        shrinkToMean(homeStats) ||
        homeStats;

      awayStats =
        shrinkToMean(awayStats) ||
        awayStats;
    } catch {
      // Continuamos.
    }

    const modelInput =
      createModelInput(
        homeStats,
        awayStats
      );

    const model =
      matchModel(
        modelInput.homeXg,
        modelInput.awayXg
      );

    /*
     * Confidence V7.6.1
     */
    let modelConfidence = 50;

    try {
      modelConfidence =
        confidence({
          homeXg: modelInput.homeXg,
          awayXg: modelInput.awayXg,
          homeStats,
          awayStats,
          model
        });
    } catch {
      /*
       * Fallback robusto.
       */
      const sample =
        Math.min(
          1,
          (
            homeStats.matches +
            awayStats.matches
          ) / 20
        );

      const dominance =
        Math.abs(
          model.homeWin -
          model.awayWin
        );

      modelConfidence =
        Math.round(
          45 +
          sample * 15 +
          dominance * 30
        );
    }

    modelConfidence =
      Math.max(
        0,
        Math.min(
          100,
          Number(modelConfidence) || 50
        )
      );

    /*
     * Buscamos cuotas reales.
     */
    const odds =
      await getOdds(
        actualHomeName,
        actualAwayName,
        fixture.competitionCode,
        fixture.utcDate
      );

    const markets =
      odds.available
        ? buildMarkets(
            model,
            odds,
            {
              homeName: actualHomeName,
              awayName: actualAwayName
            }
          )
        : [];

    /*
     * EV de mercado, NO EV de una cuota sospechosa.
     */
    const topReferenceEv =
      markets
        .map(m => Number(m.referenceEvPct))
        .filter(Number.isFinite)
        .reduce(
          (max, value) =>
            Math.max(max, value),
          -Infinity
        );

    /*
     * Si confidence() dio un resultado extremo,
     * lo estabilizamos.
     */
    const confidenceAdjusted =
      Math.max(
        0,
        Math.min(
          100,
          Math.round(
            Number(modelConfidence)
          )
        )
      );

    /*
     * Un Value Pick requiere:
     *
     * - probabilidad >= 55%
     * - confidence >= 60
     * - EV positivo en referencia
     * - cuota real
     * - suficiente respaldo
     * - no outlier
     */
    const value =
      bestValue(
        markets,
        confidenceAdjusted
      );

    const betEligible =
      Boolean(value) &&
      confidenceAdjusted >= 60 &&
      Number(value.referenceEvPct) >= 2 &&
      Number(value.probability) >= 55;

    const recommendation =
      betEligible
        ? value.name
        : 'NO BET';

    let reason;

    if (betEligible) {
      reason =
        `El modelo detecta valor respaldado por el mercado ` +
        `con ${value.probability.toFixed(1)}% de probabilidad ` +
        `y EV de mercado de ${value.referenceEvPct.toFixed(1)}%.`;
    } else {
      reason =
        'No existe una oportunidad de valor positiva que ' +
        'cumpla los filtros de probabilidad, EV, confianza ' +
        'y respaldo del mercado.';
    }

    let confidenceLevel = 'Baja';

    if (confidenceAdjusted >= 75) {
      confidenceLevel = 'Alta';
    } else if (confidenceAdjusted >= 60) {
      confidenceLevel = 'Media';
    }

    const confidenceExplanation =
      confidenceAdjusted >= 75
        ? 'El análisis presenta una señal estadística fuerte y suficiente respaldo.'
        : confidenceAdjusted >= 60
          ? 'El análisis presenta respaldo moderado, pero debe mantenerse disciplina en la selección.'
          : 'La señal no es suficientemente sólida para justificar una apuesta.';

    const score =
      mostLikelyScore(
        modelInput.homeXg,
        modelInput.awayXg
      );

    const valueAlert =
      buildValueAlert(markets);

    return res.json({
      ok: true,

      modelVersion: MODEL_VERSION,

      match: {
        id: fixture.id || null,
        home: actualHomeName,
        away: actualAwayName,
        date,
        kickoff: fixture.utcDate || null,
        competition:
          fixture.competition?.name ||
          fixture.competitionCode ||
          null
      },

      recommendation,
      reason,
      betEligible,
      strength:
        value?.valueLevel ||
        'Sin valor',

      recentForm: {
        home: homeStats,
        away: awayStats
      },

      averages: {
        home: {
          goalsFor:
            Number(homeStats.avgGoalsFor.toFixed(2)),
          goalsAgainst:
            Number(homeStats.avgGoalsAgainst.toFixed(2))
        },

        away: {
          goalsFor:
            Number(awayStats.avgGoalsFor.toFixed(2)),
          goalsAgainst:
            Number(awayStats.avgGoalsAgainst.toFixed(2))
        }
      },

      xG: {
        home:
          Number(modelInput.homeXg.toFixed(2)),
        away:
          Number(modelInput.awayXg.toFixed(2)),
        total:
          Number(
            (
              modelInput.homeXg +
              modelInput.awayXg
            ).toFixed(2)
          )
      },

      mostLikelyScore: score,

      probabilities: {
        homeWin:
          Number(model.homeWin.toFixed(4)) * 100,

        draw:
          Number(model.draw.toFixed(4)) * 100,

        awayWin:
          Number(model.awayWin.toFixed(4)) * 100,

        over25:
          Number(model.over25.toFixed(4)) * 100,

        under25:
          Number(model.under25.toFixed(4)) * 100,

        btts:
          Number(model.btts.toFixed(4)) * 100
      },

      markets,

      oddsAvailable:
        Boolean(odds.available),

      oddsReason:
        odds.available
          ? null
          : odds.reason || null,

      bestValue:
        value || null,

      valueAlert,

      confidence:
        confidenceAdjusted,

      confidenceLevel,

      confidenceExplanation,

      diagnostics: {
        topReferenceEv:
          Number.isFinite(topReferenceEv)
            ? Number(topReferenceEv.toFixed(2))
            : null,

        outlierMarkets:
          markets
            .filter(m => m.isOutlier)
            .map(m => ({
              name: m.name,
              bestOdds: m.bestOdds,
              referenceOdds: m.referenceOdds,
              bestEvPct: m.bestEvPct,
              referenceEvPct: m.referenceEvPct
            })),

        valueFilter: {
          minimumProbability: 55,
          minimumConfidence: 60,
          minimumReferenceEv: 2,
          minimumBookmakers: 2,
          minimumSupport: 2,
          outliersAllowed: false
        }
      }
    });

  } catch (error) {
    console.error(
      'ANALYZE ERROR:',
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        error.message ||
        'Error interno del servidor.',
      modelVersion: MODEL_VERSION
    });
  }
});

/*
 * HOME
 */
app.get('/', (req, res) => {
  res.set(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate'
  );

  res.set(
    'Pragma',
    'no-cache'
  );

  res.set(
    'Expires',
    '0'
  );

  res.type('html').send(
    renderPage()
  );
});

/*
 * HEALTH
 */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    modelVersion: MODEL_VERSION,
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(
    `V7.6.1 ANALYST running on port ${PORT}`
  );
});
