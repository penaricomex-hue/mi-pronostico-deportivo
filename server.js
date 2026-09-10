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
  const item =
    cache.get(key);

  if (
    !item ||
    Date.now() - item.time >
      CACHE_TTL_MS
  ) {
    return null;
  }

  return item.value;
}

function cacheSet(
  key,
  value
) {
  cache.set(
    key,
    {
      time: Date.now(),
      value
    }
  );

  return value;
}

/*
====================================================
FETCH JSON
====================================================
*/

async function fetchJson(
  url,
  options = {}
) {
  const response =
    await fetch(
      url,
      options
    );

  const text =
    await response.text();

  let data;

  try {
    data =
      JSON.parse(text);
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

async function footballData(
  path
) {
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

function weightedAverage(
  values
) {
  const valid =
    values
      .filter(v =>
        Number.isFinite(
          Number(v)
        )
      )
      .map(Number);

  if (!valid.length) {
    return null;
  }

  const weights =
    valid.map(
      (_, i) => i + 1
    );

  const totalWeight =
    weights.reduce(
      (a, b) => a + b,
      0
    );

  return valid.reduce(
    (sum, value, i) =>
      sum +
      value *
      weights[i],
    0
  ) / totalWeight;
}

function normalizeName(
  name
) {
  return String(
    name || ''
  )
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

function namesMatch(
  a,
  b
) {
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

function median(
  values
) {
  const sorted =
    values
      .filter(
        Number.isFinite
      )
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
          m.score?.fullTime?.home !=
            null &&
          m.score?.fullTime?.away !=
            null
      )
      .filter(
        m =>
          m.homeTeam?.id ===
            teamId ||
          m.awayTeam?.id ===
            teamId
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
      m.homeTeam.id ===
      teamId;

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
    matches:
      finished,

    gf:
      gf /
      finished.length,

    ga:
      ga /
      finished.length,

    homeGF:
      homeCount
        ? homeGF /
          homeCount
        : null,

    homeGA:
      homeCount
        ? homeGA /
          homeCount
        : null,

    awayGF:
      awayCount
        ? awayGF /
          awayCount
        : null,

    awayGA:
      awayCount
        ? awayGA /
          awayCount
        : null,

    form:
      form /
      finished.length
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

async function getFixtures(
  date
) {
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
    const code of
    competitions
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

V7.4

No solicitamos BTTS desde el endpoint general.

BTTS continúa calculándose
estadísticamente mediante el modelo.

Además guardamos todas las cuotas
para poder detectar precios atípicos.
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
          !Number.isFinite(
            price
          ) ||
          price <= 1
        ) {
          continue;
        }

        if (
          market.key ===
          'h2h'
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
          market.key ===
            'totals' &&
          Number(
            outcome.point
          ) === 2.5
        ) {
          const name =
            String(
              outcome.name ||
              ''
            ).toLowerCase();

          if (
            name === 'over'
          ) {
            prices.over25.push({
              price,
              bookmaker:
                bookmaker.title
            });
          }

          else if (
            name === 'under'
          ) {
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
    ] of Object.entries(
      prices
    )
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
            x =>
              x.bookmaker
          )
        ).size,

      medianOdds:
        median(
          list.map(
            x =>
              x.price
          )
        ),

      prices:
        list
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

      label:
        'Gana el local',

      shortLabel:
        '1',

      probability:
        model.homeWin,

      odds:
        odds?.home?.price,

      bookmaker:
        odds?.home?.bookmaker,

      bookmakerCount:
        odds?.home?.bookmakerCount,

      medianOdds:
        odds?.home?.medianOdds
    },

    {
      key: 'draw',

      label:
        'Empate',

      shortLabel:
        'X',

      probability:
        model.draw,

      odds:
        odds?.draw?.price,

      bookmaker:
        odds?.draw?.bookmaker,

      bookmakerCount:
        odds?.draw?.bookmakerCount,

      medianOdds:
        odds?.draw?.medianOdds
    },

    {
      key: 'away',

      label:
        'Gana el visitante',

      shortLabel:
        '2',

      probability:
        model.awayWin,

      odds:
        odds?.away?.price,

      bookmaker:
        odds?.away?.bookmaker,

      bookmakerCount:
        odds?.away?.bookmakerCount,

      medianOdds:
        odds?.away?.medianOdds
    },

    {
      key: 'over25',

      label:
        'Más de 2.5 goles',

      shortLabel:
        'Over 2.5',

      probability:
        model.over25,

      odds:
        odds?.over25?.price,

      bookmaker:
        odds?.over25?.bookmaker,

      bookmakerCount:
        odds?.over25?.bookmakerCount,

      medianOdds:
        odds?.over25?.medianOdds
    },

    {
      key: 'under25',

      label:
        'Menos de 2.5 goles',

      shortLabel:
        'Under 2.5',

      probability:
        model.under25,

      odds:
        odds?.under25?.price,

      bookmaker:
        odds?.under25?.bookmaker,

      bookmakerCount:
        odds?.under25?.bookmakerCount,

      medianOdds:
        odds?.under25?.medianOdds
    }
  ];

  return raw.map(
    market => {

      const hasOdds =
        Number.isFinite(
          Number(
            market.odds
          )
        ) &&
        Number(
          market.odds
        ) > 1;

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

      /*
      ----------------------------------------------
      DETECTOR DE CUOTA ATÍPICA
      ----------------------------------------------
      */

      const isOutlier =
        hasOdds &&
        Number.isFinite(
          medianOdds
        ) &&
        market.bookmakerCount >= 2 &&
        market.odds >
          medianOdds * 1.35;

      /*
      ----------------------------------------------
      NIVEL DE VALOR
      ----------------------------------------------
      */

      let valueLevel =
        'Sin valor';

      if (
        Number.isFinite(
          evPct
        )
      ) {
        if (
          evPct >= 20
        ) {
          valueLevel =
            'Valor extremo';
        }

        else if (
          evPct >= 10
        ) {
          valueLevel =
            'Valor fuerte';
        }

        else if (
          evPct > 0
        ) {
          valueLevel =
            'Valor leve';
        }
      }

      /*
      Una cuota demasiado alejada
      de las demás casas se marca
      como precio atípico.
      */

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
    }
  );
}

/*
====================================================
MEJOR OPORTUNIDAD
====================================================

V7.4 NO considera automáticamente
una cuota extrema como recomendación.

Para considerar un valor extremo
como candidato debe existir respaldo
de al menos dos casas.
====================================================
*/function bestValue(markets) {
  const valid =
    (markets || [])
      .filter(market =>
        Number.isFinite(
          Number(market.evPct)
        ) &&
        Number(market.evPct) > 0 &&
        Number.isFinite(
          Number(market.probabilityPct)
        ) &&
        Number(market.probabilityPct) >= 55
      );

  if (!valid.length) {
    return null;
  }

  return valid
    .sort((a, b) => {
      const evDiff =
        Number(b.evPct) -
        Number(a.evPct);

      if (Math.abs(evDiff) > 1) {
        return evDiff;
      }

      return (
        Number(b.probabilityPct) -
        Number(a.probabilityPct)
      );
    })[0] || null;
}

/*
====================================================
NIVEL DE CONFIANZA
====================================================
*/

function confidenceLevel(
  value
) {
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

  if (
    n >= 80
  ) {
    return {
      label:
        'Alta',

      text:
        'Los datos disponibles son relativamente sólidos para este análisis.'
    };
  }

  if (
    n >= 60
  ) {
    return {
      label:
        'Media',

      text:
        'Hay una base razonable de datos, aunque todavía existe incertidumbre.'
    };
  }

  return {
    label:
      'Baja',

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
      'La cuota es mucho más alta que la referencia de otras casas. Puede ser una oportunidad real, pero primero hay que confirmar que el precio, el mercado y el partido sean correctos.'
    );
  }

  if (
    market.valueLevel ===
    'Valor extremo'
  ) {
    return (
      'El modelo detecta una diferencia extraordinariamente grande entre su probabilidad y la cuota. Conviene revisar el mercado antes de considerar cualquier apuesta.'
    );
  }

  if (
    market.valueLevel ===
    'Valor fuerte'
  ) {
    return (
      'La cuota parece pagar más de lo que el modelo estima que debería pagar. Es una señal estadística interesante, no una garantía.'
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
  (
    req,
    res
  ) => {

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
        CACHE_TTL_MS /
        60000,

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
  async (
    req,
    res
  ) => {

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
  async (
    req,
    res
  ) => {

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
          x =>
            x != null
        )) ??
        1.35;

      const homeDefense =
        weightedAverage([
          homeStats.homeGA,
          homeStats.ga,
          homeStats.ga
        ].filter(
          x =>
            x != null
        )) ??
        1.20;

      const awayAttack =
        weightedAverage([
          awayStats.awayGF,
          awayStats.gf,
          awayStats.gf
        ].filter(
          x =>
            x != null
        )) ??
        1.35;

      const awayDefense =
        weightedAverage([
          awayStats.awayGA,
          awayStats.ga,
          awayStats.ga
        ].filter(
          x =>
            x != null
        )) ??
        1.20;

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
          homeAttack *
          0.60
        ) +
        (
          awayDefense *
          0.40
        );

      let awayXg =
        (
          awayAttack *
          0.60
        ) +
        (
          homeDefense *
          0.40
        );

      homeXg *=
        1.08;

      awayXg *=
        0.94;

      if (
        homeForm != null
      ) {
        homeXg *=
          0.94 +
          (
            homeForm *
            0.12
          );
      }

      if (
        awayForm != null
      ) {
        awayXg *=
          0.94 +
          (
            awayForm *
            0.12
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
        best?.evPct
          ? best.evPct / 100
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
      VALOR EXTREMO / ATÍPICO
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
              .map(
                m => {

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

                }
              ),

          away:
            aa.matches
              .slice(0, 5)
              .map(
                m => {

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

                }
              )

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
        error.status ===
          404
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
INTERFAZ WEB V7.4
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
  content="#07110d"
>

<title>
Mi Pronóstico Deportivo
</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #07110d;
  color: #eef7f1;
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
  max-width: 900px;
  margin: auto;
  padding:
    18px
    16px
    90px;
}

.top {
  display: flex;
  justify-content:
    space-between;
  align-items:
    center;
  gap: 12px;
}

.brand {
  font-size: 21px;
  font-weight: 800;
}

.status {
  font-size: 12px;
  color: #63e6a2;
}

.hero {
  margin-top: 18px;
  padding: 22px;
  border:
    1px solid
    #18372a;
  border-radius: 20px;

  background:
    linear-gradient(
      145deg,
      #0b1c14,
      #0b1511
    );
}

.eyebrow {
  font-size: 12px;
  color: #63e6a2;
  text-transform:
    uppercase;
  letter-spacing:
    1.2px;
}

.hero h1 {
  font-size: 30px;
  line-height: 1.05;
  margin: 8px 0;
}

.hero p {
  color: #aabdb2;
  margin: 0;
}

.controls {
  display: flex;
  gap: 8px;
  margin: 14px 0;
}

.controls input {
  flex: 1;
  min-width: 0;

  background:
    #0d1b15;

  border:
    1px solid
    #244637;

  color: white;

  border-radius:
    12px;

  padding:
    12px;
}

.controls button {
  border: 0;

  background:
    #63e6a2;

  color:
    #062015;

  font-weight:
    800;

  border-radius:
    12px;

  padding:
    12px 16px;
}

.card {
  background:
    #0b1913;

  border:
    1px solid
    #1b392c;

  border-radius:
    18px;

  padding:
    16px;

  margin-top:
    12px;
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
    800;
}

.teams div {
  padding:
    4px 0;
}

.muted {
  color:
    #8ea49a;

  font-size:
    12px;
}

.analyze {
  margin-top:
    12px;

  width:
    100%;

  background:
    #13261d;

  color:
    #dff8e9;

  border:
    1px solid
    #2a4e3c;

  border-radius:
    11px;

  padding:
    11px;

  font-weight:
    700;
}

.grid {
  display:
    grid;

  grid-template-columns:
    repeat(3, 1fr);

  gap:
    9px;

  margin-top:
    12px;
}

.stat {
  background:
    #0e2118;

  border-radius:
    13px;

  padding:
    12px;
}

.stat b {
  display:
    block;

  font-size:
    20px;

  margin-top:
    4px;
}

.pill {
  display:
    inline-block;

  padding:
    5px 8px;

  border-radius:
    99px;

  background:
    #132b20;

  color:
    #7bf0aa;

  font-size:
    11px;

  font-weight:
    700;
}

.section-title {
  margin:
    20px 0 8px;

  font-size:
    15px;

  font-weight:
    800;
}

.positive {
  border-color:
    #63e6a2;
}

.warning {
  border-color:
    #d5a84b;
}

.danger {
  border-color:
    #b96a6a;
}

.help {
  color:
    #aabdb2;

  font-size:
    13px;

  line-height:
    1.45;

  margin-top:
    7px;
}

.big {
  font-size:
    22px;

  font-weight:
    800;

  margin:
    4px 0;
}

.error {
  color:
    #ff9f9f;
}

.loading {
  color:
    #9db4a8;

  padding:
    18px;

  text-align:
    center;
}

.small {
  font-size:
    11px;

  color:
    #6f887b;

  margin-top:
    18px;

  line-height:
    1.5;
}

.explain {
  background:
    #0e2118;

  border:
    1px solid
    #244637;

  border-radius:
    14px;

  padding:
    13px;

  margin-top:
    10px;
}

.explain strong {
  color:
    #dff8e9;
}

.nav {
  position:
    fixed;

  left:
    0;

  right:
    0;

  bottom:
    0;

  background:
    #08140fdd;

  border-top:
    1px solid
    #18372a;

  backdrop-filter:
    blur(10px);

  display:
    flex;

  justify-content:
    center;

  gap:
    50px;

  padding:
    13px;
}

.nav span {
  font-size:
    12px;

  color:
    #93a99f;
}

@media (
  max-width: 600px
) {

  .hero h1 {
    font-size:
      27px;
  }

  .grid {
    grid-template-columns:
      repeat(2, 1fr);
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

<div class="status">
● V7.4
</div>

</div>

<section class="hero">

<div class="eyebrow">
Analítica deportiva
</div>

<h1>
Entiende el partido antes de decidir.
</h1>

<p>
Probabilidades, goles esperados,
forma reciente y cuotas explicadas
en lenguaje sencillo.
</p>

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

<div id="app">

<div class="loading">
Cargando partidos...
</div>

</div>

<div class="small">

Las probabilidades son
estimaciones estadísticas.

El valor detectado tampoco
significa que un resultado
esté garantizado.

</div>

</main>

<nav class="nav">

<span>Inicio</span>

<span>Partidos</span>

<span>Análisis</span>

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
    : Number(v)
        .toFixed(1) +
      '%';

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
        'No hay partidos disponibles ' +
        'para esta fecha.' +
        '</div>';

      return;

    }

    $('app').innerHTML =
      d.matches
        .map(
          m =>

            '<div class="card">' +

            '<div class="muted">' +

            esc(
              m.competitionName ||
              m.competition?.name ||
              'Competición'
            ) +

            ' · ' +

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
            ) +

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

            '🔎 Analizar partido' +

            '</button>' +

            '<div id="a' +
            m.id +
            '">' +

            '</div>' +

            '</div>'

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
ANALIZAR PARTIDO
====================================================
*/

async function analyze(
  id
) {

  const box =
    $('a' + id);

  box.innerHTML =
    '<div class="loading">' +
    'Analizando forma, fuerza, goles esperados y cuotas...' +
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

    /*
    -----------------------------------------------
    PROBABILIDADES
    -----------------------------------------------
    */

    const outcomes = [

      {
        title:
          '🏠 Gana el local',

        value:
          m.homeWin,

        help:
          'Probabilidad estimada de que gane el equipo local.'
      },

      {
        title:
          '🤝 Empate',

        value:
          m.draw,

        help:
          'Probabilidad estimada de que ambos equipos terminen con el mismo marcador.'
      },

      {
        title:
          '✈️ Gana el visitante',

        value:
          m.awayWin,

        help:
          'Probabilidad estimada de que gane el equipo visitante.'
      },

      {
        title:
          '⚽ Más de 2.5 goles',

        value:
          m.over25,

        help:
          'El modelo considera la posibilidad de que haya 3 goles o más.'
      },

      {
        title:
          '⚽ Menos de 2.5 goles',

        value:
          m.under25,

        help:
          'El modelo considera la posibilidad de que haya 0, 1 o 2 goles.'
      },

      {
        title:
          '🥅 Ambos equipos marcan',

        value:
          m.btts,

        help:
          'Probabilidad estimada de que los dos equipos anoten al menos un gol.'
      }

    ];

    const outcomesHtml =
      outcomes
        .map(
          item =>

            '<div class="stat">' +

            '<span class="muted">' +

            item.title +

            '</span>' +

            '<b>' +

            pct(
              item.value
            ) +

            '</b>' +

            '<div class="help">' +

            item.help +

            '</div>' +

            '</div>'
        )
        .join('');

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

      (
        d.confidenceLevel ||
        'Sin datos suficientes'
      ) +

      '</div>' +

      '<div class="help">' +

      esc(
        d.confidenceExplanation ||
        'La confianza indica la solidez de los datos disponibles.'
      ) +

      '</div>' +

      '<div class="muted">' +

      'Puntuación técnica: ' +

      Number(
        d.confidence
      ).toFixed(0) +

      ' / 100' +

      '</div>' +

      '<div class="help">' +

      '⚠️ Importante: una confianza alta no significa que el resultado esté garantizado.' +

      '</div>' +

      '</div>';

    /*
    -----------------------------------------------
    FUERZA
    -----------------------------------------------
    */

    const strengthHtml =

      '<div class="section-title">' +

      '💪 ¿Cómo llegan los equipos?' +

      '</div>' +

      '<div class="grid">' +

      '<div class="stat">' +

      '<span class="muted">' +

      'Local · ataque' +

      '</span>' +

      '<b>' +

      Number(
        s.home.attack
      ).toFixed(2) +

      '</b>' +

      '<div class="help">' +

      'Forma reciente: ' +

      pct(
        s.home.form *
        100
      ) +

      '</div>' +

      '</div>' +

      '<div class="stat">' +

      '<span class="muted">' +

      'Visitante · ataque' +

      '</span>' +

      '<b>' +

      Number(
        s.away.attack
      ).toFixed(2) +

      '</b>' +

      '<div class="help">' +

      'Forma reciente: ' +

      pct(
        s.away.form *
        100
      ) +

      '</div>' +

      '</div>' +

      '</div>';

    /*
    -----------------------------------------------
    xG
    -----------------------------------------------
    */

    const xgHtml =

      '<div class="section-title">' +

      '⚽ Goles esperados' +

      '</div>' +

      '<div class="grid">' +

      '<div class="stat">' +

      '<span class="muted">' +

      'Local' +

      '</span>' +

      '<b>' +

      d.xG.home +

      '</b>' +

      '<div class="help">' +

      'Cantidad aproximada de goles que el modelo espera del local.' +

      '</div>' +

      '</div>' +

      '<div class="stat">' +

      '<span class="muted">' +

      'Visitante' +

      '</span>' +

      '<b>' +

      d.xG.away +

      '</b>' +

      '<div class="help">' +

      'Cantidad aproximada de goles que el modelo espera del visitante.' +

      '</div>' +

      '</div>' +

      '<div class="stat">' +

      '<span class="muted">' +

      'Total' +

      '</span>' +

      '<b>' +

      d.xG.total +

      '</b>' +

      '<div class="help">' +

      'Estimación combinada de goles del partido.' +

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

    const oddsHtml =
      markets.length

        ? markets
            .map(
              x => {

                const evValue =
                  Number(
                    x.evPct
                  );

                const evText =
                  Number.isFinite(
                    evValue
                  )

                    ? (
                        evValue >= 0
                          ? '+'
                          : ''
                      ) +
                      evValue
                        .toFixed(1) +
                      '%'

                    : '—';

                let valueText =
                  'Sin valor';

                if (
                  x.valueLevel ===
                  'Valor fuerte'
                ) {
                  valueText =
                    '🟢 Buen valor';
                }

                else if (
                  x.valueLevel ===
                  'Valor leve'
                ) {
                  valueText =
                    '🟡 Valor leve';
                }

                else if (
                  x.valueLevel ===
                  'Valor extremo'
                ) {
                  valueText =
                    '🟠 Valor extremo';
                }

                else if (
                  x.valueLevel ===
                  'Precio atípico'
                ) {
                  valueText =
                    '⚠️ Precio atípico';
                }

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

                  '<span class="muted">' +

                  esc(
                    x.label
                  ) +

                  '</span>' +

                  '<b>' +

                  Number(
                    x.odds
                  ).toFixed(2) +

                  '</b>' +

                  '<div class="help">' +

                  'Casa de apuestas: ' +

                  esc(
                    x.bookmaker ||
                    'No indicada'
                  ) +

                  '</div>' +

                  '<div class="muted">' +

                  'Modelo: ' +

                  Number(
                    x.probabilityPct
                  ).toFixed(1) +

                  '%' +

                  ' · Cuota equivalente: ' +

                  (
                    Number.isFinite(
                      Number(
                        x.impliedPct
                      )
                    )

                      ? Number(
                          x.impliedPct
                        ).toFixed(1)

                      : '—'
                  ) +

                  '%' +

                  '</div>' +

                  '<div class="muted">' +

                  valueText +

                  ' · Valor: ' +

                  evText +

                  '</div>' +

                  (
                    x.isOutlier

                      ? '<div class="help">' +

                        '⚠️ Esta cuota está bastante alejada de las demás disponibles. Conviene verificarla antes de tomarla como referencia.' +

                        '</div>'

                      : ''
                  ) +

                  '</div>'

                );

              }
            )
            .join('')

        : '<div class="stat">' +

          '<span class="muted">' +

          'No se recibieron cuotas para este partido.' +

          '</span>' +

          '<div class="help">' +

          'El análisis estadístico puede seguir funcionando aunque no haya cuotas disponibles.' +

          '</div>' +

          '</div>';

    /*
    -----------------------------------------------
    OPORTUNIDAD
    -----------------------------------------------
    */

    let opportunityHtml = '';

    if (
      d.valueAlert &&
      (
        d.valueAlert.valueLevel ===
          'Precio atípico' ||
        d.valueAlert.valueLevel ===
          'Valor extremo'
      )
    ) {

      opportunityHtml =

        '<div class="card warning">' +

        '<div class="muted">' +

        '⚠️ VALOR QUE NECESITA REVISIÓN' +

        '</div>' +

        '<div class="big">' +

        esc(
          d.valueAlert.label
        ) +

        '</div>' +

        '<div>' +

        'Cuota ' +

        '<b>' +

        Number(
          d.valueAlert.odds
        ).toFixed(2) +

        '</b>' +

        ' · EV ' +

        (
          d.valueAlert.evPct >= 0
            ? '+'
            : ''
        ) +

        Number(
          d.valueAlert.evPct
        ).toFixed(1) +

        '%' +

        '</div>' +

        '<div class="help">' +

        esc(
          d.valueAlert.explanation
        ) +

        '</div>' +

        '</div>';

    }

    else if (
      best
    ) {

      opportunityHtml =

        '<div class="card positive">' +

        '<div class="muted">' +

        '⭐ MEJOR OPORTUNIDAD DETECTADA' +

        '</div>' +

        '<div class="big">' +

        esc(
          best.label
        ) +

        '</div>' +

        '<div>' +

        'Cuota ' +

        '<b>' +

        Number(
          best.odds
        ).toFixed(2) +

        '</b>' +

        ' · Valor ' +

        (
          best.evPct >= 0
            ? '+'
            : ''
        ) +

        Number(
          best.evPct
        ).toFixed(1) +

        '%' +

        '</div>' +

        '<div class="help">' +

        'El modelo encuentra una ventaja estadística frente a la cuota disponible. Esto NO significa que el resultado esté garantizado.' +

        '</div>' +

        '</div>';

    }

    else {

      opportunityHtml =

        '<div class="card">' +

        '<div class="muted">' +

        'ℹ️ SIN VENTAJA CLARA' +

        '</div>' +

        '<div class="help">' +

        (
          d.oddsAvailable

            ? 'Se encontraron cuotas, pero el modelo no detecta una ventaja clara después de revisar los precios.'

            : 'No hay cuotas disponibles para comparar en este momento.'
        ) +

        '</div>' +

        '</div>';

    }

    /*
    -----------------------------------------------
    EXPLICACIÓN PARA PRINCIPIANTES
    -----------------------------------------------
    */

    const explainHtml =

      '<div class="section-title">' +

      '📚 ¿Cómo leer este análisis?' +

      '</div>' +

      '<div class="explain">' +

      '<strong>Probabilidad</strong>' +

      '<div class="help">' +

      'Es la posibilidad estimada por el modelo. Por ejemplo, 60% significa aproximadamente 60 posibilidades de cada 100 según los datos analizados.' +

      '</div>' +

      '</div>' +

      '<div class="explain">' +

      '<strong>Cuota</strong>' +

      '<div class="help">' +

      'Es el precio que ofrece la casa de apuestas por un resultado. Una cuota mayor paga más, pero normalmente también representa un resultado menos probable.' +

      '</div>' +

      '</div>' +

      '<div class="explain">' +

      '<strong>Valor</strong>' +

      '<div class="help">' +

      'El valor compara lo que el modelo estima con lo que está pagando la cuota. Tener valor no significa tener una apuesta segura.' +

      '</div>' +

      '</div>' +

      '<div class="explain">' +

      '<strong>Goles esperados (xG)</strong>' +

      '<div class="help">' +

      'Es una estimación estadística de cuántos goles podría generar cada equipo. No significa que ese número vaya a ser exactamente el marcador.' +

      '</div>' +

      '</div>';

    /*
    -----------------------------------------------
    RESULTADO FINAL
    -----------------------------------------------
    */

    box.innerHTML =

      '<div class="section-title">' +

      '📊 Análisis ' +

      '<span class="pill">' +

      esc(
        d.modelVersion
      ) +

      '</span>' +

      '</div>' +

      '<div class="grid">' +

      outcomesHtml +

      '</div>' +

      confidenceHtml +

      xgHtml +

      strengthHtml +

      '<div class="section-title">' +

      '💰 Cuotas disponibles' +

      '</div>' +

      '<div class="grid">' +

      oddsHtml +

      '</div>' +

      '<div class="section-title">' +

      '⭐ ¿Hay alguna oportunidad interesante?' +

      '</div>' +

      opportunityHtml +

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
  (
    req,
    res
  ) => {

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
