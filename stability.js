/*
====================================================
MI PRONÓSTICO DEPORTIVO — ESTABILIDAD V7.4.1
====================================================
Protección contra límites 429 de Football-Data.org.
No modifica engine.js ni afecta The Odds API.
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

function cacheKey(url) {
  return String(url);
}

function getCached(url) {
  const item = responseCache.get(cacheKey(url));

  if (!item) return null;

  if (Date.now() - item.time > CACHE_MS) {
    responseCache.delete(cacheKey(url));
    return null;
  }

  return item;
}

function getRetrySeconds(responseText, response) {
  const retryAfter =
    response?.headers?.get?.('retry-after');

  if (retryAfter) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds)) {
      return Math.max(1, seconds);
    }
  }

  const match =
    String(responseText || '').match(
      /wait\s+(\d+)\s+seconds?/i
    );

  if (match) {
    return Math.max(1, Number(match[1]));
  }

  return 10;
}

async function waitForSlot() {
  const now = Date.now();
  const wait =
    MIN_GAP_MS -
    (now - lastFootballRequest);

  if (wait > 0) {
    await sleep(wait);
  }

  lastFootballRequest = Date.now();
}

async function protectedFootballFetch(
  url,
  options
) {
  const key = cacheKey(url);

  const blocked = blockedUntil.get(key);

  if (blocked && blocked > Date.now()) {
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

  const cached = getCached(url);

  if (cached) {
    return new Response(
      cached.text,
      {
        status: cached.status,
        headers: cached.headers
      }
    );
  }

  await waitForSlot();

  let response =
    await originalFetch(
      url,
      options
    );

  if (response.status === 403) {
    blockedUntil.set(
      key,
      Date.now() + FORBIDDEN_MS
    );

    return response;
  }

  if (response.status === 429) {
    const text =
      await response.clone().text();

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
      seconds * 1000 + 500
    );

    await waitForSlot();

    response =
      await originalFetch(
        url,
        options
      );
  }

  if (response.ok) {
    const text =
      await response.clone().text();

    responseCache.set(
      key,
      {
        time: Date.now(),
        text,
        status: response.status,
        headers: [
          ...response.headers.entries()
        ]
      }
    );
  }

  return response;
}

global.fetch = function(
  url,
  options = {}
) {
  if (!isFootballData(url)) {
    return originalFetch(
      url,
      options
    );
  }

  const run =
    queue.then(() =>
      protectedFootballFetch(
        url,
        options
      )
    );

  queue =
    run.catch(() => {});

  return run;
};

console.log(
  'Mi Pronóstico Deportivo V7.4.1 — protección de APIs activa'
);

require('./server.js');
