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

    if (gf > ga) {
      points += 3;
    } else if (gf === ga) {
      points += 1;
    }
  }

  const avgGoalsFor = goalsFor / relevant.length;
  const avgGoalsAgainst = goalsAgainst / relevant.length;

  const attackStrength = Math.max(
    0.45,
    Math.min(1.8, avgGoalsFor / 1.35)
  );

  const defenseStrength = Math.max(
    0.45,
    Math.min(
      1.8,
      1.35 / Math.max(avgGoalsAgainst, 0.25)
    )
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
    formPct:
      (points / (relevant.length * 3)) * 100
  };
}

async function getFixture(date) {
  const key = `fixtures:${date}`;
  const cached = cacheGet(key);

  if (cached) return cached;

  const competitions =
    Object.keys(ODDS_SPORT_BY_COMPETITION);

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
      // Una competición que falle no debe tumbar el análisis.
    }
  }

  cacheSet(key, allMatches);

  return allMatches;
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
}async function footballData(path, options = {}) {
  const headers = {
    'X-Auth-Token': FOOTBALL_DATA_TOKEN,
    ...(options.headers || {})
  };

  return fetchJson(`${FOOTBALL_DATA_BASE}${path}`, {
    ...options,
    headers
  });
}

async function getTeamRecentMatches(teamId, limit = 10) {
  if (!teamId) return [];

  const data = await footballData(
    `/teams/${teamId}/matches?status=FINISHED&limit=${limit}`
  );

  return Array.isArray(data?.matches) ? data.matches : [];
}

function calculateRecentTeamStats(matches, teamId) {
  const stats = {
    matches: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    avgGoalsFor: 0,
    avgGoalsAgainst: 0,
    pointsPerGame: 0,
    form: []
  };

  if (!Array.isArray(matches) || !matches.length) {
    return stats;
  }

  for (const match of matches) {
    const isHome = Number(match?.homeTeam?.id) === Number(teamId);
    const isAway = Number(match?.awayTeam?.id) === Number(teamId);

    if (!isHome && !isAway) continue;

    const homeGoals = Number(match?.score?.fullTime?.home);
    const awayGoals = Number(match?.score?.fullTime?.away);

    if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) {
      continue;
    }

    const gf = isHome ? homeGoals : awayGoals;
    const ga = isHome ? awayGoals : homeGoals;

    stats.matches += 1;
    stats.goalsFor += gf;
    stats.goalsAgainst += ga;

    if (gf > ga) {
      stats.wins += 1;
      stats.form.push('W');
    } else if (gf === ga) {
      stats.draws += 1;
      stats.form.push('D');
    } else {
      stats.losses += 1;
      stats.form.push('L');
    }
  }

  if (stats.matches > 0) {
    stats.avgGoalsFor = stats.goalsFor / stats.matches;
    stats.avgGoalsAgainst = stats.goalsAgainst / stats.matches;
    stats.pointsPerGame =
      ((stats.wins * 3) + stats.draws) / stats.matches;
  }

  return stats;
}

async function getFixture(homeName, awayName, competitionCode = null) {
  const params = new URLSearchParams({
    status: 'SCHEDULED'
  });

  if (competitionCode) {
    params.set('competitions', competitionCode);
  }

  const data = await footballData(`/matches?${params.toString()}`);
  const matches = Array.isArray(data?.matches) ? data.matches : [];

  const fixture = matches.find(match => {
    const home = match?.homeTeam?.name || '';
    const away = match?.awayTeam?.name || '';

    return namesMatch(home, homeName) &&
           namesMatch(away, awayName);
  });

  return fixture || null;
}

async function selectFixture(homeName, awayName, competitionCode = null) {
  const fixture = await getFixture(
    homeName,
    awayName,
    competitionCode
  );

  if (fixture) return fixture;

  const allMatches = await footballData('/matches?status=SCHEDULED');
  const matches = Array.isArray(allMatches?.matches)
    ? allMatches.matches
    : [];

  return matches.find(match => {
    const home = match?.homeTeam?.name || '';
    const away = match?.awayTeam?.name || '';

    return namesMatch(home, homeName) &&
           namesMatch(away, awayName);
  }) || null;
}function collectPrice(prices, bookmaker, marketKey, outcomeKey, outcomeName) {
  const value = Number(prices?.[outcomeKey]);

  if (!Number.isFinite(value) || value <= 1) return;

  prices._items = prices._items || [];

  prices._items.push({
    bookmaker,
    marketKey,
    outcomeKey,
    outcomeName,
    odds: value
  });
}

function analyzePriceSet(items) {
  const valid = (items || [])
    .map(item => ({
      ...item,
      odds: Number(item.odds)
    }))
    .filter(item => Number.isFinite(item.odds) && item.odds > 1);

  if (!valid.length) {
    return {
      bestOdds: null,
      secondBestOdds: null,
      referenceOdds: null,
      supportCount: 0,
      bookmakerCount: 0,
      isOutlier: false,
      bestBookmaker: null
    };
  }

  const sortedDesc = [...valid].sort((a, b) => b.odds - a.odds);
  const uniqueDesc = uniqueNumbers(
    sortedDesc.map(item => item.odds)
  ).sort((a, b) => b - a);

  const bestOdds = uniqueDesc[0] || null;
  const secondBestOdds = uniqueDesc[1] || null;

  const referenceOdds = median(
    valid.map(item => item.odds)
  );

  const supportCount = valid.filter(item =>
    item.odds >= referenceOdds * 0.90 &&
    item.odds <= referenceOdds * 1.10
  ).length;

  const bookmakerCount = new Set(
    valid.map(item => item.bookmaker)
  ).size;

  const bestBookmaker =
    sortedDesc.find(item => item.odds === bestOdds)?.bookmaker || null;

  let isOutlier = false;

  if (bestOdds && referenceOdds) {
    if (bestOdds > referenceOdds * 1.30) {
      isOutlier = true;
    }

    if (
      bestOdds > referenceOdds * 1.20 &&
      supportCount < 2
    ) {
      isOutlier = true;
    }

    if (
      secondBestOdds &&
      bestOdds > secondBestOdds * 1.20
    ) {
      isOutlier = true;
    }
  }

  return {
    bestOdds,
    secondBestOdds,
    referenceOdds,
    supportCount,
    bookmakerCount,
    isOutlier,
    bestBookmaker
  };
}

function marketName(key) {
  const names = {
    home: 'Local',
    draw: 'Empate',
    away: 'Visitante',
    over25: 'Over 2.5',
    under25: 'Under 2.5'
  };

  return names[key] || key;
}

function buildMarket(
  key,
  probability,
  priceData
) {
  const probabilityPct = Number(probability) * 100;

  const bestOdds = Number(priceData?.bestOdds);
  const referenceOdds = Number(priceData?.referenceOdds);

  const bestImplied =
    bestOdds > 1
      ? (1 / bestOdds) * 100
      : null;

  const referenceImplied =
    referenceOdds > 1
      ? (1 / referenceOdds) * 100
      : null;

  const bestEvPct =
    bestOdds > 1
      ? ((Number(probability) * bestOdds) - 1) * 100
      : null;

  const referenceEvPct =
    referenceOdds > 1
      ? ((Number(probability) * referenceOdds) - 1) * 100
      : null;

  return {
    key,
    name: marketName(key),
    probability: probabilityPct,
    bestOdds: Number.isFinite(bestOdds) ? bestOdds : null,
    referenceOdds: Number.isFinite(referenceOdds)
      ? referenceOdds
      : null,
    bestImplied,
    referenceImplied,
    bestEvPct,
    referenceEvPct,
    secondBestOdds: priceData?.secondBestOdds ?? null,
    supportCount: Number(priceData?.supportCount || 0),
    bookmakerCount: Number(priceData?.bookmakerCount || 0),
    bestBookmaker: priceData?.bestBookmaker || null,
    isOutlier: Boolean(priceData?.isOutlier)
  };
}function buildMarkets(model, odds) {
  const markets = [];

  const priceGroups = {
    home: odds?.home || [],
    draw: odds?.draw || [],
    away: odds?.away || [],
    over25: odds?.over25 || [],
    under25: odds?.under25 || []
  };

  markets.push(
    buildMarket(
      'home',
      model.homeWin,
      analyzePriceSet(priceGroups.home)
    )
  );

  markets.push(
    buildMarket(
      'draw',
      model.draw,
      analyzePriceSet(priceGroups.draw)
    )
  );

  markets.push(
    buildMarket(
      'away',
      model.awayWin,
      analyzePriceSet(priceGroups.away)
    )
  );

  markets.push(
    buildMarket(
      'over25',
      model.over25,
      analyzePriceSet(priceGroups.over25)
    )
  );

  markets.push(
    buildMarket(
      'under25',
      model.under25,
      analyzePriceSet(priceGroups.under25)
    )
  );

  return markets;
}

function bestValue(markets, confidenceScore) {
  const eligible = (markets || [])
    .filter(market =>
      !market.isOutlier &&
      market.bookmakerCount >= 2 &&
      market.supportCount >= 2 &&
      market.probability >= 55 &&
      Number(confidenceScore) >= 60 &&
      Number(market.referenceEvPct) >= 2 &&
      Number(market.bestEvPct) >= 2
    )
    .sort((a, b) => {
      const evDiff =
        Number(b.referenceEvPct || 0) -
        Number(a.referenceEvPct || 0);

      if (evDiff !== 0) return evDiff;

      const probabilityDiff =
        Number(b.probability || 0) -
        Number(a.probability || 0);

      if (probabilityDiff !== 0) {
        return probabilityDiff;
      }

      return Number(b.supportCount || 0) -
        Number(a.supportCount || 0);
    });

  return eligible[0] || null;
}

function buildValueAlert(markets) {
  const suspicious = (markets || [])
    .filter(market => market.isOutlier)
    .sort(
      (a, b) =>
        Number(b.bestEvPct || 0) -
        Number(a.bestEvPct || 0)
    );

  if (!suspicious.length) {
    return null;
  }

  const market = suspicious[0];

  return {
    type: 'outlier',
    market: market.name,
    odds: market.bestOdds,
    referenceOdds: market.referenceOdds,
    bestEvPct: market.bestEvPct,
    referenceEvPct: market.referenceEvPct,
    supportCount: market.supportCount,
    bookmakerCount: market.bookmakerCount,
    message:
      `Precio atípico detectado en ${market.name}. ` +
      `La cuota ${market.bestOdds} está muy alejada ` +
      `del consenso (${market.referenceOdds}). ` +
      `No se utiliza para seleccionar Value Pick.`
  };
}

function mostLikelyScore(homeXg, awayXg) {
  let best = {
    home: 0,
    away: 0,
    probability: 0
  };

  for (let home = 0; home <= 7; home++) {
    for (let away = 0; away <= 7; away++) {
      const probability =
        poissonProbability(home, homeXg) *
        poissonProbability(away, awayXg);

      if (probability > best.probability) {
        best = {
          home,
          away,
          probability
        };
      }
    }
  }

  return best;
}

function poissonProbability(k, lambda) {
  if (!Number.isFinite(lambda) || lambda < 0) {
    return 0;
  }

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

function createModelInput(homeStats, awayStats) {
  const homeAttack =
    Number(homeStats?.avgGoalsFor || 0);

  const awayAttack =
    Number(awayStats?.avgGoalsFor || 0);

  const homeDefense =
    Number(homeStats?.avgGoalsAgainst || 0);

  const awayDefense =
    Number(awayStats?.avgGoalsAgainst || 0);

  let homeXg =
    ((homeAttack + awayDefense) / 2) * 1.08;

  let awayXg =
    (awayAttack + homeDefense) / 2;

  homeXg = Math.max(0.15, homeXg);
  awayXg = Math.max(0.15, awayXg);

  const totalXg = homeXg + awayXg;

  const probabilities = {
    homeWin: 0,
    draw: 0,
    awayWin: 0,
    over25: 0,
    under25: 0,
    btts: 0
  };

  for (let home = 0; home <= 8; home++) {
    for (let away = 0; away <= 8; away++) {
      const probability =
        poissonProbability(home, homeXg) *
        poissonProbability(away, awayXg);

      if (home > away) {
        probabilities.homeWin += probability;
      } else if (home === away) {
        probabilities.draw += probability;
      } else {
        probabilities.awayWin += probability;
      }

      if (home + away >= 3) {
        probabilities.over25 += probability;
      } else {
        probabilities.under25 += probability;
      }

      if (home >= 1 && away >= 1) {
        probabilities.btts += probability;
      }
    }
  }

  const score = mostLikelyScore(
    homeXg,
    awayXg
  );

  return {
    homeXg,
    awayXg,
    totalXg,
    ...probabilities,
    mostLikelyScore: score
  };
}

async function getOdds(
  homeName,
  awayName,
  competitionCode
) {
  if (!ODDS_API_KEY) {
    return {
      available: false,
      markets: {}
    };
  }

  const sport =
    ODDS_SPORT_BY_COMPETITION[competitionCode];

  if (!sport) {
    return {
      available: false,
      markets: {}
    };
  }

  const url =
    `${ODDS_API_BASE}/${sport}/odds` +
    `?apiKey=${encodeURIComponent(ODDS_API_KEY)}` +
    `&regions=eu,uk` +
    `&markets=h2h,totals` +
    `&oddsFormat=decimal`;

  const data = await fetchJson(url);

  const events = Array.isArray(data) ? data : [];

  const event = events.find(item => {
    const home = item?.home_team || '';
    const away = item?.away_team || '';

    return (
      namesMatch(home, homeName) &&
      namesMatch(away, awayName)
    );
  });

  if (!event) {
    return {
      available: false,
      markets: {}
    };
  }

  const markets = {
    home: [],
    draw: [],
    away: [],
    over25: [],
    under25: []
  };

  for (const bookmaker of event.bookmakers || []) {
    const bookmakerName =
      bookmaker?.title ||
      bookmaker?.key ||
      'Bookmaker';

    for (const market of bookmaker.markets || []) {
      if (market.key === 'h2h') {
        for (const outcome of market.outcomes || []) {
          const name =
            outcome?.name || '';

          const price =
            Number(outcome?.price);

          if (!Number.isFinite(price) || price <= 1) {
            continue;
          }

          if (namesMatch(name, homeName)) {
            markets.home.push({
              bookmaker: bookmakerName,
              odds: price
            });
          } else if (namesMatch(name, awayName)) {
            markets.away.push({
              bookmaker: bookmakerName,
              odds: price
            });
          } else if (
            name.toLowerCase() === 'draw'
          ) {
            markets.draw.push({
              bookmaker: bookmakerName,
              odds: price
            });
          }
        }
      }

      if (market.key === 'totals') {
        for (const outcome of market.outcomes || []) {
          const point =
            Number(outcome?.point);

          const price =
            Number(outcome?.price);

          if (
            point !== 2.5 ||
            !Number.isFinite(price) ||
            price <= 1
          ) {
            continue;
          }

          const name =
            String(outcome?.name || '')
              .toLowerCase();

          if (name === 'over') {
            markets.over25.push({
              bookmaker: bookmakerName,
              odds: price
            });
          }

          if (name === 'under') {
            markets.under25.push({
              bookmaker: bookmakerName,
              odds: price
            });
          }
        }
      }
    }
  }

  return {
    available: true,
    markets
  };
        }
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    footballDataConfigured: Boolean(FOOTBALL_DATA_TOKEN),
    oddsApiConfigured: Boolean(ODDS_API_KEY),
    provider: 'football-data.org + The Odds API',
    cacheMinutes: CACHE_MINUTES,
    modelVersion: MODEL_VERSION
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    modelVersion: MODEL_VERSION,
    uptime: process.uptime()
  });
});

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Pronóstico Deportivo V7.6.1</title>
      <style>
        body{
          margin:0;
          padding:30px 20px;
          background:#080b10;
          color:#fff;
          font-family:Arial,sans-serif;
          text-align:center;
        }
        .card{
          max-width:600px;
          margin:40px auto;
          padding:30px;
          background:#10151d;
          border-radius:20px;
        }
        h1{font-size:30px}
        .ok{color:#7ee787;font-weight:bold}
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🧠 V7.6.1 ANALYST</h1>
        <p class="ok">● SERVIDOR ACTIVO</p>
        <p>El motor de pronósticos está funcionando correctamente.</p>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`V7.6.1 ANALYST running on port ${PORT}`);
});
