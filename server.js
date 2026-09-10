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

const FOOTBALL_DATA_KEY =
  process.env.FOOTBALL_DATA_KEY || '';

const ODDS_API_KEY =
  process.env.ODDS_API_KEY || '';

const FOOTBALL_DATA_BASE =
  'https://api.football-data.org/v4';

const ODDS_BASE =
  'https://api.the-odds-api.com/v4';

const CACHE_TTL_MS =
  5 * 60 * 1000;

const MODEL_VERSION =
  'V7.6.1';

const cache =
  new Map();

/*
====================================================
COMPETICIONES
====================================================
*/

const ODDS_SPORT_BY_COMPETITION = {
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  BL1: 'soccer_germany_bundesliga',
  SA: 'soccer_italy_serie_a',
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
  EL: 'soccer_uefa_europa_league'
};

/*
====================================================
CACHE
====================================================
*/

function cacheGet(key) {
  const item = cache.get(key);

  if (
    !item ||
    Date.now() - item.time > CACHE_TTL_MS
  ) {
    return null;
  }

  return item.value;
}

function cacheSet(key, value) {
  cache.set(key, {
    time: Date.now(),
    value
  });

  return value;
}

/*
====================================================
FETCH JSON
====================================================
*/

async function fetchJson(url, options = {}) {
  const response =
    await fetch(url, options);

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text
    };
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

    throw error;
  }

  return data;
}

/*
====================================================
FOOTBALL DATA
====================================================
*/

async function footballData(path) {
  if (!FOOTBALL_DATA_KEY) {
    throw new Error(
      'FOOTBALL_DATA_KEY no configurada'
    );
  }

  return fetchJson(
    `${FOOTBALL_DATA_BASE}${path}`,
    {
      headers: {
        'X-Auth-Token':
          FOOTBALL_DATA_KEY
      }
    }
  );
}

/*
====================================================
UTILIDADES
====================================================
*/

function dateOnly(date) {
  return new Date(date)
    .toISOString()
    .slice(0, 10);
}

function weightedAverage(values) {
  const valid =
    values
      .filter(v =>
        Number.isFinite(Number(v))
      )
      .map(Number);

  if (!valid.length) {
    return null;
  }

  const weights =
    valid.map((_, i) => i + 1);

  const totalWeight =
    weights.reduce(
      (a, b) => a + b,
      0
    );

  return valid.reduce(
    (sum, value, i) =>
      sum + value * weights[i],
    0
  ) / totalWeight;
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(
      /[\u0300-\u036f]/g,
      ''
    )
    .replace(
      /[^a-z0-9]/g,
      ''
    );
}

function namesMatch(a, b) {
  const x =
    normalizeName(a);

  const y =
    normalizeName(b);

  if (!x || !y) {
    return false;
  }

  return (
    x === y ||
    x.includes(y) ||
    y.includes(x)
  );
}

function median(values) {
  const sorted =
    values
      .filter(Number.isFinite)
      .slice()
      .sort(
        (a, b) => a - b
      );

  if (!sorted.length) {
    return null;
  }

  const middle =
    Math.floor(
      sorted.length / 2
    );

  return sorted.length % 2
    ? sorted[middle]
    : (
        sorted[middle - 1] +
        sorted[middle]
      ) / 2;
}

/*
====================================================
POISSON
====================================================
*/

function poissonProbability(
  lambda,
  goals
) {
  if (
    !Number.isFinite(lambda) ||
    lambda <= 0
  ) {
    return 0;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, goals) /
    factorial(goals)
  );
}

function factorial(n) {
  let result = 1;

  for (
    let i = 2;
    i <= n;
    i++
  ) {
    result *= i;
  }

  return result;
}

function mostLikelyScore(
  homeXg,
  awayXg
) {
  let best = {
    probability: -1,
    home: 0,
    away: 0
  };

  for (
    let home = 0;
    home <= 7;
    home++
  ) {
    const homeProb =
      poissonProbability(
        homeXg,
        home
      );

    for (
      let away = 0;
      away <= 7;
      away++
    ) {
      const awayProb =
        poissonProbability(
          awayXg,
          away
        );

      const probability =
        homeProb * awayProb;

      if (
        probability >
        best.probability
      ) {
        best = {
          probability,
          home,
          away
        };
      }
    }
  }

  return {
    score:
      `${best.home}-${best.away}`,

    home:
      best.home,

    away:
      best.away,

    probability:
      pct(best.probability)
  };
}

/*
====================================================
PROMEDIOS DE EQUIPO
====================================================
*/

function teamAverages(
  matches,
  teamId
) {
  const finished =
    (matches || [])
      .filter(
        m =>
          m.status ===
          'FINISHED'
      )
      .filter(
        m =>
          m.score?.fullTime?.home != null &&
          m.score?.fullTime?.away != null
      )
      .filter(
        m =>
          m.homeTeam?.id === teamId ||
          m.awayTeam?.id === teamId
      )
      .sort(
        (a, b) =>
          new Date(b.utcDate) -
          new Date(a.utcDate)
      )
      .slice(0, 10);

  if (!finished.length) {
    return {
      matches: [],
      gf: null,
      ga: null,
      homeGF: null,
      homeGA: null,
      awayGF: null,
      awayGA: null,
      form: null
    };
  }

  let gf = 0;
  let ga = 0;

  let homeGF = 0;
  let homeGA = 0;

  let awayGF = 0;
  let awayGA = 0;

  let homeCount = 0;
  let awayCount = 0;

  let form = 0;

  for (
    const m of finished
  ) {
    const isHome =
      m.homeTeam.id === teamId;

    const hg =
      Number(
        m.score.fullTime.home
      );

    const ag =
      Number(
        m.score.fullTime.away
      );

    const scored =
      isHome ? hg : ag;

    const conceded =
      isHome ? ag : hg;

    gf += scored;
    ga += conceded;

    if (isHome) {
      homeGF += hg;
      homeGA += ag;
      homeCount++;
    } else {
      awayGF += ag;
      awayGA += hg;
      awayCount++;
    }

    form +=
      scored > conceded
        ? 1
        : scored === conceded
          ? 0.5
          : 0;
  }

  return {
    matches: finished,

    gf:
      gf / finished.length,

    ga:
      ga / finished.length,

    homeGF:
      homeCount
        ? homeGF / homeCount
        : null,

    homeGA:
      homeCount
        ? homeGA / homeCount
        : null,

    awayGF:
      awayCount
        ? awayGF / awayCount
        : null,

    awayGA:
      awayCount
        ? awayGA / awayCount
        : null,

    form:
      form / finished.length
  };
}

/*
====================================================
PARTIDOS RECIENTES
====================================================
*/

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

  return cacheSet(
    key,
    data.matches || []
  );
}

/*
====================================================
FIXTURES
====================================================
*/

async function getFixtures(date) {
  const key =
    `fixtures:${date}`;

  const cached =
    cacheGet(key);

  if (cached) {
    return cached;
  }

  const competitions = [
    'PL',
    'PD',
    'BL1',
    'SA',
    'FL1',
    'CL',
    'EL'
  ];

  const all = [];

  for (
    const code of competitions
  ) {
    try {
      const data =
        await footballData(
          `/competitions/${code}/matches?dateFrom=${date}&dateTo=${date}`
        );

      for (
        const match of
        data.matches || []
      ) {
        all.push({
          ...match,

          competitionCode:
            code,

          competitionName:
            match.competition?.name ||
            code
        });
      }
    } catch (error) {
      console.error(
        `Fixtures ${code}: ${error.message}`
      );
    }
  }

  all.sort(
    (a, b) =>
      new Date(a.utcDate) -
      new Date(b.utcDate)
  );

  return cacheSet(
    key,
    all
  );
}

/*
====================================================
THE ODDS API
====================================================

BTTS NO se solicita al endpoint.
BTTS se calcula estadísticamente.
====================================================
*/

async function getOdds(
  competitionCode,
  homeName,
  awayName
) {
  if (!ODDS_API_KEY) {
    return null;
  }

  const sport =
    ODDS_SPORT_BY_COMPETITION[
      competitionCode
    ];

  if (!sport) {
    return null;
  }

  const key =
    `odds:${sport}`;

  let events =
    cacheGet(key);

  if (!events) {
    const url =
      `${ODDS_BASE}/sports/${sport}/odds` +
      `?regions=us,uk` +
      `&markets=h2h,totals` +
      `&oddsFormat=decimal` +
      `&apiKey=${encodeURIComponent(
        ODDS_API_KEY
      )}`;

    try {
      events =
        await fetchJson(url);

      cacheSet(
        key,
        events
      );
    } catch (error) {
      console.error(
        `Odds ${sport}: ${error.message}`
      );

      return null;
    }
  }

  const event =
    (events || [])
      .find(
        e =>
          (
            namesMatch(
              e.home_team,
              homeName
            ) &&
            namesMatch(
              e.away_team,
              awayName
            )
          ) ||
          (
            namesMatch(
              e.home_team,
              awayName
            ) &&
            namesMatch(
              e.away_team,
              homeName
            )
          )
      );

  if (!event) {
    return null;
  }

  const prices = {
    home: [],
    draw: [],
    away: [],
    over25: [],
    under25: []
  };

  for (
    const bookmaker of
    event.bookmakers || []
  ) {
    for (
      const market of
      bookmaker.markets || []
    ) {
      for (
        const outcome of
        market.outcomes || []
      ) {
        const price =
          Number(
            outcome.price
          );

        if (
          !Number.isFinite(price) ||
          price <= 1
        ) {
          continue;
        }

        if (
          market.key === 'h2h'
        ) {
          if (
            namesMatch(
              outcome.name,
              homeName
            )
          ) {
            prices.home.push({
              price,
              bookmaker:
                bookmaker.title
            });
          }

          else if (
            namesMatch(
              outcome.name,
              awayName
            )
          ) {
            prices.away.push({
              price,
              bookmaker:
                bookmaker.title
            });
          }

          else if (
            normalizeName(
              outcome.name
            ) === 'draw'
          ) {
            prices.draw.push({
              price,
              bookmaker:
                bookmaker.title
            });
          }
        }

        if (
          market.key === 'totals' &&
          Number(outcome.point) === 2.5
        ) {
          const name =
            String(
              outcome.name || ''
            ).toLowerCase();

          if (name === 'over') {
            prices.over25.push({
              price,
              bookmaker:
                bookmaker.title
            });
          }

          else if (name === 'under') {
            prices.under25.push({
              price,
              bookmaker:
                bookmaker.title
            });
          }
        }
      }
    }
  }

  const best = {};

  for (
    const [
      marketKey,
      list
    ] of Object.entries(prices)
  ) {
    if (!list.length) {
      continue;
    }

    const bestPrice =
      list.reduce(
        (
          bestItem,
          item
        ) =>
          !bestItem ||
          item.price >
            bestItem.price
            ? item
            : bestItem,
        null
      );

    best[marketKey] = {
      ...bestPrice,

      bookmakerCount:
        new Set(
          list.map(
            x => x.bookmaker
          )
        ).size,

      medianOdds:
        median(
          list.map(
            x => x.price
          )
        ),

      prices: list
    };
  }

  return {
    ...best,

    eventId:
      event.id,

    commenceTime:
      event.commence_time
  };
}

/*
====================================================
MERCADOS
====================================================
*/

function buildMarkets(
  model,
  odds
) {
  const raw = [
    {
      key: 'home',
      label: 'Gana el local',
      shortLabel: '1',
      probability: model.homeWin,
      odds: odds?.home?.price,
      bookmaker: odds?.home?.bookmaker,
      bookmakerCount:
        odds?.home?.bookmakerCount,
      medianOdds:
        odds?.home?.medianOdds
    },

    {
      key: 'draw',
      label: 'Empate',
      shortLabel: 'X',
      probability: model.draw,
      odds: odds?.draw?.price,
      bookmaker: odds?.draw?.bookmaker,
      bookmakerCount:
        odds?.draw?.bookmakerCount,
      medianOdds:
        odds?.draw?.medianOdds
    },

    {
      key: 'away',
      label: 'Gana el visitante',
      shortLabel: '2',
      probability: model.awayWin,
      odds: odds?.away?.price,
      bookmaker: odds?.away?.bookmaker,
      bookmakerCount:
        odds?.away?.bookmakerCount,
      medianOdds:
        odds?.away?.medianOdds
    },

    {
      key: 'over25',
      label: 'Más de 2.5 goles',
      shortLabel: 'Over 2.5',
      probability: model.over25,
      odds: odds?.over25?.price,
      bookmaker: odds?.over25?.bookmaker,
      bookmakerCount:
        odds?.over25?.bookmakerCount,
      medianOdds:
        odds?.over25?.medianOdds
    },

    {
      key: 'under25',
      label: 'Menos de 2.5 goles',
      shortLabel: 'Under 2.5',
      probability: model.under25,
      odds: odds?.under25?.price,
      bookmaker: odds?.under25?.bookmaker,
      bookmakerCount:
        odds?.under25?.bookmakerCount,
      medianOdds:
        odds?.under25?.medianOdds
    }
  ];

  return raw.map(market => {
    const hasOdds =
      Number.isFinite(
        Number(market.odds)
      ) &&
      Number(market.odds) > 1;

    const impliedPct =
      hasOdds
        ? pct(
            implied(
              market.odds
            )
          )
        : null;

    const evPct =
      hasOdds
        ? pct(
            ev(
              market.probability,
              market.odds
            )
          )
        : null;

    const medianOdds =
      Number(
        market.medianOdds
      );

    const isOutlier =
      hasOdds &&
      Number.isFinite(
        medianOdds
      ) &&
      market.bookmakerCount >= 2 &&
      market.odds >
        medianOdds * 1.35;

    let valueLevel =
      'Sin valor';

    if (
      Number.isFinite(evPct)
    ) {
      if (evPct >= 20) {
        valueLevel =
          'Valor extremo';
      }

      else if (evPct >= 10) {
        valueLevel =
          'Valor fuerte';
      }

      else if (evPct > 0) {
        valueLevel =
          'Valor leve';
      }
    }

    if (
      isOutlier &&
      evPct > 0
    ) {
      valueLevel =
        'Precio atípico';
    }

    return {
      ...market,

      probabilityPct:
        pct(
          market.probability
        ),

      impliedPct,

      evPct,

      isOutlier,

      valueLevel
    };
  });
}

/*
====================================================
MEJOR OPORTUNIDAD
====================================================
*/

function bestValue(markets) {
  const valid =
    (markets || [])
      .filter(market =>
        Number.isFinite(
          Number(
            market.evPct
          )
        ) &&
        Number(
          market.evPct
        ) > 0 &&
        Number.isFinite(
          Number(
            market.probabilityPct
          )
        ) &&
        Number(
          market.probabilityPct
        ) >= 55
      )
      .filter(market =>
        !market.isOutlier ||
        Number(
          market.bookmakerCount
        ) >= 2
      );

  if (!valid.length) {
    return null;
  }

  return valid.sort(
    (a, b) => {
      const evDiff =
        Number(b.evPct) -
        Number(a.evPct);

      if (
        Math.abs(evDiff) > 1
      ) {
        return evDiff;
      }

      return (
        Number(
          b.probabilityPct
        ) -
        Number(
          a.probabilityPct
        )
      );
    }
  )[0] || null;
}

/*
====================================================
NIVEL DE CONFIANZA
====================================================
*/

function confidenceLevel(value) {
  const n =
    Number(value);

  if (
    !Number.isFinite(n)
  ) {
    return {
      label:
        'Sin datos suficientes',

      text:
        'No hay suficientes datos para valorar la solidez del análisis.'
    };
  }

  if (n >= 80) {
    return {
      label: 'Alta',

      text:
        'Los datos disponibles son relativamente sólidos para este análisis.'
    };
  }

  if (n >= 60) {
    return {
      label: 'Media',

      text:
        'Hay una base razonable de datos, aunque todavía existe incertidumbre.'
    };
  }

  return {
    label: 'Baja',

    text:
      'Los datos disponibles son limitados o presentan bastante incertidumbre.'
  };
}

/*
====================================================
EXPLICACIÓN DEL VALOR
====================================================
*/

function valueExplanation(
  market
) {
  if (!market) {
    return '';
  }

  if (
    market.valueLevel ===
    'Precio atípico'
  ) {
    return (
      'La cuota está muy por encima de la referencia disponible. Verifica el precio antes de considerarlo.'
    );
  }

  if (
    market.valueLevel ===
    'Valor extremo'
  ) {
    return (
      'El modelo detecta una diferencia extraordinariamente grande entre su probabilidad y la cuota.'
    );
  }

  if (
    market.valueLevel ===
    'Valor fuerte'
  ) {
    return (
      'La cuota parece pagar más de lo que el modelo estima que debería pagar.'
    );
  }

  if (
    market.valueLevel ===
    'Valor leve'
  ) {
    return (
      'El modelo encuentra una pequeña ventaja frente a la cuota disponible.'
    );
  }

  return (
    'No se detecta una ventaja estadística clara frente a la cuota.'
  );
}

/*
====================================================
STATUS
====================================================
*/

app.get(
  '/api/status',
  (req, res) => {
    res.json({
      ok: true,

      footballDataConfigured:
        Boolean(
          FOOTBALL_DATA_KEY
        ),

      oddsApiConfigured:
        Boolean(
          ODDS_API_KEY
        ),

      provider:
        'football-data.org + The Odds API',

      cacheMinutes:
        CACHE_TTL_MS / 60000,

      modelVersion:
        MODEL_VERSION
    });
  }
);

/*
====================================================
API FIXTURES
====================================================
*/

app.get(
  '/api/fixtures',
  async (req, res) => {
    const date =
      /^\d{4}-\d{2}-\d{2}$/.test(
        req.query.date || ''
      )
        ? req.query.date
        : dateOnly(
            new Date()
          );

    try {
      const matches =
        await getFixtures(
          date
        );

      res.json({
        ok: true,
        date,
        count:
          matches.length,
        matches
      });
    } catch (error) {
      console.error(error);

      res.status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }
  }
);

/*
====================================================
API ANALYZE
====================================================
*/

app.get(
  '/api/analyze',
  async (req, res) => {
    const id =
      Number(
        req.query.id
      );

    if (!id) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            'Falta id del partido'
        });
    }

    try {
      const match =
        await footballData(
          `/matches/${id}`
        );

      const homeId =
        match.homeTeam?.id;

      const awayId =
        match.awayTeam?.id;

      if (
        !homeId ||
        !awayId
      ) {
        throw new Error(
          'El partido no tiene equipos válidos'
        );
      }

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

      const ha =
        teamAverages(
          homeMatches,
          homeId
        );

      const aa =
        teamAverages(
          awayMatches,
          awayId
        );

      /*
      ----------------------------------------------
      ESTABILIZACIÓN
      ----------------------------------------------
      */

      const homeStats =
        stabilizeStats(
          ha,
          ha.matches.length
        );

      const awayStats =
        stabilizeStats(
          aa,
          aa.matches.length
        );

      /*
      ----------------------------------------------
      ATAQUE / DEFENSA
      ----------------------------------------------
      */

      const homeAttack =
        weightedAverage([
          homeStats.homeGF,
          homeStats.gf,
          homeStats.gf
        ].filter(
          x => x != null
        )) ?? 1.35;

      const homeDefense =
        weightedAverage([
          homeStats.homeGA,
          homeStats.ga,
          homeStats.ga
        ].filter(
          x => x != null
        )) ?? 1.20;

      const awayAttack =
        weightedAverage([
          awayStats.awayGF,
          awayStats.gf,
          awayStats.gf
        ].filter(
          x => x != null
        )) ?? 1.35;

      const awayDefense =
        weightedAverage([
          awayStats.awayGA,
          awayStats.ga,
          awayStats.ga
        ].filter(
          x => x != null
        )) ?? 1.20;

      /*
      ----------------------------------------------
      FORMA
      ----------------------------------------------
      */

      const homeForm =
        shrinkToMean(
          ha.form,
          0.50,
          ha.matches.length
        );

      const awayForm =
        shrinkToMean(
          aa.form,
          0.50,
          aa.matches.length
        );

      /*
      ----------------------------------------------
      xG
      ----------------------------------------------
      */

      let homeXg =
        (
          homeAttack * 0.60
        ) +
        (
          awayDefense * 0.40
        );

      let awayXg =
        (
          awayAttack * 0.60
        ) +
        (
          homeDefense * 0.40
        );

      homeXg *= 1.08;
      awayXg *= 0.94;

      if (
        homeForm != null
      ) {
        homeXg *=
          0.94 +
          (
            homeForm * 0.12
          );
      }

      if (
        awayForm != null
      ) {
        awayXg *=
          0.94 +
          (
            awayForm * 0.12
          );
      }

      homeXg =
        Math.min(
          4.50,
          Math.max(
            0.20,
            homeXg
          )
        );

      awayXg =
        Math.min(
          4.50,
          Math.max(
            0.20,
            awayXg
          )
        );

      /*
      ----------------------------------------------
      MODELO
      ----------------------------------------------
      */

      const model =
        matchModel(
          homeXg,
          awayXg
        );

      /*
      ----------------------------------------------
      MARCADOR MÁS PROBABLE
      ----------------------------------------------
      */

      const likelyScore =
        mostLikelyScore(
          homeXg,
          awayXg
        );

      /*
      ----------------------------------------------
      CUOTAS
      ----------------------------------------------
      */

      const odds =
        await getOdds(
          match.competition?.code,
          match.homeTeam.name,
          match.awayTeam.name
        );

      const markets =
        buildMarkets(
          model,
          odds
        );

      const best =
        bestValue(
          markets
        );

      /*
      ----------------------------------------------
      CONFIANZA
      ----------------------------------------------
      */

      const topProbability =
        Math.max(
          model.homeWin,
          model.draw,
          model.awayWin,
          model.over25,
          model.under25,
          model.btts
        );

      const topEdge =
        best &&
        Number.isFinite(
          Number(best.evPct)
        )
          ? Number(best.evPct) / 100
          : 0;

      const sampleSize =
        Math.min(
          ha.matches.length,
          aa.matches.length
        );

      const confidenceRaw =
        confidence(
          topProbability,
          sampleSize,
          topEdge
        );

      const confidenceInfo =
        confidenceLevel(
          confidenceRaw
        );

      /*
      ----------------------------------------------
      BET / NO BET
      ----------------------------------------------
      */

      const betEligible =
        Boolean(best) &&
        Number(
          best.probabilityPct
        ) >= 55 &&
        Number(
          best.evPct
        ) >= 2 &&
        Number(
          confidenceRaw
        ) >= 60 &&
        sampleSize >= 4;

      const recommendation =
        betEligible
          ? 'BET'
          : 'NO BET';

      let recommendationReason;

      if (betEligible) {
        recommendationReason =
          'Valor positivo con probabilidad, confianza y muestra suficientes.';
      }

      else if (!best) {
        recommendationReason =
          'No existe una oportunidad de valor positiva que cumpla los filtros.';
      }

      else if (sampleSize < 4) {
        recommendationReason =
          'Muestra estadística insuficiente.';
      }

      else if (
        Number(
          best.probabilityPct
        ) < 55
      ) {
        recommendationReason =
          'La probabilidad del modelo es demasiado baja.';
      }

      else if (
        Number(
          best.evPct
        ) < 2
      ) {
        recommendationReason =
          'La ventaja estadística sobre la cuota es demasiado pequeña.';
      }

      else {
        recommendationReason =
          'La confianza del modelo no alcanza el nivel mínimo.';
      }

      /*
      ----------------------------------------------
      ALERTA DE VALOR
      ----------------------------------------------
      */

      const valueAlert =
        markets
          .filter(
            market =>
              market.valueLevel ===
                'Precio atípico' ||
              market.valueLevel ===
                'Valor extremo'
          )
          .sort(
            (a, b) =>
              (
                b.evPct ||
                -Infinity
              ) -
              (
                a.evPct ||
                -Infinity
              )
          )[0] ||
          null;

      /*
      ----------------------------------------------
      RESPUESTA
      ----------------------------------------------
      */

      res.json({
        ok: true,

        modelVersion:
          MODEL_VERSION,

        match: {
          id:
            match.id,

          utcDate:
            match.utcDate,

          status:
            match.status,

          homeTeam:
            match.homeTeam,

          awayTeam:
            match.awayTeam,

          competition:
            match.competition
        },

        recommendation,

        recommendationReason,

        betEligible,

        strength: {
          home: {
            attack:
              homeAttack,

            defense:
              homeDefense,

            form:
              ha.form,

            sample:
              ha.matches.length
          },

          away: {
            attack:
              awayAttack,

            defense:
              awayDefense,

            form:
              aa.form,

            sample:
              aa.matches.length
          }
        },

        recentForm: {
          home:
            ha.matches
              .slice(0, 5)
              .map(m => {
                const h =
                  m.homeTeam.id ===
                  homeId;

                const gf =
                  h
                    ? m.score.fullTime.home
                    : m.score.fullTime.away;

                const ga =
                  h
                    ? m.score.fullTime.away
                    : m.score.fullTime.home;

                return {
                  date:
                    m.utcDate,

                  opponent:
                    h
                      ? m.awayTeam.name
                      : m.homeTeam.name,

                  gf,
                  ga,

                  result:
                    gf > ga
                      ? 'W'
                      : gf === ga
                        ? 'D'
                        : 'L'
                };
              }),

          away:
            aa.matches
              .slice(0, 5)
              .map(m => {
                const h =
                  m.homeTeam.id ===
                  awayId;

                const gf =
                  h
                    ? m.score.fullTime.home
                    : m.score.fullTime.away;

                const ga =
                  h
                    ? m.score.fullTime.away
                    : m.score.fullTime.home;

                return {
                  date:
                    m.utcDate,

                  opponent:
                    h
                      ? m.awayTeam.name
                      : m.homeTeam.name,

                  gf,
                  ga,

                  result:
                    gf > ga
                      ? 'W'
                      : gf === ga
                        ? 'D'
                        : 'L'
                };
              })
        },

        averages: {
          home: {
            gf:
              ha.gf,

            ga:
              ha.ga,

            homeGF:
              ha.homeGF,

            homeGA:
              ha.homeGA
          },

          away: {
            gf:
              aa.gf,

            ga:
              aa.ga,

            awayGF:
              aa.awayGF,

            awayGA:
              aa.awayGA
          }
        },

        xG: {
          home:
            Number(
              homeXg.toFixed(3)
            ),

          away:
            Number(
              awayXg.toFixed(3)
            ),

          total:
            Number(
              (
                homeXg +
                awayXg
              ).toFixed(3)
            )
        },

        mostLikelyScore:
          likelyScore,

        model: {
          homeWin:
            pct(
              model.homeWin
            ),

          draw:
            pct(
              model.draw
            ),

          awayWin:
            pct(
              model.awayWin
            ),

          over25:
            pct(
              model.over25
            ),

          under25:
            pct(
              model.under25
            ),

          btts:
            pct(
              model.btts
            )
        },

        markets,

        oddsAvailable:
          Boolean(
            odds
          ),

        bestValue:
          best,

        valueAlert:
          valueAlert
            ? {
                ...valueAlert,

                explanation:
                  valueExplanation(
                    valueAlert
                  )
              }
            : null,

        confidence:
          confidenceRaw,

        confidenceLevel:
          confidenceInfo.label,

        confidenceExplanation:
          confidenceInfo.text,

        attribution:
          'Football data provided by the Football-Data.org API.'
      });

    } catch (error) {
      console.error(error);

      res.status(
        error.status === 404
          ? 404
          : 500
      ).json({
        ok: false,
        error:
          error.message
      });
    }
  }
);

/*
====================================================
INTERFAZ WEB V7.6.1 ANALYST
====================================================
*/

const html = `<!doctype html>

<html lang="es">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1,viewport-fit=cover"
>

<meta
  name="theme-color"
  content="#05070b"
>

<title>
Mi Pronóstico Deportivo · V7.6.1
</title>

<style>

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background:
    radial-gradient(
      circle at top,
      #111827 0,
      #070a10 42%,
      #05070b 100%
    );
  color: #f4f7fb;
  font-family:
    Arial,
    Helvetica,
    sans-serif;
}

button,
input {
  font: inherit;
}

button {
  cursor: pointer;
}

.wrap {
  max-width: 980px;
  margin: auto;
  padding:
    16px
    14px
    100px;
}

.top {
  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  gap:
    12px;
}

.brand {
  font-size:
    19px;

  font-weight:
    900;

  letter-spacing:
    -.4px;
}

.version {
  padding:
    6px 9px;

  border:
    1px solid
    #2c3749;

  border-radius:
    999px;

  color:
    #8ef0b5;

  background:
    #0c1512;

  font-size:
    11px;

  font-weight:
    800;
}

.hero {
  margin-top:
    14px;

  padding:
    22px 18px;

  border:
    1px solid
    #202b3a;

  border-radius:
    22px;

  background:
    linear-gradient(
      145deg,
      #101722,
      #090e15
    );

  box-shadow:
    0 16px 45px
    rgba(0,0,0,.25);
}

.eyebrow {
  color:
    #72e7a6;

  font-size:
    11px;

  font-weight:
    900;

  letter-spacing:
    1.4px;

  text-transform:
    uppercase;
}

.hero h1 {
  margin:
    7px 0;

  font-size:
    clamp(
      26px,
      7vw,
      40px
    );

  line-height:
    1.02;
}

.hero p {
  margin:
    0;

  color:
    #9da9b8;

  font-size:
    14px;

  line-height:
    1.45;
}

.hero-tools {
  display:
    flex;

  flex-wrap:
    wrap;

  gap:
    7px;

  margin-top:
    16px;
}

.tool {
  border:
    1px solid
    #293548;

  border-radius:
    999px;

  padding:
    7px 10px;

  background:
    #0d131d;

  color:
    #c8d1dc;

  font-size:
    11px;

  font-weight:
    700;
}

.controls {
  display:
    flex;

  gap:
    8px;

  margin:
    14px 0;
}

.controls input {
  flex:
    1;

  min-width:
    0;

  border:
    1px solid
    #293548;

  border-radius:
    13px;

  padding:
    12px;

  background:
    #0b1119;

  color:
    #fff;
}

.controls button {
  border:
    0;

  border-radius:
    13px;

  padding:
    12px 17px;

  background:
    #72e7a6;

  color:
    #06150d;

  font-weight:
    900;
}

.section-head {
  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  gap:
    8px;

  margin:
    20px 0 9px;
}

.section-title {
  font-size:
    15px;

  font-weight:
    900;
}

.section-tag {
  color:
    #8290a2;

  font-size:
    10px;

  font-weight:
    700;
}

.card {
  margin-top:
    11px;

  padding:
    15px;

  border:
    1px solid
    #202b3a;

  border-radius:
    18px;

  background:
    #0b1018;
}

.fixture {
  background:
    linear-gradient(
      145deg,
      #0d141e,
      #090e15
    );
}

.match {
  display:
    flex;

  align-items:
    center;

  justify-content:
    space-between;

  gap:
    10px;
}

.teams {
  font-weight:
    900;

  font-size:
    15px;
}

.teams div {
  padding:
    3px 0;
}

.muted {
  color:
    #8290a2;

  font-size:
    11px;
}

.analyze {
  width:
    100%;

  margin-top:
    12px;

  padding:
    11px;

  border:
    1px solid
    #334155;

  border-radius:
    12px;

  background:
    #111a26;

  color:
    #e6edf5;

  font-weight:
    800;
}

.analyze:hover {
  border-color:
    #72e7a6;
}

.pill {
  display:
    inline-block;

  padding:
    5px 8px;

  border:
    1px solid
    #2d3b4d;

  border-radius:
    999px;

  background:
    #0e1822;

  color:
    #91a2b5;

  font-size:
    10px;

  font-weight:
    800;
}

.grid {
  display:
    grid;

  grid-template-columns:
    repeat(
      3,
      minmax(0, 1fr)
    );

  gap:
    8px;

  margin-top:
    9px;
}

.stat {
  min-width:
    0;

  padding:
    12px;

  border:
    1px solid
    #1d2938;

  border-radius:
    14px;

  background:
    #0d141e;
}

.stat b {
  display:
    block;

  margin:
    5px 0 2px;

  font-size:
    21px;
}

.help {
  margin-top:
    6px;

  color:
    #8997a8;

  font-size:
    11px;

  line-height:
    1.4;
}

.big {
  margin:
    4px 0;

  font-size:
    25px;

  font-weight:
    900;
}

.decision {
  display:
    grid;

  grid-template-columns:
    1fr 1fr;

  gap:
    9px;

  margin-top:
    10px;
}

.bet {
  border-color:
    #42d98a;

  background:
    linear-gradient(
      145deg,
      #0c2619,
      #0b1711
    );
}

.no-bet {
  border-color:
    #5b6574;

  background:
    #0d1219;
}

.decision-label {
  font-size:
    10px;

  color:
    #8997a8;

  font-weight:
    800;

  letter-spacing:
    1px;
}

.decision-value {
  margin-top:
    4px;

  font-size:
    28px;

  font-weight:
    950;
}

.score {
  text-align:
    center;

  padding:
    16px;

  border:
    1px solid
    #263244;

  border-radius:
    17px;

  background:
    linear-gradient(
      145deg,
      #101824,
      #0a1018
    );
}

.score-number {
  margin:
    4px 0;

  font-size:
    38px;

  font-weight:
    950;

  letter-spacing:
    2px;
}

.score-prob {
  color:
    #72e7a6;

  font-size:
    11px;

  font-weight:
    800;
}

.progress {
  height:
    6px;

  margin-top:
    8px;

  overflow:
    hidden;

  border-radius:
    99px;

  background:
    #1b2532;
}

.progress span {
  display:
    block;

  height:
    100%;

  width:
    var(--w);

  background:
    #72e7a6;
}

.positive {
  border-color:
    #42d98a;
}

.warning {
  border-color:
    #b99245;
}

.danger {
  border-color:
    #a75d66;
}

.value-row {
  display:
    grid;

  grid-template-columns:
    1fr auto;

  gap:
    8px;

  align-items:
    center;
}

.value-main {
  font-weight:
    900;

  font-size:
    14px;
}

.value-price {
  text-align:
    right;

  font-size:
    20px;

  font-weight:
    900;
}

.value-meta {
  margin-top:
    4px;

  color:
    #8795a6;

  font-size:
    11px;
}

.value-good {
  color:
    #72e7a6;

  font-weight:
    800;
}

.value-neutral {
  color:
    #a6b0bd;
}

.value-warning {
  color:
    #e1bd66;

  font-weight:
    800;
}

.explain {
  margin-top:
    8px;

  padding:
    12px;

  border:
    1px solid
    #202b3a;

  border-radius:
    13px;

  background:
    #0d141d;
}

.explain strong {
  font-size:
    12px;
}

.loading {
  padding:
    22px;

  text-align:
    center;

  color:
    #8491a2;

  font-size:
    12px;
}

.error {
  color:
    #ff9c9c;

  border-color:
    #6d343b;
}

.small {
  margin-top:
    18px;

  color:
    #687587;

  font-size:
    10px;

  line-height:
    1.5;

  text-align:
    center;
}

.nav {
  position:
    fixed;

  z-index:
    20;

  left:
    0;

  right:
    0;

  bottom:
    0;

  display:
    flex;

  justify-content:
    center;

  gap:
    34px;

  padding:
    11px;

  border-top:
    1px solid
    #1c2735;

  background:
    rgba(
      6,
      9,
      14,
      .94
    );

  backdrop-filter:
    blur(12px);
}

.nav a {
  color:
    #8290a2;

  text-decoration:
    none;

  font-size:
    10px;

  font-weight:
    800;

  text-align:
    center;
}

.nav a.active {
  color:
    #72e7a6;
}

@media (
  max-width: 600px
) {

  .grid {
    grid-template-columns:
      repeat(
        2,
        minmax(0, 1fr)
      );
  }

  .decision {
    grid-template-columns:
      1fr 1fr;
  }

  .teams {
    font-size:
      14px;
  }

}

</style>

</head>

<body>

<main class="wrap">

<div class="top">

<div class="brand">
⚽ Mi Pronóstico Deportivo
</div>

<div class="version">
● V7.6.1 ANALYST
</div>

</div>

<section class="hero">

<div class="eyebrow">
🧠 ANALYTICS ENGINE
</div>

<h1>
Analiza antes de apostar.
</h1>

<p>
Probabilidades, xG, forma,
marcador probable, cuotas reales,
valor estadístico y decisión
BET / NO BET.
</p>

<div class="hero-tools">

<span class="tool">
📊 1X2
</span>

<span class="tool">
⚽ xG
</span>

<span class="tool">
🥅 BTTS
</span>

<span class="tool">
💰 VALUE
</span>

<span class="tool">
🎯 CONFIDENCE
</span>

<span class="tool">
🛡️ NO BET FILTER
</span>

</div>

</section>

<div class="controls">

<input
  id="date"
  type="date"
>

<button
  onclick="loadFixtures()"
>
Buscar
</button>

</div>

<div class="section-head">

<div class="section-title">
🔥 Partidos disponibles
</div>

<div class="section-tag">
V7.6.1
</div>

</div>

<div id="app">

<div class="loading">
Cargando partidos...
</div>

</div>

<div class="small">

Las probabilidades son estimaciones
estadísticas. El valor positivo no
garantiza un resultado ganador.

La función NO BET está diseñada para
evitar recomendar apuestas cuando los
datos, la muestra, la confianza o el
valor no son suficientes.

</div>

</main>

<nav class="nav">

<a
  href="#"
  class="active"
>
🏠<br>
Inicio
</a>

<a
  href="#"
  onclick="window.scrollTo(0,0)"
>
📊<br>
Analyst
</a>

<a
  href="#"
  onclick="window.scrollTo(0,0)"
>
💎<br>
Value
</a>

</nav>

<script>

const $ =
  id =>
    document.getElementById(id);

$('date').value =
  new Date()
    .toISOString()
    .slice(0, 10);

function esc(s) {
  return String(
    s ?? ''
  ).replace(
    /[&<>"']/g,
    c => ({
      '&':
        '&amp;',

      '<':
        '&lt;',

      '>':
        '&gt;',

      '"':
        '&quot;',

      "'":
        '&#039;'
    }[c])
  );
}

function pct(v) {
  return v == null
    ? '—'
    : Number(v).toFixed(1) +
      '%';
}

function safeNumber(
  value,
  decimals = 2
) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n.toFixed(decimals)
    : '—';
}

function decisionClass(
  decision
) {
  return decision === 'BET'
    ? 'bet'
    : 'no-bet';
}

/*
====================================================
CARGAR PARTIDOS
====================================================
*/

async function loadFixtures() {

  $('app').innerHTML =
    '<div class="loading">' +
    'Buscando partidos...' +
    '</div>';

  try {

    const r =
      await fetch(
        '/api/fixtures?date=' +
        encodeURIComponent(
          $('date').value
        )
      );

    const d =
      await r.json();

    if (
      !r.ok ||
      !d.ok
    ) {
      throw new Error(
        d.error ||
        'No se pudieron cargar los partidos'
      );
    }

    if (
      !d.matches.length
    ) {

      $('app').innerHTML =
        '<div class="card">' +
        '<div class="big">Sin partidos</div>' +
        '<div class="help">' +
        'No hay partidos disponibles para esta fecha.' +
        '</div>' +
        '</div>';

      return;
    }

    $('app').innerHTML =
      d.matches
        .map(
          m => {

            const time =
              new Date(
                m.utcDate
              ).toLocaleTimeString(
                'es-MX',
                {
                  hour:
                    '2-digit',

                  minute:
                    '2-digit'
                }
              );

            return (

              '<div class="card fixture">' +

              '<div class="muted">' +

              esc(
                m.competitionName ||
                m.competition?.name ||
                'Competición'
              ) +

              ' · ' +

              time +

              '</div>' +

              '<div class="match">' +

              '<div class="teams">' +

              '<div>' +
              esc(
                m.homeTeam.name
              ) +
              '</div>' +

              '<div>' +
              esc(
                m.awayTeam.name
              ) +
              '</div>' +

              '</div>' +

              '<span class="pill">' +

              esc(
                m.status
              ) +

              '</span>' +

              '</div>' +

              '<button ' +

              'class="analyze"' +

              'onclick="analyze(' +
              m.id +
              ')"' +

              '>' +

              '🧠 ANALIZAR CON V7.6.1' +

              '</button>' +

              '<div id="a' +
              m.id +
              '">' +

              '</div>' +

              '</div>'
            );
          }
        )
        .join('');

  } catch (e) {

    $('app').innerHTML =
      '<div class="card error">' +
      esc(
        e.message
      ) +
      '</div>';

  }
}

/*
====================================================
ANALIZAR
====================================================
*/

async function analyze(id) {

  const box =
    $('a' + id);

  box.innerHTML =
    '<div class="loading">' +
    '🧠 V7.6.1 analizando forma, xG, probabilidades y cuotas...' +
    '</div>';

  try {

    const r =
      await fetch(
        '/api/analyze?id=' +
        id
      );

    const d =
      await r.json();

    if (
      !r.ok ||
      !d.ok
    ) {
      throw new Error(
        d.error ||
        'No se pudo analizar'
      );
    }

    const m =
      d.model;

    const s =
      d.strength;

    const best =
      d.bestValue;

    const decision =
      d.recommendation ||
      'NO BET';

    /*
    -----------------------------------------------
    DECISIÓN
    -----------------------------------------------
    */

    const decisionHtml =

      '<div class="card ' +
      decisionClass(
        decision
      ) +
      '">' +

      '<div class="decision">' +

      '<div>' +

      '<div class="decision-label">' +
      'DECISIÓN DEL MODELO' +
      '</div>' +

      '<div class="decision-value">' +
      esc(decision) +
      '</div>' +

      '</div>' +

      '<div>' +

      '<div class="decision-label">' +
      'CONFIANZA' +
      '</div>' +

      '<div class="decision-value">' +
      safeNumber(
        d.confidence,
        0
      ) +
      '<span style="font-size:14px">/100</span>' +
      '</div>' +

      '</div>' +

      '</div>' +

      '<div class="help">' +

      esc(
        d.recommendationReason ||
        'El modelo no encontró condiciones suficientes.'
      ) +

      '</div>' +

      '</div>';

    /*
    -----------------------------------------------
    MARCADOR PROBABLE
    -----------------------------------------------
    */

    const score =
      d.mostLikelyScore;

    const scoreHtml =
      score

        ? '<div class="section-head">' +

          '<div class="section-title">' +
          '🎯 Marcador más probable' +
          '</div>' +

          '</div>' +

          '<div class="score">' +

          '<div class="muted">' +
          esc(
            d.match.homeTeam.name
          ) +
          ' vs ' +
          esc(
            d.match.awayTeam.name
          ) +
          '</div>' +

          '<div class="score-number">' +
          esc(
            score.score
          ) +
          '</div>' +

          '<div class="score-prob">' +
          'Probabilidad estimada: ' +
          pct(
            score.probability
          ) +
          '</div>' +

          '</div>'

        : '';

    /*
    -----------------------------------------------
    PROBABILIDADES
    -----------------------------------------------
    */

    const outcomes = [

      {
        title:
          '🏠 Local',

        value:
          m.homeWin
      },

      {
        title:
          '🤝 Empate',

        value:
          m.draw
      },

      {
        title:
          '✈️ Visitante',

        value:
          m.awayWin
      },

      {
        title:
          '⚽ Over 2.5',

        value:
          m.over25
      },

      {
        title:
          '⚽ Under 2.5',

        value:
          m.under25
      },

      {
        title:
          '🥅 BTTS',

        value:
          m.btts
      }

    ];

    const outcomesHtml =
      '<div class="grid">' +

      outcomes
        .map(
          item => {

            const n =
              Number(
                item.value
              );

            const width =
              Number.isFinite(n)
                ? Math.max(
                    0,
                    Math.min(
                      100,
                      n
                    )
                  )
                : 0;

            return (

              '<div class="stat">' +

              '<span class="muted">' +

              item.title +

              '</span>' +

              '<b>' +

              pct(
                item.value
              ) +

              '</b>' +

              '<div class="progress">' +

              '<span style="--w:' +
              width +
              '%"></span>' +

              '</div>' +

              '</div>'
            );
          }
        )
        .join('') +

      '</div>';

    /*
    -----------------------------------------------
    xG
    -----------------------------------------------
    */

    const xgHtml =

      '<div class="section-head">' +

      '<div class="section-title">' +
      '⚽ Goles esperados · xG' +
      '</div>' +

      '</div>' +

      '<div class="grid">' +

      '<div class="stat">' +

      '<span class="muted">' +
      'LOCAL' +
      '</span>' +

      '<b>' +
      safeNumber(
        d.xG?.home,
        2
      ) +
      '</b>' +

      '<div class="help">' +
      'Goles esperados' +
      '</div>' +

      '</div>' +

      '<div class="stat">' +

      '<span class="muted">' +
      'VISITANTE' +
      '</span>' +

      '<b>' +
      safeNumber(
        d.xG?.away,
        2
      ) +
      '</b>' +

      '<div class="help">' +
      'Goles esperados' +
      '</div>' +

      '</div>' +

      '<div class="stat">' +

      '<span class="muted">' +
      'TOTAL' +
      '</span>' +

      '<b>' +
      safeNumber(
        d.xG?.total,
        2
      ) +
      '</b>' +

      '<div class="help">' +
      'xG combinado' +
      '</div>' +

      '</div>' +

      '</div>';

    /*
    -----------------------------------------------
    CONFIANZA
    -----------------------------------------------
    */

    const confidenceHtml =

      '<div class="card">' +

      '<div class="muted">' +
      '🎯 CONFIANZA DEL ANÁLISIS' +
      '</div>' +

      '<div class="big">' +

      esc(
        d.confidenceLevel ||
        'Sin datos'
      ) +

      '</div>' +

      '<div class="help">' +

      esc(
        d.confidenceExplanation ||
        ''
      ) +

      '</div>' +

      '<div class="progress">' +

      '<span style="--w:' +
      Math.max(
        0,
        Math.min(
          100,
          Number(
            d.confidence
          ) || 0
        )
      ) +
      '%"></span>' +

      '</div>' +

      '<div class="help">' +

      'Puntuación técnica: ' +

      safeNumber(
        d.confidence,
        0
      ) +

      ' / 100' +

      '</div>' +

      '</div>';

    /*
    -----------------------------------------------
    FUERZA
    -----------------------------------------------
    */

    const strengthHtml =

      '<div class="section-head">' +

      '<div class="section-title">' +
      '💪 Fuerza reciente' +
      '</div>' +

      '</div>' +

      '<div class="grid">' +

      '<div class="stat">' +

      '<span class="muted">' +
      'LOCAL · ATAQUE' +
      '</span>' +

      '<b>' +
      safeNumber(
        s.home.attack
      ) +
      '</b>' +

      '<div class="help">' +
      'Forma: ' +
      pct(
        Number(
          s.home.form
        ) * 100
      ) +
      '</div>' +

      '</div>' +

      '<div class="stat">' +

      '<span class="muted">' +
      'VISITANTE · ATAQUE' +
      '</span>' +

      '<b>' +
      safeNumber(
        s.away.attack
      ) +
      '</b>' +

      '<div class="help">' +
      'Forma: ' +
      pct(
        Number(
          s.away.form
        ) * 100
      ) +
      '</div>' +

      '</div>' +

      '</div>';

    /*
    -----------------------------------------------
    CUOTAS
    -----------------------------------------------
    */

    const markets =
      (d.markets || [])
        .filter(
          x =>
            Number.isFinite(
              Number(
                x.odds
              )
            )
        );

    let oddsHtml = '';

    if (!markets.length) {

      oddsHtml =
        '<div class="card">' +

        '<div class="muted">' +
        '💰 CUOTAS' +
        '</div>' +

        '<div class="help">' +
        'No se recibieron cuotas disponibles para este partido. El análisis estadístico continúa funcionando, pero no se puede validar valor de mercado.' +
        '</div>' +

        '</div>';

    } else {

      oddsHtml =
        '<div class="grid">' +

        markets
          .map(
            x => {

              const evValue =
                Number(
                  x.evPct
                );

              let valueClass =
                'value-neutral';

              let valueText =
                'Sin valor';

              if (
                x.valueLevel ===
                'Valor fuerte'
              ) {
                valueClass =
                  'value-good';

                valueText =
                  '🟢 VALOR FUERTE';
              }

              else if (
                x.valueLevel ===
                'Valor leve'
              ) {
                valueClass =
                  'value-good';

                valueText =
                  '🟡 VALOR LEVE';
              }

              else if (
                x.valueLevel ===
                'Valor extremo'
              ) {
                valueClass =
                  'value-warning';

                valueText =
                  '🟠 VALOR EXTREMO';
              }

              else if (
                x.valueLevel ===
                'Precio atípico'
              ) {
                valueClass =
                  'value-warning';

                valueText =
                  '⚠️ PRECIO ATÍPICO';
              }

              const evText =
                Number.isFinite(
                  evValue
                )
                  ? (
                      evValue >= 0
                        ? '+'
                        : ''
                    ) +
                    evValue.toFixed(1) +
                    '%'
                  : '—';

              return (

                '<div class="stat ' +

                (
                  x.isOutlier
                    ? 'warning'
                    : (
                        evValue > 0
                          ? 'positive'
                          : ''
                      )
                ) +

                '">' +

                '<div class="value-row">' +

                '<div>' +

                '<div class="value-main">' +

                esc(
                  x.label
                ) +

                '</div>' +

                '<div class="value-meta">' +

                'Modelo: ' +

                safeNumber(
                  x.probabilityPct,
                  1
                ) +

                '% · EV: ' +

                evText +

                '</div>' +

                '</div>' +

                '<div class="value-price">' +

                safeNumber(
                  x.odds
                ) +

                '</div>' +

                '</div>' +

                '<div class="' +
                valueClass +
                '" style="margin-top:7px;font-size:10px">' +

                valueText +

                '</div>' +

                '<div class="value-meta">' +

                esc(
                  x.bookmaker ||
                  'Casa no indicada'
                ) +

                ' · ' +

                (
                  x.bookmakerCount ||
                  0
                ) +

                ' casas' +

                '</div>' +

                '</div>'
              );
            }
          )
          .join('') +

        '</div>';

    }

    /*
    -----------------------------------------------
    VALUE PICK
    -----------------------------------------------
    */

    let bestHtml = '';

    if (best) {

      bestHtml =

        '<div class="card positive">' +

        '<div class="muted">' +
        '💎 VALUE PICK' +
        '</div>' +

        '<div class="big">' +

        esc(
          best.label
        ) +

        '</div>' +

        '<div>' +

        'Cuota ' +

        '<b>' +

        safeNumber(
          best.odds
        ) +

        '</b>' +

        ' · Modelo ' +

        safeNumber(
          best.probabilityPct,
          1
        ) +

        '%' +

        ' · EV ' +

        (
          Number(
            best.evPct
          ) >= 0
            ? '+'
            : ''
        ) +

        safeNumber(
          best.evPct,
          1
        ) +

        '%' +

        '</div>' +

        '<div class="help">' +

        'Esta es la oportunidad que supera los filtros estadísticos actuales. No representa una garantía de acierto.' +

        '</div>' +

        '</div>';

    }

    else {

      bestHtml =

        '<div class="card">' +

        '<div class="muted">' +
        '🛡️ NO VALUE PICK' +
        '</div>' +

        '<div class="big">' +
        'Sin apuesta recomendada' +
        '</div>' +

        '<div class="help">' +

        'El modelo no encontró una oportunidad que cumpla simultáneamente los filtros de probabilidad, EV, confianza y muestra.' +

        '</div>' +

        '</div>';

    }

    /*
    -----------------------------------------------
    ALERTA
    -----------------------------------------------
    */

    let alertHtml = '';

    if (
      d.valueAlert
    ) {

      alertHtml =

        '<div class="card warning">' +

        '<div class="muted">' +
        '⚠️ REVISIÓN DE VALOR' +
        '</div>' +

        '<div class="big">' +

        esc(
          d.valueAlert.label
        ) +

        '</div>' +

        '<div>' +

        'Cuota ' +

        safeNumber(
          d.valueAlert.odds
        ) +

        ' · EV ' +

        (
          Number(
            d.valueAlert.evPct
          ) >= 0
            ? '+'
            : ''
        ) +

        safeNumber(
          d.valueAlert.evPct,
          1
        ) +

        '%' +

        '</div>' +

        '<div class="help">' +

        esc(
          d.valueAlert.explanation
        ) +

        '</div>' +

        '</div>';

    }

    /*
    -----------------------------------------------
    EXPLICACIÓN
    -----------------------------------------------
    */

    const explainHtml =

      '<div class="section-head">' +

      '<div class="section-title">' +
      '📚 Cómo leer el análisis' +
      '</div>' +

      '</div>' +

      '<div class="explain">' +

      '<strong>BET / NO BET</strong>' +

      '<div class="help">' +

      'BET significa que el mercado seleccionado superó los filtros mínimos de V7.6.1. NO BET significa que no hay condiciones estadísticas suficientes.' +

      '</div>' +

      '</div>' +

      '<div class="explain">' +

      '<strong>EV · Valor esperado</strong>' +

      '<div class="help">' +

      'Compara la probabilidad estimada por el modelo con el precio disponible. Un EV positivo no garantiza ganar.' +

      '</div>' +

      '</div>' +

      '<div class="explain">' +

      '<strong>xG · Goles esperados</strong>' +

      '<div class="help">' +

      'Es una estimación de la producción de gol esperada de cada equipo.' +

      '</div>' +

      '</div>' +

      '<div class="explain">' +

      '<strong>BTTS</strong>' +

      '<div class="help">' +

      'Probabilidad de que ambos equipos marquen. Se calcula estadísticamente; no se solicita como mercado a The Odds API.' +

      '</div>' +

      '</div>';

    /*
    -----------------------------------------------
    RENDER
    -----------------------------------------------
    */

    box.innerHTML =

      '<div class="section-head">' +

      '<div class="section-title">' +

      '🧠 ANALYST ' +

      '<span class="pill">' +

      esc(
        d.modelVersion
      ) +

      '</span>' +

      '</div>' +

      '</div>' +

      decisionHtml +

      scoreHtml +

      '<div class="section-head">' +

      '<div class="section-title">' +
      '📊 Probabilidades' +
      '</div>' +

      '</div>' +

      outcomesHtml +

      xgHtml +

      confidenceHtml +

      strengthHtml +

      '<div class="section-head">' +

      '<div class="section-title">' +
      '💰 Cuotas reales' +
      '</div>' +

      '<div class="section-tag">' +

      (
        d.oddsAvailable
          ? 'DISPONIBLES'
          : 'NO DISPONIBLES'
      ) +

      '</div>' +

      '</div>' +

      oddsHtml +

      bestHtml +

      alertHtml +

      explainHtml;

  } catch (e) {

    box.innerHTML =
      '<div class="card error">' +
      esc(
        e.message
      ) +
      '</div>';

  }
}

/*
====================================================
INICIO
====================================================
*/

loadFixtures();

</script>

</body>

</html>`;

/*
====================================================
HOME
====================================================
*/

app.get(
  '/',
  (req, res) => {

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
      .send(html);
  }
);

/*
====================================================
SERVIDOR
====================================================
*/

app.listen(
  PORT,
  () => {

    console.log(
      `Mi Pronóstico Deportivo ${MODEL_VERSION} ` +
      `escuchando en puerto ${PORT}`
    );

  }
);
