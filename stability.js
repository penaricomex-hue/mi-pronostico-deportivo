/*
====================================================
MI PRONÓSTICO DEPORTIVO — ESTABILIDAD V7.4.2
====================================================
Protección contra límites 429 de Football-Data.org
y corrección del rango de fechas de partidos.

No modifica engine.js.
No modifica The Odds API.
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

Football-Data puede interpretar dateTo como límite
del rango. Para consultar correctamente un día,
usamos como dateTo el día siguiente.

Ejemplo:

12 septiembre
dateFrom=2026-09-12
dateTo=2026-09-13
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

  /*
  Solo corregimos cuando la aplicación está
  solicitando un único día.
  */
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

  const fixed =
    value.replace(
      `dateTo=${toDate}`,
      `dateTo=${nextDate}`
    );

  console.log(
    `Football-Data fecha corregida: ${fromDate} → ${nextDate}`
  );

  return fixed;
}

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
      Number.isFinite(
        seconds
      )
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
  const now =
    Date.now();

  const wait =
    MIN_GAP_MS -
    (
      now -
      lastFootballRequest
    );

  if (wait > 0) {
    await sleep(wait);
  }

  lastFootballRequest =
    Date.now();
}

async function protectedFootballFetch(
  url,
  options
) {
  /*
  Primero corregimos la URL.
  */
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

console.log(
  'Mi Pronóstico Deportivo V7.4.2 — protección de APIs y fechas activa'
);

require('./server.js');
