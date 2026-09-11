const express = require('express');

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

const MODEL_VERSION = 'V7.6.6';

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

function namesMatch(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);

  if (
    !x ||
    !y ||
    x.length < 4 ||
    y.length < 4
  ) {
    return false;
  }

  if (x === y) {
    return true;
  }

  if (
    x.length >= 7 &&
    y.length >= 7 &&
    (
      x.includes(y) ||
      y.includes(x)
    )
  ) {
    return true;
  }

  return false;
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

  for (
    const match of relevant
  ) {
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
          relevant.length *
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
      `?regions=us,uk` +
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
  date
) {
  if (!ODDS_API_KEY) {
    console.log(
      '[FIXTURES ODDS] ODDS_API_KEY no configurada'
    );

    return [];
  }

  console.log(
    `[FIXTURES ODDS] buscando ${date}`
  );

  const all = [];

  for (
    const competitionCode of
    COMPETITIONS
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
  date
) {
  const key =
    `fixtures:${date}`;

  const cached =
    cacheGet(key);

  if (cached) {
    console.log(
      `[FIXTURES] cache ${date}: ${cached.length}`
    );

    return cached;
  }

  console.log(
    `[FIXTURES] buscando ${date}`
  );

  let matches =
    await getFixturesFootballData(
      date
    );

  if (!matches.length) {
    console.log(
      `[FIXTURES] Football-Data devolvió 0. Activando fallback Odds API.`
    );

    matches =
      await getFixturesOdds(
        date
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
        ) >= 55 &&
        Number(
          market.referenceEvPct
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

    console.log(
      `[API /api/fixtures] solicitud recibida date=${date}`
    );

    try {
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
       * MODELO
       */
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
Mi Pronóstico Deportivo V7.6.6
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
}

.nav strong{
  color:white;
}

</style>

</head>

<body>

<div class="app">

<header class="header">

<span class="version">
● V7.6.6 ANALYST
</span>

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

(function(){

'use strict';

console.log(
  '[V7.6.6] JavaScript cargado correctamente'
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
    '[V7.6.6] searchFixtures ejecutado'
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
        '&v=766',
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
      '[V7.6.6] fixtures:',
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
      '[V7.6.6] ERROR:',
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

  return \`

    <article class="fixture">

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
        '&v=766',
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
      '[V7.6.6] análisis:',
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
      '[V7.6.6] ANALYZE ERROR:',
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
  market
){

  return \`

    <div class="market">

      <div class="market-top">

        <strong>
          \${esc(
            market.name
          )}
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
        market.isOutlier
          ? \`

            <div class="value-box">

              ⚠️ Precio atípico.

              No se utiliza para Value Pick.

            </div>

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
          marketHtml
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

function initializeApp(){

  console.log(
    '[V7.6.6] inicializando interfaz'
  );

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
      '[V7.6.6] searchBtn no encontrado'
    );

    return;
  }

  searchBtn.addEventListener(
    'click',
    searchFixtures
  );

  document.addEventListener(
    'click',
    event => {

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
      }

    }
  );

  console.log(
    '[V7.6.6] interfaz inicializada correctamente'
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
  () => {

    console.log(
      `V7.6.6 ANALYST running on port ${PORT}`
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

  }
);
