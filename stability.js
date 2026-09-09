/*
====================================================
MI PRONÓSTICO DEPORTIVO — ESTABILIDAD V7.5
====================================================
Protección contra límites 429 de Football-Data.org,
corrección del rango de fechas y capa analítica V7.5.

V7.5 añade:
- cuota justa
- edge modelo/cuota
- índice de valor
- nivel de riesgo
- mejor señal
- marcador más probable
- doble oportunidad estadística
- señal NO BET

No modifica engine.js.
No modifica las API keys.
====================================================
*/

const originalFetch = global.fetch;

const FOOTBALL_DATA_BASE =
  'https://api.football-data.org/v4';

const CACHE_MS = 5 * 60 * 1000;
const FORBIDDEN_MS = 6 * 60 * 60 * 1000;
const MIN_GAP_MS = 1200;

const responseCache = new Map();
const blockedUntil = new Map();

let lastFootballRequest = 0;
let queue = Promise.resolve();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isFootballData(url) {
  return String(url).startsWith(FOOTBALL_DATA_BASE);
}

/*
====================================================
CORRECCIÓN DE FECHAS
====================================================
*/

function fixFixtureDateRange(url) {
  const value = String(url);

  if (
    !value.includes('/competitions/') ||
    !value.includes('/matches?') ||
    !value.includes('dateFrom=') ||
    !value.includes('dateTo=')
  ) {
    return value;
  }

  const fromMatch =
    value.match(/dateFrom=(\d{4}-\d{2}-\d{2})/);

  const toMatch =
    value.match(/dateTo=(\d{4}-\d{2}-\d{2})/);

  if (!fromMatch || !toMatch) {
    return value;
  }

  const fromDate = fromMatch[1];
  const toDate = toMatch[1];

  if (fromDate !== toDate) {
    return value;
  }

  const nextDay =
    new Date(`${fromDate}T12:00:00Z`);

  nextDay.setUTCDate(
    nextDay.getUTCDate() + 1
  );

  const nextDate =
    nextDay.toISOString().slice(0, 10);

  console.log(
    `Football-Data fecha corregida: ${fromDate} → ${nextDate}`
  );

  return value.replace(
    `dateTo=${toDate}`,
    `dateTo=${nextDate}`
  );
}

/*
====================================================
CACHE
====================================================
*/

function cacheKey(url) {
  return String(url);
}

function getCached(url) {
  const item =
    responseCache.get(
      cacheKey(url)
    );

  if (!item) {
    return null;
  }

  if (
    Date.now() - item.time >
    CACHE_MS
  ) {
    responseCache.delete(
      cacheKey(url)
    );

    return null;
  }

  return item;
}

/*
====================================================
RETRY 429
====================================================
*/

function getRetrySeconds(
  responseText,
  response
) {
  const retryAfter =
    response?.headers?.get?.(
      'retry-after'
    );

  if (retryAfter) {
    const seconds =
      Number(retryAfter);

    if (
      Number.isFinite(seconds)
    ) {
      return Math.max(
        1,
        seconds
      );
    }
  }

  const match =
    String(
      responseText || ''
    ).match(
      /wait\s+(\d+)\s+seconds?/i
    );

  if (match) {
    return Math.max(
      1,
      Number(match[1])
    );
  }

  return 10;
}

async function waitForSlot() {
  const wait =
    MIN_GAP_MS -
    (
      Date.now() -
      lastFootballRequest
    );

  if (wait > 0) {
    await sleep(wait);
  }

  lastFootballRequest =
    Date.now();
}

/*
====================================================
FETCH PROTEGIDO
====================================================
*/

async function protectedFootballFetch(
  url,
  options
) {
  const fixedUrl =
    fixFixtureDateRange(url);

  const key =
    cacheKey(fixedUrl);

  const blocked =
    blockedUntil.get(key);

  if (
    blocked &&
    blocked > Date.now()
  ) {
    const error =
      new Error(
        'Football-Data temporalmente limitado'
      );

    error.status = 429;

    throw error;
  }

  if (blocked) {
    blockedUntil.delete(key);
  }

  const cached =
    getCached(fixedUrl);

  if (cached) {
    return new Response(
      cached.text,
      {
        status:
          cached.status,

        headers:
          cached.headers
      }
    );
  }

  await waitForSlot();

  let response =
    await originalFetch(
      fixedUrl,
      options
    );

  if (
    response.status ===
    403
  ) {
    blockedUntil.set(
      key,
      Date.now() +
      FORBIDDEN_MS
    );

    return response;
  }

  if (
    response.status ===
    429
  ) {
    const text =
      await response
        .clone()
        .text();

    const seconds =
      getRetrySeconds(
        text,
        response
      );

    console.log(
      `Football-Data 429. Esperando ${seconds}s...`
    );

    blockedUntil.set(
      key,
      Date.now() +
      seconds * 1000
    );

    await sleep(
      seconds * 1000 +
      500
    );

    await waitForSlot();

    response =
      await originalFetch(
        fixedUrl,
        options
      );
  }

  if (response.ok) {
    const text =
      await response
        .clone()
        .text();

    responseCache.set(
      key,
      {
        time:
          Date.now(),

        text,

        status:
          response.status,

        headers: [
          ...response.headers.entries()
        ]
      }
    );
  }

  return response;
}

/*
====================================================
INTERCEPTOR FOOTBALL-DATA
====================================================
*/

global.fetch =
  function(
    url,
    options = {}
  ) {
    if (
      !isFootballData(url)
    ) {
      return originalFetch(
        url,
        options
      );
    }

    const run =
      queue.then(
        () =>
          protectedFootballFetch(
            url,
            options
          )
      );

    queue =
      run.catch(
        () => {}
      );

    return run;
  };

/*
====================================================
V7.5 — CAPA ANALÍTICA
====================================================
*/

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    max,
    Math.max(
      min,
      value
    )
  );
}

function round(
  value,
  decimals = 1
) {
  const p =
    10 ** decimals;

  return Math.round(
    value * p
  ) / p;
}

/*
====================================================
CUOTA JUSTA
====================================================
*/

function fairOdds(
  probability
) {
  return probability > 0
    ? round(
        1 / probability,
        2
      )
    : null;
}

/*
====================================================
POISSON
====================================================
*/

function poisson(
  lambda,
  k
) {
  if (
    !Number.isFinite(lambda) ||
    lambda <= 0
  ) {
    return 0;
  }

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

/*
====================================================
MARCADOR MÁS PROBABLE
====================================================
*/

function mostLikelyScore(
  homeXg,
  awayXg
) {
  let best = null;

  for (
    let h = 0;
    h <= 7;
    h++
  ) {
    for (
      let a = 0;
      a <= 7;
      a++
    ) {
      const probability =
        poisson(
          homeXg,
          h
        ) *
        poisson(
          awayXg,
          a
        );

      if (
        !best ||
        probability >
          best.probability
      ) {
        best = {
          home: h,
          away: a,
          probability
        };
      }
    }
  }

  if (!best) {
    return null;
  }

  return {
    score:
      `${best.home}-${best.away}`,

    probabilityPct:
      round(
        best.probability * 100,
        1
      )
  };
}

/*
====================================================
NIVEL DE RIESGO
====================================================
*/

function riskLevel(
  market,
  sampleSize
) {
  const probability =
    Number(
      market.probability
    );

  const bookmakers =
    Number(
      market.bookmakerCount || 0
    );

  const outlier =
    Boolean(
      market.isOutlier
    );

  let risk = 55;

  if (
    probability >= 0.70
  ) {
    risk -= 18;
  }

  else if (
    probability >= 0.60
  ) {
    risk -= 10;
  }

  else if (
    probability < 0.50
  ) {
    risk += 15;
  }

  if (
    bookmakers >= 4
  ) {
    risk -= 8;
  }

  else if (
    bookmakers >= 2
  ) {
    risk -= 4;
  }

  else if (
    bookmakers === 0
  ) {
    risk += 10;
  }

  if (
    sampleSize < 5
  ) {
    risk += 12;
  }

  else if (
    sampleSize < 8
  ) {
    risk += 5;
  }

  if (outlier) {
    risk += 18;
  }

  if (
    Number(
      market.evPct
    ) < 0
  ) {
    risk += 12;
  }

  risk =
    clamp(
      Math.round(risk),
      1,
      99
    );

  if (
    risk >= 70
  ) {
    return 'Alto';
  }

  if (
    risk >= 45
  ) {
    return 'Medio';
  }

  return 'Bajo';
}

/*
====================================================
ENRIQUECER ANÁLISIS
====================================================
*/

function enhanceAnalysis(
  body
) {
  if (
    !body ||
    !body.ok ||
    !Array.isArray(
      body.markets
    )
  ) {
    return body;
  }

  const sampleSize =
    Math.min(
      Number(
        body.strength?.home?.sample ||
        0
      ),
      Number(
        body.strength?.away?.sample ||
        0
      )
    );

  const markets =
    body.markets.map(
      market => {

        const probability =
          Number(
            market.probability
          );

        const probabilityPct =
          Number(
            market.probabilityPct
          );

        const impliedPct =
          Number(
            market.impliedPct
          );

        const edgePct =
          Number.isFinite(
            probabilityPct
          ) &&
          Number.isFinite(
            impliedPct
          )
            ? round(
                probabilityPct -
                impliedPct,
                1
              )
            : null;

        const fair =
          Number.isFinite(
            probability
          )
            ? fairOdds(
                probability
              )
            : null;

        const valueIndex =
          Number.isFinite(
            probabilityPct
          ) &&
          Number.isFinite(
            impliedPct
          )
            ? clamp(
                Math.round(
                  50 +
                  edgePct * 2
                ),
                0,
                100
              )
            : null;

        return {
          ...market,

          fairOdds:
            fair,

          edgePct,

          valueIndex,

          risk:
            riskLevel(
              market,
              sampleSize
            ),

          signal:
            Number.isFinite(
              edgePct
            ) &&
            edgePct >= 5
              ? 'VALOR'
              :
              Number.isFinite(
                edgePct
              ) &&
              edgePct >= 0
                ? 'LEVE'
                : 'SIN VENTAJA'
        };
      }
    );

  /*
  ==================================================
  MEJOR CANDIDATO
  ==================================================
  */

  const eligible =
    markets
      .filter(
        market =>
          Number.isFinite(
            Number(
              market.odds
            )
          ) &&
          Number(
            market.odds
          ) > 1 &&
          Number.isFinite(
            Number(
              market.probabilityPct
            )
          ) &&
          Number(
            market.probabilityPct
          ) >= 50
      )
      .sort(
        (
          a,
          b
        ) => {

          const av =
            Number(
              a.evPct
            );

          const bv =
            Number(
              b.evPct
            );

          return (
            Number.isFinite(bv)
              ? bv
              : -999
          ) -
          (
            Number.isFinite(av)
              ? av
              : -999
          );
        }
      );

  const bestCandidate =
    eligible[0] ||
    null;

  /*
  ==================================================
  SEÑAL PRINCIPAL
  ==================================================
  */

  const bestBet =
    bestCandidate &&
    Number(
      bestCandidate.evPct
    ) > 0

      ? {
          key:
            bestCandidate.key,

          label:
            bestCandidate.label,

          probabilityPct:
            bestCandidate.probabilityPct,

          odds:
            bestCandidate.odds,

          fairOdds:
            bestCandidate.fairOdds,

          evPct:
            bestCandidate.evPct,

          edgePct:
            bestCandidate.edgePct,

          valueIndex:
            bestCandidate.valueIndex,

          risk:
            bestCandidate.risk,

          bookmaker:
            bestCandidate.bookmaker ||
            null,

          bookmakerCount:
            bestCandidate.bookmakerCount ||
            0,

          action:
            'SEÑAL DE VALOR'
        }

      : {
          action:
            'NO BET',

          reason:
            body.oddsAvailable

              ? 'No se encontró una ventaja estadística suficiente con las cuotas disponibles.'

              : 'No hay cuotas disponibles para validar valor.'
        };

  /*
  ==================================================
  DOBLE OPORTUNIDAD
  ==================================================
  */

  const model =
    body.model ||
    {};

  const doubleChance = {

    '1X':
      round(
        (
          Number(
            model.homeWin ||
            0
          ) +
          Number(
            model.draw ||
            0
          )
        ) * 100,
        1
      ),

    'X2':
      round(
        (
          Number(
            model.draw ||
            0
          ) +
          Number(
            model.awayWin ||
            0
          )
        ) * 100,
        1
      ),

    '12':
      round(
        (
          Number(
            model.homeWin ||
            0
          ) +
          Number(
            model.awayWin ||
            0
          )
        ) * 100,
        1
      )
  };

  /*
  ==================================================
  TOP SEÑALES
  ==================================================
  */

  const topMarkets =
    markets
      .slice()
      .sort(
        (
          a,
          b
        ) =>
          Number(
            b.probabilityPct ||
            0
          ) -
          Number(
            a.probabilityPct ||
            0
          )
      )
      .slice(
        0,
        3
      )
      .map(
        market => ({
          key:
            market.key,

          label:
            market.label,

          probabilityPct:
            market.probabilityPct,

          odds:
            market.odds ||
            null,

          evPct:
            market.evPct,

          edgePct:
            market.edgePct,

          risk:
            market.risk
        })
      );

  /*
  ==================================================
  EDGE PROMEDIO
  ==================================================
  */

  const edges =
    markets
      .map(
        market =>
          Number(
            market.edgePct
          )
      )
      .filter(
        Number.isFinite
      );

  const averageEdge =
    edges.length
      ? round(
          edges.reduce(
            (
              a,
              b
            ) =>
              a + b,
            0
          ) /
          edges.length,
          1
        )
      : null;

  /*
  ==================================================
  RESPUESTA V7.5
  ==================================================
  */

  return {

    ...body,

    modelVersion:
      'V7.5',

    markets,

    bestValue:
      body.bestValue
        ? {
            ...body.bestValue,

            fairOdds:
              fairOdds(
                Number(
                  body.bestValue
                    .probability
                )
              ),

            edgePct:
              Number.isFinite(
                Number(
                  body.bestValue
                    .probabilityPct
                )
              ) &&
              Number.isFinite(
                Number(
                  body.bestValue
                    .impliedPct
                )
              )
                ? round(
                    Number(
                      body.bestValue
                        .probabilityPct
                    ) -
