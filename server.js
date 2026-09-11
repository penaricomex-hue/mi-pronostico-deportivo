const express = require('express');

const {
  matchModel,
  implied,
  ev,
  confidence,
  stabilizeStats,
  shrinkToMean
} = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const MODEL_VERSION = 'V7.6.3';

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

const now = () =>
  Date.now();

function cacheGet(key) {

  const item =
    cache.get(key);

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

  cache.set(
    key,
    {
      time: now(),
      data
    }
  );
}

function normalizeName(value) {

  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function namesMatch(a, b) {

  const x =
    normalizeName(a);

  const y =
    normalizeName(b);

  if (!x || !y) {
    return false;
  }

  if (x === y) {
    return true;
  }

  if (
    x.length < 6 ||
    y.length < 6
  ) {
    return false;
  }

  return (
    x.length >= 8 &&
    y.length >= 8 &&
    (
      x.includes(y) ||
      y.includes(x)
    )
  );
}

function median(values) {

  const nums =
    values
      .map(Number)
      .filter(Number.isFinite)
      .sort(
        (a, b) =>
          a - b
      );

  if (!nums.length) {
    return null;
  }

  const m =
    Math.floor(
      nums.length / 2
    );

  return (
    nums.length % 2
      ? nums[m]
      : (
          nums[m - 1] +
          nums[m]
        ) / 2
  );
}

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

    const error =
      new Error(
        data?.message ||
        data?.error ||
        data?.errors?.message ||
        `HTTP ${response.status}`
      );

    error.status =
      response.status;

    error.data =
      data;

    throw error;
  }

  return data;
}

async function footballData(
  path
) {

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

  cacheSet(
    key,
    data
  );

  return data;
}

function emptyStats() {

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

function calculateRecentTeamStats(
  teamId,
  matches
) {

  const relevant =
    (
      Array.isArray(matches)
        ? matches
        : []
    )
      .filter(
        m =>
          m?.homeTeam?.id === teamId ||
          m?.awayTeam?.id === teamId
      )
      .filter(
        m =>
          m?.status === 'FINISHED' ||
          m?.score?.fullTime?.home != null
      )
      .sort(
        (a, b) =>
          String(
            b?.utcDate || ''
          ).localeCompare(
            String(
              a?.utcDate || ''
            )
          )
      )
      .slice(0, 10);

  if (!relevant.length) {
    return emptyStats();
  }

  let goalsFor = 0;
  let goalsAgainst = 0;
  let points = 0;

  for (
    const match of relevant
  ) {

    const home =
      Number(
        match?.score?.fullTime?.home ??
        0
      );

    const away =
      Number(
        match?.score?.fullTime?.away ??
        0
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

    if (gf > ga) {
      points += 3;
    } else if (gf === ga) {
      points += 1;
    }
  }

  const avgGoalsFor =
    goalsFor /
    relevant.length;

  const avgGoalsAgainst =
    goalsAgainst /
    relevant.length;

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
        points /
        (
          relevant.length * 3
        )
      ) * 100
  };
}

async function getTeamRecentMatches(
  teamId,
  competitionCode,
  referenceDate
) {

  const key =
    `team:${teamId}:recent:${competitionCode || 'all'}:${referenceDate || ''}`;

  const cached =
    cacheGet(key);

  if (cached) {
    return cached;
  }

  /*
   * PRIMER INTENTO:
   * historial directo del equipo.
   */

  try {

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

    cacheSet(
      key,
      matches
    );

    console.log(
      `[ANALYZE] team ${teamId}: historial directo OK (${matches.length})`
    );

    return matches;

  } catch (directError) {

    console.warn(
      `[ANALYZE] team ${teamId}: historial directo no disponible: ${directError.message}`
    );
  }

  /*
   * SEGUNDO INTENTO:
   * buscar partidos recientes
   * desde la competición.
   */

  if (
    !competitionCode ||
    !referenceDate
  ) {

    return [];
  }

  const end =
    new Date(
      `${referenceDate}T12:00:00`
    );

  const start =
    new Date(end);

  start.setDate(
    start.getDate() - 120
  );

  const from =
    start
      .toISOString()
      .slice(0, 10);

  const to =
    new Date(end);

  to.setDate(
    to.getDate() - 1
  );

  const toDate =
    to
      .toISOString()
      .slice(0, 10);

  try {

    const data =
      await footballData(
        `/competitions/${competitionCode}/matches?dateFrom=${from}&dateTo=${toDate}`
      );

    const matches =
      (
        Array.isArray(
          data?.matches
        )
          ? data.matches
          : []
      )
        .filter(
          m =>
            m?.homeTeam?.id === teamId ||
            m?.awayTeam?.id === teamId
        )
        .filter(
          m =>
            m?.status === 'FINISHED' ||
            m?.score?.fullTime?.home != null
        )
        .sort(
          (a, b) =>
            String(
              b?.utcDate || ''
            ).localeCompare(
              String(
                a?.utcDate || ''
              )
            )
        )
        .slice(0, 20);

    cacheSet(
      key,
      matches
    );

    console.log(
      `[ANALYZE] team ${teamId}: fallback por competición OK (${matches.length})`
    );

    return matches;

  } catch (fallbackError) {

    console.error(
      `[ANALYZE] team ${teamId}: fallback también falló: ${fallbackError.message}`
    );

    return [];
  }
}

async function getFixtures(
  date
) {

  const key =
    `fixtures:${date}`;

  const cached =
    cacheGet(key);

  if (cached) {

    console.log(
      `[FIXTURES] ${date}: CACHE HIT -> ${cached.length} partidos`
    );

    return cached;
  }

  const all = [];

  console.log(
    `[FIXTURES] ===== INICIO ${date} =====`
  );

  for (
    const code of Object.keys(
      ODDS_SPORT_BY_COMPETITION
    )
  ) {

    try {

      const data =
        await footballData(
          `/competitions/${code}/matches?dateFrom=${date}&dateTo=${date}`
        );

      const matches =
        Array.isArray(
          data?.matches
        )
          ? data.matches
          : [];

      console.log(
        `[FIXTURES] ${date} ${code}: ${matches.length} partidos`
      );

      all.push(
        ...matches.map(
          m => ({
            ...m,
            competitionCode:
              code
          })
        )
      );

    } catch (error) {

      console.error(
        `[FIXTURES] ${date} ${code}: ERROR ${error.message}`
      );
    }
  }

  console.log(
    `[FIXTURES] ===== TOTAL ${date}: ${all.length} partidos =====`
  );

  cacheSet(
    key,
    all
  );

  return all;
}

function selectFixture(
  matches,
  homeName,
  awayName
) {

  const direct =
    matches.find(
      m =>
        namesMatch(
          m?.homeTeam?.name,
          homeName
        ) &&
        namesMatch(
          m?.awayTeam?.name,
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
      m =>
        namesMatch(
          m?.homeTeam?.name,
          awayName
        ) &&
        namesMatch(
          m?.awayTeam?.name,
          homeName
        )
    );

  return reversed
    ? {
        fixture: reversed,
        reversed: true
      }
    : null;
}

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
      (
        homeAttack +
        awayStats.avgGoalsAgainst
      ) / 2
    ) * 1.08;

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
      bookmaker ||
      'Unknown',

    odds:
      n
  });
}

function analyzePriceSet(
  prices
) {

  const valid =
    (
      Array.isArray(prices)
        ? prices
        : []
    )
      .filter(
        x =>
          x &&
          Number.isFinite(
            Number(x.odds)
          ) &&
          Number(x.odds) > 1
      )
      .map(
        x => ({
          bookmaker:
            x.bookmaker ||
            'Unknown',

          odds:
            Number(x.odds)
        })
      );

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
    [
      ...new Set(odds)
    ]
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
      o =>
        referenceOdds &&
        Math.abs(
          o - referenceOdds
        ) /
        referenceOdds <=
        0.10
    ).length;

  const priceGapPct =
    referenceOdds
      ? (
          (
            bestOdds /
            referenceOdds
          ) - 1
        ) * 100
      : 0;

  const secondGapPct =
    secondBestOdds
      ? (
          (
            bestOdds /
            secondBestOdds
          ) - 1
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

  const marketDepth =
    odds.length >= 6 &&
    supportCount >= 4
      ? 'strong'
      : odds.length >= 3 &&
        supportCount >= 2
        ? 'medium'
        : 'low';

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

    prices:
      valid
  };
}

function marketName(
  type,
  outcome
) {

  if (type === 'h2h') {

    return (
      outcome === 'home'
        ? 'Gana local'
        : outcome === 'draw'
          ? 'Empate'
          : 'Gana visitante'
    );
  }

  if (type === 'totals') {

    return (
      outcome === 'over'
        ? 'Over 2.5'
        : 'Under 2.5'
    );
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
    analyzePriceSet(
      prices
    );

  const p =
    Number(probability);

  const bestEvPct =
    info.bestOdds
      ? ev(
          p,
          info.bestOdds
        )
      : null;

  const referenceEvPct =
    info.referenceOdds
      ? ev(
          p,
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
      p,

    odds:
      info.bestOdds,

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

    referenceImpliedProbability:
      info.referenceOdds
        ? implied(
            info.referenceOdds
          )
        : null,

    evPct:
      bestEvPct,

    bestEvPct,

    referenceEvPct,

    bookmaker:
      info.prices.find(
        x =>
          x.odds ===
          info.bestOdds
      )?.bookmaker ||
      null,

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

      const outcomes =
        Array.isArray(
          market?.outcomes
        )
          ? market.outcomes
          : [];

      for (
        const outcome of outcomes
      ) {

        const price =
          Number(
            outcome?.price
          );

        if (
          market.key ===
          'h2h'
        ) {

          if (
            namesMatch(
              outcome?.name,
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
              outcome?.name,
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
              normalizeName(
                outcome?.name
              )
            )
          ) {

            collectPrice(
              h2h.draw,
              bookmakerName,
              price
            );
          }

        } else if (
          market.key ===
            'totals' &&
          Number(
            outcome?.point
          ) === 2.5
        ) {

          const name =
            normalizeName(
              outcome?.name
            );

          if (
            name === 'over'
          ) {

            collectPrice(
              totals.over,
              bookmakerName,
              price
            );

          } else if (
            name === 'under'
          ) {

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

  const key =
    `odds:${sport}:${normalizeName(homeName)}:${normalizeName(awayName)}`;

  const cached =
    cacheGet(key);

  if (cached) {
    return cached;
  }

  const url =
    `${ODDS_BASE}/sports/${sport}/odds?regions=us,uk&markets=h2h,totals&oddsFormat=decimal&apiKey=${encodeURIComponent(ODDS_API_KEY)}`;

  let data;

  try {

    data =
      await fetchJson(
        url
      );

  } catch (error) {

    return {
      available: false,
      reason:
        error.message,
      errorStatus:
        error.status ||
        null
    };
  }

  const events =
    Array.isArray(data)
      ? data
      : [];

  let event =
    events.find(
      x =>
        namesMatch(
          x?.home_team,
          homeName
        ) &&
        namesMatch(
          x?.away_team,
          awayName
        )
    );

  let reversed = false;

  if (!event) {

    event =
      events.find(
        x =>
          namesMatch(
            x?.home_team,
            awayName
          ) &&
          namesMatch(
            x?.away_team,
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

    available:
      true,

    eventId:
      event.id ||
      null,

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
    key,
    result
  );

  return result;
}

function bestValue(
  markets,
  modelConfidence
) {

  return markets
    .filter(
      m =>
        m.valueEligible &&
        m.bookmakerCount >= 2 &&
        m.supportCount >= 2 &&
        !m.isOutlier &&
        m.probability >= 55 &&
        Number(m.referenceEvPct) >= 2 &&
        Number(m.bestEvPct) >= 2 &&
        Number(modelConfidence) >= 60
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
    )[0] ||
    null;
}

function buildValueAlert(
  markets
) {

  const outliers =
    markets
      .filter(
        m =>
          m.isOutlier &&
          m.odds
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

  if (
    outliers.length
  ) {

    const m =
      outliers[0];

    return {

      type:
        'outlier',

      market:
        m.name,

      odds:
        m.bestOdds,

      bestEvPct:
        m.bestEvPct,

      referenceOdds:
        m.referenceOdds,

      referenceEvPct:
        m.referenceEvPct,

      bookmaker:
        m.bookmaker,

      message:
        `La cuota ${m.bestOdds.toFixed(2)} está muy alejada del consenso del mercado. Se excluye del Value Pick para evitar una falsa oportunidad.`
    };
  }

  const positive =
    markets
      .filter(
        m =>
          Number(
            m.referenceEvPct
          ) > 0 &&
          m.odds
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

  if (
    positive.length
  ) {

    const m =
      positive[0];

    return {

      type:
        'normal',

      market:
        m.name,

      odds:
        m.bestOdds,

      bestEvPct:
        m.bestEvPct,

      referenceOdds:
        m.referenceOdds,

      referenceEvPct:
        m.referenceEvPct,

      bookmaker:
        m.bookmaker,

      message:
        'El modelo detecta una ventaja moderada, pero debe superar todos los filtros antes de recomendar apuesta.'
    };
  }

  return null;
}

function esc(value) {

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

function pctText(value) {

  if (
    value == null ||
    !Number.isFinite(
      Number(value)
    )
  ) {
    return '-';
  }

  return (
    Number(value).toFixed(1) +
    '%'
  );
}

function moneyPct(value) {

  if (
    value == null ||
    !Number.isFinite(
      Number(value)
    )
  ) {
    return '-';
  }

  const n =
    Number(value);

  return (
    (n >= 0 ? '+' : '') +
    n.toFixed(1) +
    '%'
  );
}

function localDateValue() {

  const d =
    new Date();

  return new Date(
    d.getTime() -
    d.getTimezoneOffset() *
    60000
  )
    .toISOString()
    .slice(0, 10);
}

function formatTime(value) {

  if (!value) {
    return '--:--';
  }

  const d =
    new Date(value);

  if (
    Number.isNaN(
      d.getTime()
    )
  ) {
    return '--:--';
  }

  return d.toLocaleTimeString(
    'es-MX',
    {
      hour: '2-digit',
      minute: '2-digit'
    }
  );
}

function fixtureHtml(
  f,
  index,
  date
) {

  const panelId =
    `analysis-${index}-${String(
      f.id ||
      index
    )}`;

  /*
   * IMPORTANTE:
   * usamos atributo HTML con
   * comillas simples y escapamos
   * el JSON para evitar romper
   * el onclick.
   */

  const p =
    JSON.stringify(
      panelId
    );

  const h =
    JSON.stringify(
      f.home ||
      ''
    );

  const a =
    JSON.stringify(
      f.away ||
      ''
    );

  const d =
    JSON.stringify(
      date
    );

  return (

    `<article class="fixture">` +

      `<div class="fixture-head">` +

        `<div>` +

          `<div class="fixture-teams">` +
            `⚽ ${esc(f.home)}` +
            ` vs ` +
            `${esc(f.away)}` +
          `</div>` +

          `<div class="fixture-meta">` +
            `🕐 ${formatTime(
              f.kickoff
            )}` +
            ` · 🏆 ` +
            `${esc(
              f.competition ||
              'Competición'
            )}` +
          `</div>` +

        `</div>` +

        `<button ` +
          `class="analyze-small" ` +
          `onclick='openAnalysis(` +
            `${esc(p)},` +
            `${esc(h)},` +
            `${esc(a)},` +
            `${esc(d)}` +
          `)'>` +
          `🧠 ANALIZAR` +
        `</button>` +

      `</div>` +

      `<div ` +
        `id="${esc(panelId)}" ` +
        `class="analysis-panel">` +

        `<button ` +
          `class="analysis-close" ` +
          `onclick='closeAnalysis(` +
            `${esc(p)}` +
          `)'>` +
          `▲ CERRAR ANÁLISIS` +
        `</button>` +

        `<div ` +
          `id="${esc(panelId)}-loading" ` +
          `class="analysis-loading">` +
          `Analizando partido...` +
        `</div>` +

        `<div ` +
          `id="${esc(panelId)}-error" ` +
          `class="analysis-error" ` +
          `style="display:none">` +
        `</div>` +

        `<div ` +
          `id="${esc(panelId)}-content" ` +
          `class="analysis-content">` +
        `</div>` +

      `</div>` +

    `</article>`
  );
}

function marketHtmlClient(
  m
) {

  return (

    `<div class="market">` +

      `<div class="market-top">` +

        `<strong>` +
          `${esc(m.name)}` +
        `</strong>` +

        `<span>` +
          `${pctText(
            m.probability
          )}` +
        `</span>` +

      `</div>` +

      `<div class="market-details">` +

        `<span>` +
          `Mejor cuota: ` +
          `<b>` +
            `${
              m.bestOdds
                ? Number(
                    m.bestOdds
                  ).toFixed(2)
                : '-'
            }` +
          `</b>` +
        `</span>` +

        `<span>` +
          `Mercado: ` +
          `<b>` +
            `${
              m.referenceOdds
                ? Number(
                    m.referenceOdds
                  ).toFixed(2)
                : '-'
            }` +
          `</b>` +
        `</span>` +

        `<span>` +
          `EV mercado: ` +
          `<b>` +
            `${moneyPct(
              m.referenceEvPct
            )}` +
          `</b>` +
        `</span>` +

        `<span>` +
          `Casas: ` +
          `<b>` +
            `${m.bookmakerCount}` +
          `</b>` +
        `</span>` +

      `</div>` +

      (
        m.isOutlier
          ? `<div class="warning">` +
            `⚠️ Precio atípico · excluido de Value Pick` +
            `</div>`
          : ''
      ) +

    `</div>`
  );
}

function analysisHtml(
  data
) {

  const recent =
    data.recentForm ||
    {};

  const home =
    recent.home ||
    emptyStats();

  const away =
    recent.away ||
    emptyStats();

  let markets = '';

  if (
    !data.oddsAvailable
  ) {

    markets =
      `<div class="muted">` +
      `Cuotas reales no disponibles: ` +
      `${esc(
        data.oddsReason ||
        'sin información'
      )}` +
      `</div>`;

  } else {

    markets =
      (
        data.markets ||
        []
      )
        .map(
          marketHtmlClient
        )
        .join('');
  }

  let value = '';

  if (
    data.bestValue
  ) {

    const v =
      data.bestValue;

    value =

      `<div class="value-box">` +

        `<h3>` +
          `💰 ${esc(v.name)}` +
        `</h3>` +

        `<div class="muted">` +
          `Probabilidad: ` +
          `<b>` +
            `${pctText(
              v.probability
            )}` +
          `</b>` +
        `</div>` +

        `<div class="muted">` +
          `Mejor cuota: ` +
          `<b>` +
            `${Number(
              v.bestOdds
            ).toFixed(2)}` +
          `</b>` +
        `</div>` +

        `<div class="muted">` +
          `EV mercado: ` +
          `<b>` +
            `${moneyPct(
              v.referenceEvPct
            )}` +
          `</b>` +
        `</div>` +

        `<div class="muted">` +
          `Casa: ` +
          `${esc(
            v.bookmaker ||
            'No disponible'
          )}` +
        `</div>` +

      `</div>`;

  } else {

    value =

      `<div class="value-box">` +

        `<h3>🚫 SIN VALUE PICK</h3>` +

        `<div class="muted">` +
          `Ningún mercado cumplió simultáneamente ` +
          `los filtros de probabilidad, EV, confianza, ` +
          `respaldo y control de outliers.` +
        `</div>` +

      `</div>`;
  }

  const alert =
    data.valueAlert

      ? `<div class="value-box">` +

          `<h3>` +
            (
              data.valueAlert.type ===
              'outlier'
                ? '🟠 PRECIO ATÍPICO'
                : '📊 REVISIÓN'
            ) +
          `</h3>` +

          `<b>` +
            `${esc(
              data.valueAlert.market
            )}` +
          `</b>` +

          `<p class="muted">` +
            `${esc(
              data.valueAlert.message
            )}` +
          `</p>` +

        `</div>`

      : `<div class="muted">` +
          `No se detectaron anomalías relevantes.` +
        `</div>`;

  return (

    `<div class="fixture-decision">` +

      `<div class="section-label">` +
        `Decisión del modelo` +
      `</div>` +

      `<h3 class="${
        data.betEligible
          ? 'bet'
          : 'noBet'
      }">` +

        `${esc(
          data.recommendation ||
          'NO BET'
        )}` +

      `</h3>` +

      `<div class="muted">` +
        `${esc(
          data.reason ||
          ''
        )}` +
      `</div>` +

    `</div>` +

    `<div class="section-label">` +
      `🎯 Marcador más probable` +
    `</div>` +

    `<div class="market">` +

      `<div class="fixture-teams">` +
        `${esc(
          data.match?.home
        )}` +
        ` vs ` +
        `${esc(
          data.match?.away
        )}` +
      `</div>` +

      `<div class="score">` +
        `${esc(
          data.mostLikelyScore?.score ||
          '-'
        )}` +
      `</div>` +

      `<div class="scoreProb">` +
        `Probabilidad estimada: ` +
        `${pctText(
          data.mostLikelyScore?.probability
        )}` +
      `</div>` +

    `</div>` +

    `<div class="section-label">` +
      `📊 Probabilidades` +
    `</div>` +

    `<div class="prob-grid">` +

      `<div class="prob">` +
        `<span>🏠 LOCAL</span>` +
        `<b>` +
          `${pctText(
            data.probabilities?.homeWin
          )}` +
        `</b>` +
      `</div>` +

      `<div class="prob">` +
        `<span>🤝 EMPATE</span>` +
        `<b>` +
          `${pctText(
            data.probabilities?.draw
          )}` +
        `</b>` +
      `</div>` +

      `<div class="prob">` +
        `<span>✈️ VISITANTE</span>` +
        `<b>` +
          `${pctText(
            data.probabilities?.awayWin
          )}` +
        `</b>` +
      `</div>` +

    `</div>` +

    `<br>` +

    `<div class="prob-grid">` +

      `<div class="prob">` +
        `<span>OVER 2.5</span>` +
        `<b>` +
          `${pctText(
            data.probabilities?.over25
          )}` +
        `</b>` +
      `</div>` +

      `<div class="prob">` +
        `<span>UNDER 2.5</span>` +
        `<b>` +
          `${pctText(
            data.probabilities?.under25
          )}` +
        `</b>` +
      `</div>` +

      `<div class="prob">` +
        `<span>BTTS</span>` +
        `<b>` +
          `${pctText(
            data.probabilities?.btts
          )}` +
        `</b>` +
      `</div>` +

    `</div>` +

    `<div class="section-label">` +
      `⚽ Goles esperados · xG` +
    `</div>` +

    `<div class="xg-grid">` +

      `<div class="xg">` +
        `<span>LOCAL</span>` +
        `<b>` +
          `${Number(
            data.xG?.home ||
            0
          ).toFixed(2)}` +
        `</b>` +
      `</div>` +

      `<div class="xg">` +
        `<span>VISITANTE</span>` +
        `<b>` +
          `${Number(
            data.xG?.away ||
            0
          ).toFixed(2)}` +
        `</b>` +
      `</div>` +

      `<div class="xg">` +
        `<span>TOTAL</span>` +
        `<b>` +
          `${Number(
            data.xG?.total ||
            0
          ).toFixed(2)}` +
        `</b>` +
      `</div>` +

    `</div>` +

    `<div class="section-label">` +
      `🎯 Confianza` +
    `</div>` +

    `<div class="market">` +

      `<div class="fixture-teams">` +
        `${esc(
          data.confidenceLevel ||
          '-'
        )}` +
      `</div>` +

      `<div class="muted">` +
        `Puntuación técnica: ` +
        `<b>` +
          `${esc(
            data.confidence ??
            '-'
          )}` +
          ` / 100` +
        `</b>` +
      `</div>` +

      `<div class="muted">` +
        `${esc(
          data.confidenceExplanation ||
          ''
        )}` +
      `</div>` +

    `</div>` +

    `<div class="section-label">` +
      `💪 Fuerza reciente` +
    `</div>` +

    `<div class="market">` +

      `<b>LOCAL</b>` +

      `<div class="muted">` +
        `Ataque ` +
        `${Number(
          home.avgGoalsFor ||
          0
        ).toFixed(2)}` +
        ` · Form ` +
        `${pctText(
          home.formPct
        )}` +
        ` · Muestra ` +
        `${home.matches || 0}` +
      `</div>` +

    `</div>` +

    `<div class="market">` +

      `<b>VISITANTE</b>` +

      `<div class="muted">` +
        `Ataque ` +
        `${Number(
          away.avgGoalsFor ||
          0
        ).toFixed(2)}` +
        ` · Form ` +
        `${pctText(
          away.formPct
        )}` +
        ` · Muestra ` +
        `${away.matches || 0}` +
      `</div>` +

    `</div>` +

    `<div class="section-label">` +
      `💰 Cuotas reales` +
    `</div>` +

    markets +

    `<div class="section-label">` +
      `🛡️ Value Pick` +
    `</div>` +

    value +

    `<div class="section-label">` +
      `⚠️ Revisión de valor` +
    `</div>` +

    alert
  );
}

function renderPage() {

  return `<!DOCTYPE html>
<html lang="es">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1,maximum-scale=1"
>

<title>
Mi Pronóstico Deportivo ${MODEL_VERSION}
</title>

<style>

*{
  box-sizing:border-box
}

body{
  margin:0;
  background:#080b10;
  color:#f5f7fa;
  font-family:system-ui,-apple-system,Segoe UI,sans-serif
}

.app{
  max-width:760px;
  margin:auto;
  padding:18px 14px 90px
}

.header{
  padding:10px 4px 18px
}

.version,
.chip{
  display:inline-block;
  background:#151a22;
  border:1px solid #252c37;
  border-radius:999px;
  padding:7px 10px;
  font-size:12px;
  font-weight:800
}

.header h1{
  font-size:30px;
  line-height:1.05;
  margin:17px 0 8px
}

.muted,
.subtitle{
  color:#9da5b2
}

.subtitle{
  font-size:14px
}

.chips{
  display:flex;
  gap:7px;
  flex-wrap:wrap;
  margin:15px 0
}

.chip{
  font-size:11px
}

.card,
.fixture{
  background:#10151d;
  border:1px solid #242b36;
  border-radius:16px;
  padding:15px;
  margin-top:12px
}

.card-title,
.section-label{
  font-size:11px;
  text-transform:uppercase;
  letter-spacing:1px;
  color:#929ba9;
  margin-bottom:10px
}

.date{
  width:100%;
  background:#090d13;
  color:white;
  border:1px solid #303846;
  border-radius:11px;
  padding:12px;
  margin-bottom:9px
}

.primary,
.analyze-small,
.analysis-close{
  border-radius:11px;
  padding:12px;
  font-weight:900;
  cursor:pointer
}

.primary{
  width:100%;
  border:0;
  background:#f4f5f7;
  color:#080b10
}

.loading{
  text-align:center;
  padding:15px;
  color:#9da5b2
}

.error,
.analysis-error{
  color:#ff7b72;
  background:#1b1012;
  padding:10px;
  border-radius:10px
}

.fixture-head{
  display:flex;
  justify-content:space-between;
  gap:10px;
  align-items:flex-start
}

.fixture-teams{
  font-size:16px;
  font-weight:800;
  line-height:1.3
}

.fixture-meta{
  font-size:12px;
  color:#8e97a5;
  margin-top:5px
}

.analyze-small{
  border:0;
  background:#f4f5f7;
  color:#080b10;
  font-size:11px;
  white-space:nowrap
}

.analysis-panel{
  display:none;
  border-top:1px solid #252c37;
  margin-top:12px;
  padding-top:12px
}

.analysis-panel.open{
  display:block
}

.analysis-close{
  width:100%;
  border:1px solid #303846;
  background:#151a22;
  color:white;
  margin-bottom:10px
}

.analysis-loading{
  text-align:center;
  color:#9da5b2;
  padding:16px
}

.analysis-content{
  display:none
}

.analysis-content.show{
  display:block
}

.fixture-decision{
  text-align:center;
  background:#090d13;
  border-radius:12px;
  padding:12px
}

.fixture-decision h3{
  font-size:24px;
  margin:6px
}

.bet{
  color:#7ee787
}

.noBet{
  color:#ffb45d
}

.score{
  font-size:38px;
  font-weight:900;
  margin:9px 0
}

.scoreProb{
  color:#9da5b2
}

.prob-grid,
.xg-grid{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  gap:8px
}

.prob,
.xg{
  background:#090d13;
  border-radius:12px;
  padding:12px;
  text-align:center
}

.prob span,
.xg span{
  display:block;
  color:#8e97a5;
  font-size:10px
}

.prob b,
.xg b{
  font-size:20px
}

.xg b{
  display:block;
  margin-top:4px
}

.market{
  background:#090d13;
  border-radius:12px;
  padding:12px;
  margin-bottom:8px
}

.market-top{
  display:flex;
  justify-content:space-between
}

.market-details{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:6px;
  margin-top:9px;
  color:#8e97a5;
  font-size:11px
}

.market-details b{
  color:white
}

.warning{
  margin-top:8px;
  padding:8px;
  border-radius:8px;
  background:#291b0d;
  color:#ffc078;
  font-size:11px
}

.value-box{
  background:#090d13;
  border:1px solid #33414d;
  border-radius:12px;
  padding:12px
}

.nav{
  position:fixed;
  bottom:0;
  left:0;
  right:0;
  max-width:760px;
  margin:auto;
  background:rgba(10,13,18,.97);
  border-top:1px solid #252c37;
  display:flex;
  justify-content:space-around;
  padding:11px;
  font-size:11px;
  color:#929ba9
}

@media(max-width:600px){

  .prob-grid,
  .xg-grid{
    grid-template-columns:repeat(3,1fr)
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
🛡️ NO BET
</span>

</div>

</header>

<section class="card">

<div class="card-title">
Buscar partidos por fecha
</div>

<input
  id="date"
  class="date"
  type="date"
>

<button
  id="searchBtn"
  class="primary"
  onclick="searchFixtures()"
>
🔎 BUSCAR PARTIDOS
</button>

<div
  id="searchSummary"
  class="muted"
  style="margin-top:9px;font-size:13px"
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

<div id="fixtureList">
</div>

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

function closeAllPanels(
  exceptId
){

  document
    .querySelectorAll(
      '.analysis-panel.open'
    )
    .forEach(
      panel => {

        if (
          panel.id !==
          exceptId
        ) {

          panel.classList
            .remove(
              'open'
            );
        }

      }
    );
}

async function searchFixtures(){

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

  if (!date) {

    error.style.display =
      'block';

    error.textContent =
      'Selecciona una fecha.';

    return;
  }

  error.style.display =
    'none';

  card.style.display =
    'none';

  loading.style.display =
    'block';

  list.innerHTML =
    '';

  summary.textContent =
    '';

  try {

    const response =
      await fetch(
        '/api/fixtures?date=' +
        encodeURIComponent(
          date
        ),
        {
          cache:
            'no-store'
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {

      throw new Error(
        data.error ||
        data.message ||
        'No se pudieron cargar los partidos.'
      );
    }

    card.style.display =
      'block';

    if (
      !data.fixtures.length
    ) {

      summary.textContent =
        'No se encontraron partidos para ' +
        date
          .split('-')
          .reverse()
          .join('/') +
        '.';

      list.innerHTML =
        '<div class="muted" style="padding:15px;text-align:center">' +
        'No hay partidos disponibles para esta fecha.' +
        '</div>';

      return;
    }

    summary.textContent =
      data.fixtures.length +
      ' partido' +
      (
        data.fixtures.length === 1
          ? ''
          : 's'
      ) +
      ' encontrado' +
      (
        data.fixtures.length === 1
          ? ''
          : 's'
      ) +
      '.';

    list.innerHTML =
      data.fixtures
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

  } catch (e) {

    error.style.display =
      'block';

    error.textContent =
      e.message ||
      'Error al buscar partidos.';

  } finally {

    loading.style.display =
      'none';
  }
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

  if (!panel) {
    return;
  }

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

  panel.classList.add(
    'open'
  );

  loading.style.display =
    'block';

  error.style.display =
    'none';

  content.classList
    .remove(
      'show'
    );

  try {

    const params =
      new URLSearchParams({
        home,
        away,
        date
      });

    const response =
      await fetch(
        '/api/analyze?' +
        params.toString(),
        {
          cache:
            'no-store'
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      !data.ok
    ) {

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

  } catch (e) {

    error.style.display =
      'block';

    error.textContent =
      e.message ||
      'Error de análisis.';

  } finally {

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

  if (panel) {

    panel.classList
      .remove(
        'open'
      );
  }
}

document.getElementById(
  'date'
).value =
  localDateValue();

searchFixtures();

</script>

</body>

</html>`;
}

app.get(
  '/api/status',
  (req, res) => {

    res.json({

      ok:
        true,

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

app.get(
  '/api/fixtures',
  async (req, res) => {

    try {

      const date =
        String(
          req.query.date ||
          ''
        ).trim() ||
        new Date()
          .toISOString()
          .slice(
            0,
            10
          );

      const matches =
        await getFixtures(
          date
        );

      const fixtures =
        matches

          .filter(
            m =>
              m?.homeTeam?.name &&
              m?.awayTeam?.name
          )

          .sort(
            (a, b) =>
              String(
                a?.utcDate ||
                ''
              ).localeCompare(
                String(
                  b?.utcDate ||
                  ''
                )
              )
          )

          .map(
            m => ({

              id:
                m.id ||
                null,

              home:
                m.homeTeam.name,

              away:
                m.awayTeam.name,

              kickoff:
                m.utcDate ||
                null,

              competition:
                m.competition?.name ||
                m.competitionCode ||
                null,

              competitionCode:
                m.competitionCode ||
                null,

              status:
                m.status ||
                null
            })
          );

      res.json({

        ok:
          true,

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

      res.status(
        500
      ).json({

        ok:
          false,

        error:
          error.message ||
          'Error al cargar los partidos.',

        modelVersion:
          MODEL_VERSION
      });
    }
  }
);

app.get(
  '/api/analyze',
  async (req, res) => {

    try {

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
          .slice(
            0,
            10
          );

      if (
        !homeName ||
        !awayName
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              'Debes proporcionar home y away.'
          });
      }

      /*
       * Buscar el partido
       * en la fecha solicitada.
       */

      let selected =
        selectFixture(
          await getFixtures(
            date
          ),
          homeName,
          awayName
        );

      /*
       * Si no está, revisar
       * el día siguiente.
       */

      if (!selected) {

        const next =
          new Date(
            `${date}T12:00:00`
          );

        next.setDate(
          next.getDate() +
          1
        );

        const nextDate =
          next
            .toISOString()
            .slice(
              0,
              10
            );

        selected =
          selectFixture(
            await getFixtures(
              nextDate
            ),
            homeName,
            awayName
          );

        if (selected) {
          date =
            nextDate;
        }
      }

      if (!selected) {

        return res
          .status(404)
          .json({

            ok:
              false,

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

      const competitionCode =
        fixture.competitionCode;

      /*
       * Obtener historial de
       * ambos equipos.
       */

      const [
        homeMatches,
        awayMatches
      ] =
        await Promise.all([

          getTeamRecentMatches(
            homeId,
            competitionCode,
            date
          ),

          getTeamRecentMatches(
            awayId,
            competitionCode,
            date
          )

        ]);

      /*
       * Calcular estadísticas.
       */

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
       * Estabilización.
       */

      try {

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

      } catch (_) {}

      /*
       * Shrink to mean.
       */

      try {

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

      } catch (_) {}

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

      try {

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

      } catch (_) {

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
          competitionCode,
          fixture.utcDate
        );

      /*
       * Mercados.
       */

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
       * Marcador más probable.
       */

      const score =
        mostLikelyScore(
          modelInput.homeXg,
          modelInput.awayXg
        );

      /*
       * Alertas de valor.
       */

      const valueAlert =
        buildValueAlert(
          markets
        );

      /*
       * Respuesta final.
       */

      return res.json({

        ok:
          true,

        modelVersion:
          MODEL_VERSION,

        match: {

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
            competitionCode ||
            null
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
                homeStats.avgGoalsFor.toFixed(2)
              ),

            goalsAgainst:
              Number(
                homeStats.avgGoalsAgainst.toFixed(2)
              )
          },

          away: {

            goalsFor:
              Number(
                awayStats.avgGoalsFor.toFixed(2)
              ),

            goalsAgainst:
              Number(
                awayStats.avgGoalsAgainst.toFixed(2)
              )
          }
        },

        xG: {

          home:
            Number(
              modelInput.homeXg.toFixed(2)
            ),

          away:
            Number(
              modelInput.awayXg.toFixed(2)
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
            model.homeWin *
            100,

          draw:
            model.draw *
            100,

          awayWin:
            model.awayWin *
            100,

          over25:
            model.over25 *
            100,

          under25:
            model.under25 *
            100,

          btts:
            model.btts *
            100
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

        diagnostics: {

          outlierMarkets:
            markets
              .filter(
                m =>
                  m.isOutlier
              )
              .map(
                m => ({

                  name:
                    m.name,

                  bestOdds:
                    m.bestOdds,

                  referenceOdds:
                    m.referenceOdds,

                  bestEvPct:
                    m.bestEvPct,

                  referenceEvPct:
                    m.referenceEvPct
                })
              ),

          valueFilter: {

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

    } catch (error) {

      console.error(
        'ANALYZE ERROR:',
        error
      );

      return res
        .status(500)
        .json({

          ok:
            false,

          error:
            error.message ||
            'Error interno del servidor.',

          modelVersion:
            MODEL_VERSION
        });
    }
  }
);

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

    res.type(
      'html'
    ).send(
      renderPage()
    );
  }
);

app.get(
  '/health',
  (req, res) =>
    res.json({

      ok:
        true,

      modelVersion:
        MODEL_VERSION,

      uptime:
        process.uptime()
    })
);

app.listen(
  PORT,
  () =>
    console.log(
      `V7.6.3 ANALYST running on port ${PORT}`
    )
);
