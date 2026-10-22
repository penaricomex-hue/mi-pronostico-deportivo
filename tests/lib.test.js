import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../server/lib/csv.js';
import { createRateLimiter } from '../server/lib/rateLimiter.js';
import { createStore } from '../server/lib/store.js';

test('parseCsv con comillas, comas y BOM', () => {
  const rows = parseCsv('\uFEFFDate,HomeTeam,AwayTeam\n12/08/2022,"Osasuna, CA",Sevilla\n');
  assert.deepEqual(rows, [{ Date: '12/08/2022', HomeTeam: 'Osasuna, CA', AwayTeam: 'Sevilla' }]);
});

test('el limitador nunca supera N llamadas por ventana', async () => {
  let t = 0;
  const waits = [];
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => t, wait: async ms => { waits.push(ms); t += ms; } });
  const calls = [];
  await Promise.all(Array.from({ length: 7 }, (_, i) => limiter.schedule(async () => calls.push({ i, t }))));
  assert.equal(calls.length, 7);
  for (const c of calls) {
    const inWindow = calls.filter(x => x.t <= c.t && c.t - x.t < 1000).length;
    assert.ok(inWindow <= 3, `ventana con ${inWindow} llamadas`);
  }
  limiter.pause(5000);
  assert.ok(limiter.stats().blockedForMs > 0);
});

test('disableDb apaga la persistencia aunque el pool siga existiendo', () => {
  const store = createStore({ pool: { query() { throw new Error('no'); } }, logger: { warn() {} } });
  assert.equal(store.persistent, true);
  store.disableDb();
  assert.equal(store.persistent, false);
});

test('store.remember cachea y respeta la caducidad', async () => {
  let t = 0;
  const store = createStore({ now: () => t, logger: { warn() {} } });
  let n = 0;
  const load = async () => ++n;
  assert.equal(await store.remember('k', 10, load), 1);
  assert.equal(await store.remember('k', 10, load), 1);
  t += 11000;
  assert.equal(await store.remember('k', 10, load), 2);
});
