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

const MODEL_VERSION = 'V7.6.2';

const FOOTBALL_DATA_BASE =
  'https://api.football-data.org/v4';

const ODDS_BASE =
  'https://api.the-odds-api.com/v4';

const FOOTBALL_DATA_TOKEN =
  process.env.FOOTBALL_DATA_TOKEN;

const ODDS_API_KEY =
  process.env.ODDS_API_KEY;

const CACHE_MINUTES = 5;

const ODDS_SPORT_BY_COMPETITION = {
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  BL1: 'soccer_germany_bundesliga',
  SA: 'soccer_italy_serie_a',
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
  EL: 'soccer_uefa_europa_league'
};

const cache = new Map();

function now() {
  return Date.now();
}

function cacheGet(key) {
  const item = cache.get(key);

  if (!item) {
    return null;
  }

  if (
    now() - item.time >
    CACHE_MINUTES * 60 * 1000
  ) {
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

  if (!x || !y) {
    return false;
  }

  if (x === y) {
    return true;
  }

  if (x.length < 6 || y.length < 6) {
    return false;
  }

  return (
    (x.length >= 8 && y.includes(x)) ||
    (y.length >= 8 && x.includes(y))
  );
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

  if (nums.length % 2) {
    return nums[middle];
  }

  return (
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

async function fetchJson(
  url,
  options = {}
) {
  const response =
    await fetch(url, options);

  let data = null;

  try {
    data = await response.json();
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

    error.data = data;

    throw error;
  }

  return data;
}

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

  cacheSet(key, data);

  return data;
}

/* =========================================================
   FIXTURES
   ========================================================= */

async function getFixture(date) {
  const key =
    `fixtures:${date}`;

  const cached =
    cacheGet(key);

  if (cached) {
    console.log(
      `[FIXTURES] ${date}: CACHE HIT -> ${cached.length}`
    );

    return cached;
  }

  console.log('');
  console.log(
    '================================================'
  );
  console.log(
    `[FIXTURES] INICIANDO ${date}`
  );
  console.log(
    '================================================'
  );

  const allMatches = [];

  for (
    const code of Object.keys(
      ODDS_SPORT_BY_COMPETITION
    )
  ) {
    try {
      const path =
        `/competitions/${code}/matches?dateFrom=${date}&dateTo=${date}`;

      const data =
        await footballData(path);

      const matches =
        Array.isArray(data?.matches)
          ? data.matches
          : [];

      console.log(
        `[FIXTURES] ${date} ${code}: ${matches.length} partidos`
      );

      allMatches.push(
        ...matches.map(match => ({
          ...match,
          competitionCode: code
        }))
      );
    } catch (error) {
      console.error(
        `[FIXTURES] ${date} ${code}: ERROR`,
        error?.message || error
      );

      if (error?.status) {
        console.error(
          `HTTP: ${error.status}`
        );
      }
    }
  }

  console.log(
    `[FIXTURES] ${date}: TOTAL=${allMatches.length}`
  );

  cacheSet(
    key,
    allMatches
  );

  return allMatches;
}

function selectFixture(
  matches,
  homeName,
  awayName
) {
  const direct =
    matches.find(
      match =>
        namesMatch(
          match?.homeTeam?.name,
          homeName
        ) &&
        namesMatch(
          match?.awayTeam?.name,
          awayName
        )
    );

  if (direct) {
    return {
      fixture: direct,
      reversed: false
    };
  }

  const reversed =
    matches.find(
      match =>
        namesMatch(
          match?.homeTeam?.name,
          awayName
        ) &&
        namesMatch(
          match?.awayTeam?.name,
          homeName
        )
    );

  if (reversed) {
    return {
      fixture: reversed,
      reversed: true
    };
  }

  return null;
}

/* =========================================================
   TEAM DATA
   ========================================================= */

async function getTeamRecentMatches(
  teamId
) {
  const key =
    `team:${teamId}:recent`;

  const cached =
    cacheGet(key);

  if (cached) {
    return cached;
  }

  const data =
    await footballData(
      `/teams/${teamId}/matches?status=FINISHED&limit=20`
    );

  const matches =
    Array.isArray(data?.matches)
      ? data.matches
      : [];

  cacheSet(
    key,
    matches
  );

  return matches;
}

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
      isHome ? home : away;

    const ga =
      isHome ? away : home;

    goalsFor += gf;
    goalsAgainst += ga;

    if (gf > ga) {
      points += 3;
    } else if (gf === ga) {
      points += 1;
    }
  }

  const avgGoalsFor =
    goalsFor / relevant.length;

  const avgGoalsAgainst =
    goalsAgainst / relevant.length;

  return {
    matches: relevant.length,

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

    formPoints: points,

    formPct:
      (points /
        (relevant.length * 3)) *
      100
  };
}

/* =========================================================
   MODEL
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
    ) / 2 * 1.08;

  const awayXg =
    (
      awayAttack +
      homeStats.avgGoalsAgainst
    ) / 2;

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
      Math.pow(lambda, k) /
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
            Number(homeXg)
          )
        ) *
        poisson(
          away,
          Math.max(
            0.01,
            Number(awayXg)
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
   ODDS
   ========================================================= */

function collectPrice(
  prices,
  bookmaker,
  odds
) {
  const n =
    Number(odds);

  if (
    !Number.isFinite(n) ||
    n <= 1
  ) {
    return;
  }

  prices.push({
    bookmaker:
      bookmaker || 'Unknown',
    odds: n
  });
}

function analyzePriceSet(
  prices
) {
  const valid =
    prices
      .filter(
        item =>
          item &&
          Number.isFinite(
            Number(item.odds)
          ) &&
          Number(item.odds) > 1
      )
      .map(item => ({
        bookmaker:
          item.bookmaker ||
          'Unknown',
        odds:
          Number(item.odds)
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

  const odds =
    valid
      .map(item => item.odds)
      .sort(
        (a, b) => a - b
      );

  const referenceOdds =
    median(odds);

  const bestOdds =
    odds[odds.length - 1];

  const descending =
    uniqueNumbers(odds)
      .sort(
        (a, b) => b - a
      );

  const secondBestOdds =
    descending.length > 1
      ? descending[1]
      : null;

  const supportCount =
    odds.filter(
      value =>
        referenceOdds &&
        Math.abs(
          value - referenceOdds
        ) /
        referenceOdds <=
        0.10
    ).length;

  const priceGapPct =
    referenceOdds
      ? (
          bestOdds /
          referenceOdds -
          1
        ) * 100
      : 0;

  const secondGapPct =
    secondBestOdds
      ? (
          bestOdds /
          secondBestOdds -
          1
        ) * 100
      : 0;

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

  let marketDepth = 'low';

  if (
    odds.length >= 6 &&
    supportCount >= 4
  ) {
    marketDepth = 'strong';
  } else if (
    odds.length >= 3 &&
    supportCount >= 2
  ) {
    marketDepth = 'medium';
  }

  return {
    bestOdds,
    referenceOdds,
    secondBestOdds,
    bookmakerCount:
      valid.length,
    supportCount,
    priceGapPct,
    secondGapPct,
    isOutlier,
    marketDepth,
    prices: valid
  };
}

function marketName(
  type,
  outcome
) {
  if (type === 'h2h') {
    if (outcome === 'home') {
      return 'Gana local';
    }

    if (outcome === 'draw') {
      return 'Empate';
    }

    return 'Gana visitante';
  }

  if (type === 'totals') {
    return outcome === 'over'
      ? 'Over 2.5'
      : 'Under 2.5';
  }

  return outcome;
}

function buildMarket({
  type,
  outcome,
  probability,
  prices
}) {
  const info =
    analyzePriceSet(prices);

  const modelProbability =
    Number(probability);

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

  const impliedBest =
    info.bestOdds
      ? implied(
          info.bestOdds
        )
      : null;

  const impliedReference =
    info.referenceOdds
      ? implied(
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

  return {
    type,
    outcome,

    name:
      marketName(
        type,
        outcome
      ),

    probability:
      modelProbability,

    odds:
      info.bestOdds,

    bestOdds:
      info.bestOdds,

    referenceOdds:
      info.referenceOdds,

    secondBestOdds:
      info.secondBestOdds,

    impliedProbability:
      impliedBest,

    referenceImpliedProbability:
      impliedReference,

    evPct:
      bestEvPct,

    bestEvPct,

    referenceEvPct,

    bookmaker:
      info.prices.find(
        item =>
          item.odds ===
          info.bestOdds
      )?.bookmaker || null,

    bookmakerCount:
      info.bookmakerCount,

    supportCount:
      info.supportCount,

    priceGapPct:
      Number(
        info.priceGapPct.toFixed(1)
      ),

    secondGapPct:
      Number(
        info.secondGapPct.toFixed(1)
      ),

    isOutlier:
      info.isOutlier,

    marketDepth:
      info.marketDepth,

    valueEligible,

    valueLevel:
      info.isOutlier
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

function buildMarkets(
  model,
  oddsData,
  fixture
) {
  const h2h = {
    home: [],
    draw: [],
    away: []
  };

  const totals = {
    over: [],
    under: []
  };

  const bookmakers =
    Array.isArray(
      oddsData?.bookmakers
    )
      ? oddsData.bookmakers
      : [];

  for (
    const bookmaker of bookmakers
  ) {
    const bookmakerName =
      bookmaker?.title ||
      bookmaker?.key ||
      'Unknown';

    const markets =
      Array.isArray(
        bookmaker?.markets
      )
        ? bookmaker.markets
        : [];

    for (
      const market of markets
    ) {
      if (
        market?.key === 'h2h'
      ) {
        for (
          const outcome of
          market.outcomes || []
        ) {
          const name =
            outcome?.name;

          const price =
            Number(
              outcome?.price
            );

          if (
            namesMatch(
              name,
              fixture.homeName
            )
          ) {
            collectPrice(
              h2h.home,
              bookmakerName,
              price
            );
          } else if (
            namesMatch(
              name,
              fixture.awayName
            )
          ) {
            collectPrice(
              h2h.away,
              bookmakerName,
              price
            );
          } else if (
            [
              'draw',
              'tie',
              'empate'
            ].includes(
              normalizeName(name)
            )
          ) {
            collectPrice(
              h2h.draw,
              bookmakerName,
              price
            );
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

          const name =
            normalizeName(
              outcome?.name
            );

          const price =
            Number(
              outcome?.price
            );

          if (name === 'over') {
            collectPrice(
              totals.over,
              bookmakerName,
              price
            );
          }

          if (name === 'under') {
            collectPrice(
              totals.under,
              bookmakerName,
              price
            );
          }
        }
      }
    }
  }

  return [
    buildMarket({
      type: 'h2h',
      outcome: 'home',
      probability:
        model.homeWin,
      prices:
        h2h.home
    }),

    buildMarket({
      type: 'h2h',
      outcome: 'draw',
      probability:
        model.draw,
      prices:
        h2h.draw
    }),

    buildMarket({
      type: 'h2h',
      outcome: 'away',
      probability:
        model.awayWin,
      prices:
        h2h.away
    }),

    buildMarket({
      type: 'totals',
      outcome: 'over',
      probability:
        model.over25,
      prices:
        totals.over
    }),

    buildMarket({
      type: 'totals',
      outcome: 'under',
      probability:
        model.under25,
      prices:
        totals.under
    })
  ];
}

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
        market.probability >= 55 &&
        Number(
          market.referenceEvPct
        ) >= 2 &&
        Number(
          market.bestEvPct
        ) >= 2 &&
        Number(
          modelConfidence
        ) >= 60
    )
    .sort(
      (a, b) =>
        Number(
          b.referenceEvPct
        ) -
        Number(
          a.referenceEvPct
        ) ||
        b.probability -
        a.probability ||
        b.supportCount -
        a.supportCount
    )[0] || null;
}

function buildValueAlert(
  markets
) {
  const outliers =
    markets
      .filter(
        market =>
          market.isOutlier &&
          market.odds
      )
      .sort(
        (a, b) =>
          Number(
            b.bestEvPct || 0
          ) -
          Number(
            a.bestEvPct || 0
          )
      );

  if (outliers.length) {
    const market =
      outliers[0];

    return {
      type: 'outlier',
      market:
        market.name,

      odds:
        market.bestOdds,

      bestEvPct:
        market.bestEvPct,

      referenceOdds:
        market.referenceOdds,

      referenceEvPct:
        market.referenceEvPct,

      bookmaker:
        market.bookmaker,

      message:
        `La cuota ${market.bestOdds.toFixed(2)} está muy alejada del consenso del mercado. Se excluye del Value Pick para evitar una falsa oportunidad.`
    };
  }

  const positive =
    markets
      .filter(
        market =>
          Number(
            market.referenceEvPct
          ) > 0 &&
          market.odds
      )
      .sort(
        (a, b) =>
          Number(
            b.referenceEvPct
          ) -
          Number(
            a.referenceEvPct
          )
      );

  if (positive.length) {
    const market =
      positive[0];

    return {
      type: 'normal',
      market:
        market.name,

      odds:
        market.bestOdds,

      bestEvPct:
        market.bestEvPct,

      referenceOdds:
        market.referenceOdds,

      referenceEvPct:
        market.referenceEvPct,

      bookmaker:
        market.bookmaker,

      message:
        'El modelo detecta una ventaja moderada, pero debe superar todos los filtros antes de recomendar apuesta.'
    };
  }

  return null;
}

async function getOdds(
  homeName,
  awayName,
  competitionCode,
  kickoff
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
        'Competición no soportada por The Odds API'
    };
  }

  const cacheKey =
    `odds:${sport}:${normalizeName(homeName)}:${normalizeName(awayName)}`;

  const cached =
    cacheGet(cacheKey);

  if (cached) {
    return cached;
  }

  const url =
    `${ODDS_BASE}/sports/${sport}/odds?regions=us,uk&markets=h2h,totals&oddsFormat=decimal&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;

  let data;

  try {
    data =
      await fetchJson(url);
  } catch (error) {
    return {
      available: false,
      reason:
        error.message,
      errorStatus:
        error.status || null
    };
  }

  const events =
    Array.isArray(data)
      ? data
      : [];

  let event =
    events.find(
      item =>
        namesMatch(
          item?.home_team,
          homeName
        ) &&
        namesMatch(
          item?.away_team,
          awayName
        )
    );

  let reversed = false;

  if (!event) {
    event =
      events.find(
        item =>
          namesMatch(
            item?.home_team,
            awayName
          ) &&
          namesMatch(
            item?.away_team,
            homeName
          )
      );

    reversed =
      Boolean(event);
  }

  if (!event) {
    return {
      available: false,
      reason:
        'Partido no encontrado en The Odds API'
    };
  }

  const bookmakers =
    Array.isArray(
      event?.bookmakers
    )
      ? event.bookmakers
      : [];

  const normalizedBookmakers =
    bookmakers.map(
      bookmaker => {
        if (!reversed) {
          return bookmaker;
        }

        return {
          ...bookmaker,

          markets:
            (
              bookmaker.markets ||
              []
            ).map(
              market => {
                if (
                  market.key !==
                  'h2h'
                ) {
                  return market;
                }

                return {
                  ...market,

                  outcomes:
                    (
                      market.outcomes ||
                      []
                    ).map(
                      outcome => {
                        if (
                          namesMatch(
                            outcome.name,
                            event.home_team
                          )
                        ) {
                          return {
                            ...outcome,
                            name:
                              homeName
                          };
                        }

                        if (
                          namesMatch(
                            outcome.name,
                            event.away_team
                          )
                        ) {
                          return {
                            ...outcome,
                            name:
                              awayName
                          };
                        }

                        return outcome;
                      }
                    )
                };
              }
            )
        };
      }
    );

  const result = {
    available: true,

    eventId:
      event.id || null,

    commenceTime:
      event.commence_time ||
      kickoff ||
      null,

    homeTeam:
      homeName,

    awayTeam:
      awayName,

    reversed,

    bookmakers:
      normalizedBookmakers
  };

  cacheSet(
    cacheKey,
    result
  );

  return result;
}

/* =========================================================
   HTML HELPERS
   ========================================================= */

function htmlEscape(value) {
  return String(
    value === null ||
    value === undefined
      ? ''
      : value
  )
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatPct(value) {
  return Number.isFinite(
    Number(value)
  )
    ? `${Number(value).toFixed(1)}%`
    : '-';
}

function marketHtml(
  market
) {
  const evMarket =
    market.referenceEvPct == null
      ? '-'
      : `${market.referenceEvPct >= 0 ? '+' : ''}${Number(market.referenceEvPct).toFixed(1)}%`;

  return (
    `<div class="market">` +
      `<div class="market-top">` +
        `<strong>${htmlEscape(market.name)}</strong>` +
        `<span>${formatPct(market.probability)}</span>` +
      `</div>` +

      `<div class="market-details">` +

        `<span>Mejor cuota: <b>` +
        `${
          market.bestOdds
            ? Number(
                market.bestOdds
              ).toFixed(2)
            : '-'
        }` +
        `</b></span>` +

        `<span>Mercado: <b>` +
        `${
          market.referenceOdds
            ? Number(
                market.referenceOdds
              ).toFixed(2)
            : '-'
        }` +
        `</b></span>` +

        `<span>EV mercado: <b>` +
        evMarket +
        `</b></span>` +

        `<span>Casas: <b>` +
        market.bookmakerCount +
        `</b></span>` +

      `</div>` +

      (
        market.isOutlier
          ? `<div class="warning">⚠️ Precio atípico · excluido de Value Pick</div>`
          : ''
      ) +

    `</div>`
  );
}

/* =========================================================
   PAGE
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

<title>
Pronóstico Deportivo ${MODEL_VERSION}
</title>

<style>

*{
  box-sizing:border-box;
}

body{
  margin:0;
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
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
  padding:18px 14px 90px;
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
  letter-spacing:.5px;
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
  opacity:.6;
  cursor:wait;
}

.secondary{
  width:100%;
  border:1px solid #303846;
  border-radius:13px;
  padding:13px;
  background:#151a22;
  color:#fff;
  font-weight:800;
  cursor:pointer;
  margin-top:8px;
}

.loading{
  text-align:center;
  color:#9da5b2;
  padding:18px;
}

.error{
  color:#ff7b72;
}

.nav{
  position:fixed;
  bottom:0;
  left:0;
  right:0;
  max-width:760px;
  margin:auto;
  background:rgba(10,13,18,.96);
  border-top:1px solid #252c37;
  display:flex;
  justify-content:space-around;
  padding:11px 5px;
  font-size:11px;
  color:#929ba9;
  z-index:20;
}

.nav strong{
  color:white;
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
  cursor:pointer;
}

.analyze-small:disabled{
  opacity:.55;
  cursor:wait;
}

.analysis-panel{
  display:none;
  margin-top:12px;
  border-top:1px solid #252c37;
  padding-top:12px;
}

.analysis-panel.open{
  display:block;
}

.analysis-close{
  width:100%;
  border:1px solid #303846;
  border-radius:10px;
  padding:10px;
  background:#151a22;
  color:#fff;
  font-weight:800;
  cursor:pointer;
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

.bet{
  color:#7ee787;
}

.noBet{
  color:#ffb45d;
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

.warning{
  margin-top:9px;
  padding:8px;
  border-radius:9px;
  background:#291b0d;
  color:#ffc078;
  font-size:12px;
}

.value-box{
  border:1px solid #33414d;
  border-radius:13px;
  padding:13px;
  margin-bottom:8px;
}

.value-box h3{
  margin:0 0 8px;
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

@media(max-width:520px){

  .fixture-head{
    flex-direction:column;
  }

  .analyze-small{
    width:100%;
  }

  .prob-grid,
  .xg-grid{
    grid-template-columns:repeat(3,1fr);
  }

}

</style>

</head>

<body>

<div class="app">

<header class="header">

<span class="version">
● ${MODEL_VERSION} ANALYST
</span>

<h1>
Analiza antes de apostar.
</h1>

<div class="subtitle">
Modelo estadístico + xG + forma + cuotas reales + filtro de valor.
</div>

<div class="chips">

<span class="chip">
📊 1X2
</span>

<span class="chip">
⚽ xG
</span>

<span class="chip">
🥅 BTTS
</span>

<span class="chip">
💰 VALUE
</span>

<span class="chip">
🎯 CONFIDENCE
</span>

<span class="chip">
🛡️ NO BET FILTER
</span>

</div>

</header>

<section class="card">

<div class="card-title">
Buscar partidos por fecha
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

</section>

</div>

<nav class="nav">

<span>
⌂<br>
Inicio
</span>

<span>
<strong>
🧠<br>
Analyst
</strong>
</span>

<span>
💰<br>
Value
</span>

</nav>

<script>

/* =========================================================
   FRONTEND HELPERS
   ========================================================= */

function esc(value){
  return String(
    value === null ||
    value === undefined
      ? ''
      : value
  )
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
}

function pctText(value){
  if(
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ){
    return '-';
  }

  return (
    Number(value).toFixed(1) +
    '%'
  );
}

function moneyPct(value){
  if(
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ){
    return '-';
  }

  const n =
    Number(value);

  return (
    n >= 0 ? '+' : ''
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

  const parts =
    value.split('-');

  if(parts.length !== 3){
    return value;
  }

  return (
    parts[2] +
    '/' +
    parts[1] +
    '/' +
    parts[0]
  );
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

/* =========================================================
   FIXTURE HTML
   IMPORTANTE:
   ESTA FUNCIÓN ESTÁ EN EL SCRIPT DEL NAVEGADOR.
   LOS ARGUMENTOS SE INSERTAN CON JSON ESCAPADO.
   ========================================================= */

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

  const buttonArgs =
    [
      panelId,
      fixture.home,
      fixture.away,
      date
    ]
      .map(
        value =>
          JSON.stringify(
            String(
              value ?? ''
            )
          )
      )
      .join(',');

  const closeArg =
    JSON.stringify(
      panelId
    );

  return (

    '<article class="fixture">' +

      '<div class="fixture-head">' +

        '<div>' +

          '<div class="fixture-teams">' +
            '⚽ ' +
            esc(fixture.home) +
            ' vs ' +
            esc(fixture.away) +
          '</div>' +

          '<div class="fixture-meta">' +
            '🕐 ' +
            formatTime(
              fixture.kickoff
            ) +
            ' · 🏆 ' +
            esc(
              fixture.competition ||
              fixture.competitionCode ||
              'Competición'
            ) +
          '</div>' +

        '</div>' +

        '<button ' +
          'type="button" ' +
          'class="analyze-small" ' +
          'data-panel="' +
          esc(panelId) +
          '" ' +
          'onclick=\'openAnalysis(' +
          buttonArgs +
          ')\'>' +
          '🧠 ANALIZAR' +
        '</button>' +

      '</div>' +

      '<div id="' +
        esc(panelId) +
        '" ' +
        'class="analysis-panel">' +

        '<button ' +
          'type="button" ' +
          'class="analysis-close" ' +
          'onclick=\'closeAnalysis(' +
          closeArg +
          ')\'>' +
          '▲ CERRAR ANÁLISIS' +
        '</button>' +

        '<div id="' +
          esc(panelId) +
          '-loading" ' +
          'class="analysis-loading">' +
          'Analizando partido...' +
        '</div>' +

        '<div id="' +
          esc(panelId) +
          '-error" ' +
          'class="analysis-error" ' +
          'style="display:none"></div>' +

        '<div id="' +
          esc(panelId) +
          '-content" ' +
          'class="analysis-content"></div>' +

      '</div>' +

    '</article>'

  );
}

/* =========================================================
   BUSCAR PARTIDOS
   ========================================================= */

async function searchFixtures(){

  const date =
    document
      .getElementById('date')
      .value;

  const loading =
    document
      .getElementById('loading');

  const error =
    document
      .getElementById('error');

  const card =
    document
      .getElementById('fixturesCard');

  const list =
    document
      .getElementById('fixtureList');

  const summary =
    document
      .getElementById('searchSummary');

  const button =
    document
      .getElementById('searchBtn');

  if(!date){

    error.style.display =
      'block';

    error.textContent =
      'Selecciona una fecha.';

    card.style.display =
      'none';

    return;
  }

  error.style.display =
    'none';

  card.style.display =
    'none';

  loading.style.display =
    'block';

  button.disabled =
    true;

  list.innerHTML =
    '';

  summary.textContent =
    '';

  try{

    const response =
      await fetch(
        '/api/fixtures?date=' +
        encodeURIComponent(date),
        {
          cache:'no-store'
        }
      );

    let data;

    try{
      data =
        await response.json();
    }catch(_){
      throw new Error(
        'El servidor devolvió una respuesta inválida.'
      );
    }

    if(
      !response.ok ||
      !data.ok
    ){
      throw new Error(
        data.error ||
        data.message ||
        'No se pudieron cargar los partidos.'
      );
    }

    const fixtures =
      Array.isArray(
        data.fixtures
      )
        ? data.fixtures
        : [];

    if(!fixtures.length){

      summary.textContent =
        'No se encontraron partidos para ' +
        formatDate(date) +
        '.';

      card.style.display =
        'block';

      list.innerHTML =
        '<div class="empty">' +
        'No hay partidos disponibles para esta fecha en las competiciones configuradas.' +
        '</div>';

      return;
    }

    summary.textContent =
      fixtures.length +
      ' partido' +
      (
        fixtures.length === 1
          ? ''
          : 's'
      ) +
      ' encontrado' +
      (
        fixtures.length === 1
          ? ''
          : 's'
      ) +
      '.';

    card.style.display =
      'block';

    list.innerHTML =
      fixtures
        .map(
          (fixture,index) =>
            fixtureHtml(
              fixture,
              index,
              date
            )
        )
        .join('');

  }catch(err){

    console.error(
      'SEARCH ERROR:',
      err
    );

    error.style.display =
      'block';

    error.textContent =
      err.message ||
      'Error al buscar partidos.';

  }finally{

    loading.style.display =
      'none';

    button.disabled =
      false;
  }
}

/* =========================================================
   ANALIZAR PARTIDO
   ========================================================= */

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
    console.error(
      'Panel no encontrado:',
      panelId
    );
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

  if(
    !loading ||
    !error ||
    !content
  ){
    console.error(
      'Elementos del análisis incompletos.'
    );
    return;
  }

  loading.style.display =
    'block';

  error.style.display =
    'none';

  content.classList
    .remove('show');

  content.innerHTML =
    '';

  const button =
    panel
      .parentElement
      ?.querySelector(
        '.analyze-small'
      );

  if(button){
    button.disabled =
      true;
  }

  try{

    const params =
      new URLSearchParams();

    params.set(
      'home',
      String(home || '')
    );

    params.set(
      'away',
      String(away || '')
    );

    params.set(
      'date',
      String(date || '')
    );

    const response =
      await fetch(
        '/api/analyze?' +
        params.toString(),
        {
          cache:'no-store'
        }
      );

    let data;

    try{
      data =
        await response.json();
    }catch(_){
      throw new Error(
        'El servidor devolvió una respuesta inválida durante el análisis.'
      );
    }

    if(
      !response.ok ||
      !data.ok
    ){
      throw new Error(
        data.error ||
        data.message ||
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

  }catch(err){

    console.error(
      'ANALYSIS FRONTEND ERROR:',
      err
    );

    error.style.display =
      'block';

    error.textContent =
      err.message ||
      'Error de análisis.';

  }finally{

    loading.style.display =
      'none';

    if(button){
      button.disabled =
        false;
    }
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

/* =========================================================
   HTML DEL ANÁLISIS
   ========================================================= */

function marketHtmlClient(
  market
){

  const evMarket =
    market.referenceEvPct == null
      ? '-'
      : (
          market.referenceEvPct >= 0
            ? '+'
            : ''
        ) +
        Number(
          market.referenceEvPct
        ).toFixed(1) +
        '%';

  return (

    '<div class="market">' +

      '<div class="market-top">' +

        '<strong>' +
          esc(
            market.name
          ) +
        '</strong>' +

        '<span>' +
          pctText(
            market.probability
          ) +
        '</span>' +

      '</div>' +

      '<div class="market-details">' +

        '<span>' +
          'Mejor cuota: ' +
          '<b>' +
          (
            market.bestOdds
              ? Number(
                  market.bestOdds
                ).toFixed(2)
              : '-'
          ) +
          '</b>' +
        '</span>' +

        '<span>' +
          'Mercado: ' +
          '<b>' +
          (
            market.referenceOdds
              ? Number(
                  market.referenceOdds
                ).toFixed(2)
              : '-'
          ) +
          '</b>' +
        '</span>' +

        '<span>' +
          'EV mercado: ' +
          '<b>' +
            evMarket +
          '</b>' +
        '</span>' +

        '<span>' +
          'Casas: ' +
          '<b>' +
            (
              market.bookmakerCount ??
              0
            ) +
          '</b>' +
        '</span>' +

      '</div>' +

      (
        market.isOutlier
          ? '<div class="warning">' +
            '⚠️ Precio atípico · excluido de Value Pick' +
            '</div>'
          : ''
      ) +

    '</div>'

  );
}

function analysisHtml(
  data
){

  const decisionClass =
    data.betEligible
      ? 'bet'
      : 'noBet';

  const local =
    data.recentForm?.home ||
    null;

  const visitor =
    data.recentForm?.away ||
    null;

  let markets =
    '';

  if(
    !data.oddsAvailable
  ){

    markets =
      '<div class="muted">' +
      'Cuotas reales no disponibles. ' +
      esc(
        data.oddsReason || ''
      ) +
      '</div>';

  }else{

    markets =
      (
        data.markets || []
      )
        .map(
          marketHtmlClient
        )
        .join('');
  }

  let value =
    '';

  if(data.bestValue){

    const v =
      data.bestValue;

    value =

      '<div class="value-box">' +

        '<h3>💰 ' +
          esc(v.name) +
        '</h3>' +

        '<div class="muted">' +
          'Probabilidad modelo: ' +
          '<b>' +
            pctText(
              v.probability
            ) +
          '</b>' +
        '</div>' +

        '<div class="muted">' +
          'Mejor cuota: ' +
          '<b>' +
          (
            v.bestOdds
              ? Number(
                  v.bestOdds
                ).toFixed(2)
              : '-'
          ) +
          '</b>' +
        '</div>' +

        '<div class="muted">' +
          'Cuota mercado: ' +
          '<b>' +
          (
            v.referenceOdds
              ? Number(
                  v.referenceOdds
                ).toFixed(2)
              : '-'
          ) +
          '</b>' +
        '</div>' +

        '<div class="muted">' +
          'EV mercado: ' +
          '<b>' +
            moneyPct(
              v.referenceEvPct
            ) +
          '</b>' +
        '</div>' +

        '<div class="muted">' +
          'EV mejor cuota: ' +
          '<b>' +
            moneyPct(
              v.bestEvPct
            ) +
          '</b>' +
        '</div>' +

        '<div class="muted">' +
          esc(
            v.bookmaker ||
            'Casa no disponible'
          ) +
          ' · ' +
          (
            v.bookmakerCount ??
            0
          ) +
          ' casas' +
        '</div>' +

      '</div>';

  }else{

    value =

      '<div class="value-box">' +

        '<h3>🚫 SIN VALUE PICK</h3>' +

        '<div class="muted">' +
          'No existe una oportunidad que cumpla simultáneamente los filtros de probabilidad, EV, confianza, respaldo de mercado y control de outliers.' +
        '</div>' +

      '</div>';
  }

  let alert =
    '';

  if(data.valueAlert){

    const a =
      data.valueAlert;

    alert =

      '<div class="value-box">' +

        '<h3>' +
          (
            a.type === 'outlier'
              ? '🟠 PRECIO ATÍPICO'
              : '📊 REVISIÓN'
          ) +
        '</h3>' +

        '<div>' +
          '<b>' +
            esc(a.market) +
          '</b>' +
        '</div>' +

        '<div class="muted">' +
          'Mejor cuota: ' +
          (
            a.odds
              ? Number(
                  a.odds
                ).toFixed(2)
              : '-'
          ) +
        '</div>' +

        '<div class="muted">' +
          'Cuota de mercado: ' +
          (
            a.referenceOdds
              ? Number(
                  a.referenceOdds
                ).toFixed(2)
              : '-'
          ) +
        '</div>' +

        '<p class="muted">' +
          esc(
            a.message
          ) +
        '</p>' +

      '</div>';

  }else{

    alert =
      '<div class="muted">' +
      'No se detectaron anomalías relevantes.' +
      '</div>';
  }

  return (

    '<div class="fixture-decision">' +

      '<div class="section-label">' +
        'Decisión del modelo' +
      '</div>' +

      '<h3 class="' +
        decisionClass +
      '">' +

        esc(
          data.recommendation ||
          'NO BET'
        ) +

      '</h3>' +

      '<div class="muted">' +
        esc(
          data.reason ||
          ''
        ) +
      '</div>' +

    '</div>' +

    '<div class="section-label">' +
      '🎯 Marcador más probable' +
    '</div>' +

    '<div class="market">' +

      '<div class="fixture-teams">' +
        esc(
          data.match?.home ||
          ''
        ) +
        ' vs ' +
        esc(
          data.match?.away ||
          ''
        ) +
      '</div>' +

      '<div class="score">' +
        esc(
          data.mostLikelyScore?.score ||
          '-'
        ) +
      '</div>' +

      '<div class="scoreProb">' +
        'Probabilidad estimada: ' +
        pctText(
          data.mostLikelyScore?.probability
        ) +
      '</div>' +

    '</div>' +

    '<div class="section-label">' +
      '📊 Probabilidades' +
    '</div>' +

    '<div class="prob-grid">' +

      '<div class="prob">' +
        '<span>🏠 LOCAL</span>' +
        '<b>' +
          pctText(
            data.probabilities?.homeWin
          ) +
        '</b>' +
      '</div>' +

      '<div class="prob">' +
        '<span>🤝 EMPATE</span>' +
        '<b>' +
          pctText(
            data.probabilities?.draw
          ) +
        '</b>' +
      '</div>' +

      '<div class="prob">' +
        '<span>✈️ VISITANTE</span>' +
        '<b>' +
          pctText(
            data.probabilities?.awayWin
          ) +
        '</b>' +
      '</div>' +

    '</div>' +

    '<br>' +

    '<div class="prob-grid">' +

      '<div class="prob">' +
        '<span>OVER 2.5</span>' +
        '<b>' +
          pctText(
            data.probabilities?.over25
          ) +
        '</b>' +
      '</div>' +

      '<div class="prob">' +
        '<span>UNDER 2.5</span>' +
        '<b>' +
          pctText(
            data.probabilities?.under25
          ) +
        '</b>' +
      '</div>' +

      '<div class="prob">' +
        '<span>BTTS</span>' +
        '<b>' +
          pctText(
            data.probabilities?.btts
          ) +
        '</b>' +
      '</div>' +

    '</div>' +

    '<div class="section-label">' +
      '⚽ Goles esperados · xG' +
    '</div>' +

    '<div class="xg-grid">' +

      '<div class="xg">' +
        '<span>LOCAL</span>' +
        '<b>' +
          Number(
            data.xG?.home || 0
          ).toFixed(2) +
        '</b>' +
      '</div>' +

      '<div class="xg">' +
        '<span>VISITANTE</span>' +
        '<b>' +
          Number(
            data.xG?.away || 0
          ).toFixed(2) +
        '</b>' +
      '</div>' +

      '<div class="xg">' +
        '<span>TOTAL</span>' +
        '<b>' +
          Number(
            data.xG?.total || 0
          ).toFixed(2) +
        '</b>' +
      '</div>' +

    '</div>' +

    '<div class="section-label">' +
      '🎯 Confianza del análisis' +
    '</div>' +

    '<div class="market">' +

      '<div class="fixture-teams">' +
        esc(
          data.confidenceLevel ||
          '-'
        ) +
      '</div>' +

      '<div class="muted">' +
        'Puntuación técnica: ' +
        '<b>' +
          esc(
            data.confidence ??
            '-'
          ) +
          ' / 100' +
        '</b>' +
      '</div>' +

      '<div class="muted">' +
        esc(
          data.confidenceExplanation ||
          ''
        ) +
      '</div>' +

    '</div>' +

    '<div class="section-label">' +
      '💪 Fuerza reciente' +
    '</div>' +

    '<div class="market">' +

      '<b>LOCAL · ATAQUE</b>' +

      '<div class="muted">' +
        Number(
          local?.avgGoalsFor || 0
        ).toFixed(2) +
        ' · Form ' +
        pctText(
          local?.formPct
        ) +
      '</div>' +

    '</div>' +

    '<div class="market">' +

      '<b>VISITANTE · ATAQUE</b>' +

      '<div class="muted">' +
        Number(
          visitor?.avgGoalsFor || 0
        ).toFixed(2) +
        ' · Form ' +
        pctText(
          visitor?.formPct
        ) +
      '</div>' +

    '</div>' +

    '<div class="section-label">' +
      '💰 Cuotas reales' +
    '</div>' +

    markets +

    '<div class="section-label">' +
      '🛡️ Value Pick' +
    '</div>' +

    value +

    '<div class="section-label">' +
      '⚠️ Revisión de valor' +
    '</div>' +

    alert

  );
}

/* =========================================================
   EVENTOS
   ========================================================= */

document
  .getElementById('date')
  .value =
  localDateValue();

document
  .getElementById('searchBtn')
  .addEventListener(
    'click',
    searchFixtures
  );

</script>

</body>

</html>`;
}

/* =========================================================
   API STATUS
   ========================================================= */

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      ok:true,

      footballDataConfigured:
        Boolean(
          FOOTBALL_DATA_TOKEN
        ),

      oddsApiConfigured:
        Boolean(
          ODDS_API_KEY
        ),

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
  async (req,res) => {

    try{

      const date =
        String(
          req.query.date ||
          ''
        ).trim() ||
        new Date()
          .toISOString()
          .slice(0,10);

      const matches =
        await getFixture(
          date
        );

      const fixtures =
        matches
          .filter(
            match =>
              match?.homeTeam?.name &&
              match?.awayTeam?.name
          )
          .sort(
            (a,b) =>
              String(
                a?.utcDate || ''
              ).localeCompare(
                String(
                  b?.utcDate || ''
                )
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
                match.competition?.name ||
                match.competitionCode ||
                null,

              competitionCode:
                match.competitionCode ||
                null,

              status:
                match.status ||
                null

            })
          );

      return res.json({

        ok:true,

        modelVersion:
          MODEL_VERSION,

        date,

        count:
          fixtures.length,

        fixtures

      });

    }catch(error){

      console.error(
        'FIXTURES ERROR:',
        error
      );

      return res.status(500)
        .json({

          ok:false,

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
   API ANALYZE
   ========================================================= */

app.get(
  '/api/analyze',
  async (req,res) => {

    try{

      const homeName =
        String(
          req.query.home ||
          ''
        ).trim();

      const awayName =
        String(
          req.query.away ||
          ''
        ).trim();

      let date =
        String(
          req.query.date ||
          ''
        ).trim() ||
        new Date()
          .toISOString()
          .slice(0,10);

      if(
        !homeName ||
        !awayName
      ){

        return res.status(400)
          .json({

            ok:false,

            error:
              'Debes proporcionar home y away.'

          });
      }

      let selected =
        selectFixture(
          await getFixture(
            date
          ),
          homeName,
          awayName
        );

      /*
       * Si el partido no aparece exactamente
       * en la fecha enviada, comprobamos el día siguiente.
       */

      if(!selected){

        const nextDate =
          new Date(
            `${date}T12:00:00`
          );

        nextDate.setDate(
          nextDate.getDate() + 1
        );

        const next =
          nextDate
            .toISOString()
            .slice(0,10);

        selected =
          selectFixture(
            await getFixture(
              next
            ),
            homeName,
            awayName
          );

        if(selected){
          date = next;
        }
      }

      if(!selected){

        return res.status(404)
          .json({

            ok:false,

            error:
              'No se encontró el partido solicitado en las competiciones configuradas.'

          });
      }

      const fixture =
        selected.fixture;

      const homeId =
        selected.reversed
          ? fixture.awayTeam.id
          : fixture.homeTeam.id;

      const awayId =
        selected.reversed
          ? fixture.homeTeam.id
          : fixture.awayTeam.id;

      /*
       * Datos recientes.
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
       * Stabilize.
       */

      try{

        homeStats =
          stabilizeStats(
            homeStats
          ) ||
          homeStats;

        awayStats =
          stabilizeStats(
            awayStats
          ) ||
          awayStats;

      }catch(_){}

      /*
       * Shrink to mean.
       */

      try{

        homeStats =
          shrinkToMean(
            homeStats
          ) ||
          homeStats;

        awayStats =
          shrinkToMean(
            awayStats
          ) ||
          awayStats;

      }catch(_){}

      /*
       * xG.
       */

      const modelInput =
        createModelInput(
          homeStats,
          awayStats
        );

      /*
       * Modelo principal.
       */

      const model =
        matchModel(
          modelInput.homeXg,
          modelInput.awayXg
        );

      /*
       * Confianza.
       */

      let modelConfidence =
        50;

      try{

        modelConfidence =
          confidence({

            homeXg:
              modelInput.homeXg,

            awayXg:
              modelInput.awayXg,

            homeStats,

            awayStats,

            model

          });

      }catch(_){

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
       * Cuotas.
       */

      const odds =
        await getOdds(
          homeName,
          awayName,
          fixture.competitionCode,
          fixture.utcDate
        );

      const markets =
        odds.available
          ? buildMarkets(
              model,
              odds,
              {
                homeName,
                awayName
              }
            )
          : [];

      /*
       * Mejor EV.
       */

      const topReferenceEv =
        markets
          .map(
            market =>
              Number(
                market.referenceEvPct
              )
          )
          .filter(
            Number.isFinite
          )
          .reduce(
            (max,n) =>
              Math.max(
                max,
                n
              ),
            -Infinity
          );

      /*
       * Value Pick.
       */

      const value =
        bestValue(
          markets,
          confidenceAdjusted
        );

      const betEligible =
        Boolean(value) &&
        confidenceAdjusted >= 60 &&
        Number(
          value.referenceEvPct
        ) >= 2 &&
        Number(
          value.probability
        ) >= 55;

      const recommendation =
        betEligible
          ? value.name
          : 'NO BET';

      const reason =
        betEligible
          ? `El modelo detecta valor respaldado por el mercado con ${value.probability.toFixed(1)}% de probabilidad y EV de mercado de ${value.referenceEvPct.toFixed(1)}%.`
          : 'No existe una oportunidad de valor positiva que cumpla los filtros de probabilidad, EV, confianza y respaldo del mercado.';

      const confidenceLevel =
        confidenceAdjusted >= 75
          ? 'Alta'
          : confidenceAdjusted >= 60
            ? 'Media'
            : 'Baja';

      const confidenceExplanation =
        confidenceAdjusted >= 75

          ? 'El análisis presenta una señal estadística fuerte y suficiente respaldo.'

          : confidenceAdjusted >= 60

            ? 'El análisis presenta respaldo moderado, pero debe mantenerse disciplina en la selección.'

            : 'La señal no es suficientemente sólida para justificar una apuesta.';

      /*
       * Marcador.
       */

      const score =
        mostLikelyScore(
          modelInput.homeXg,
          modelInput.awayXg
        );

      /*
       * Alertas.
       */

      const valueAlert =
        buildValueAlert(
          markets
        );

      /*
       * Respuesta.
       */

      return res.json({

        ok:true,

        modelVersion:
          MODEL_VERSION,

        match:{

          id:
            fixture.id ||
            null,

          home:
            homeName,

          away:
            awayName,

          date,

          kickoff:
            fixture.utcDate ||
            null,

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

        recentForm:{

          home:
            homeStats,

          away:
            awayStats

        },

        averages:{

          home:{

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

          away:{

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

        xG:{

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

        probabilities:{

          homeWin:
            Number(
              model.homeWin
                .toFixed(4)
            ) * 100,

          draw:
            Number(
              model.draw
                .toFixed(4)
            ) * 100,

          awayWin:
            Number(
              model.awayWin
                .toFixed(4)
            ) * 100,

          over25:
            Number(
              model.over25
                .toFixed(4)
            ) * 100,

          under25:
            Number(
              model.under25
                .toFixed(4)
            ) * 100,

          btts:
            Number(
              model.btts
                .toFixed(4)
            ) * 100

        },

        markets,

        oddsAvailable:
          Boolean(
            odds.available
          ),

        oddsReason:
          odds.available
            ? null
            : odds.reason ||
              null,

        bestValue:
          value ||
          null,

        valueAlert,

        confidence:
          confidenceAdjusted,

        confidenceLevel,

        confidenceExplanation,

        diagnostics:{

          topReferenceEv:
            Number.isFinite(
              topReferenceEv
            )
              ? Number(
                  topReferenceEv
                    .toFixed(2)
                )
              : null,

          outlierMarkets:
            markets
              .filter(
                market =>
                  market.isOutlier
              )
              .map(
                market => ({

                  name:
                    market.name,

                  bestOdds:
                    market.bestOdds,

                  referenceOdds:
                    market.referenceOdds,

                  bestEvPct:
                    market.bestEvPct,

                  referenceEvPct:
                    market.referenceEvPct

                })
              ),

          valueFilter:{

            minimumProbability:
              55,

            minimumConfidence:
              60,

            minimumReferenceEv:
              2,

            minimumBookmakers:
              2,

            minimumSupport:
              2,

            outliersAllowed:
              false

          }

        }

      });

    }catch(error){

      console.error(
        'ANALYZE ERROR:',
        error
      );

      if(error?.stack){
        console.error(
          error.stack
        );
      }

      return res.status(500)
        .json({

          ok:false,

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
   ROOT
   ========================================================= */

app.get(
  '/',
  (req,res) => {

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

    res.type('html')
      .send(
        renderPage()
      );

  }
);

/* =========================================================
   HEALTH
   ========================================================= */

app.get(
  '/health',
  (req,res) => {

    res.json({

      ok:true,

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
  () => {

    console.log(
      `${MODEL_VERSION} ANALYST running on port ${PORT}`
    );

    console.log(
      `Football-Data configured: ${Boolean(FOOTBALL_DATA_TOKEN)}`
    );

    console.log(
      `Odds API configured: ${Boolean(ODDS_API_KEY)}`
    );

  }
);
