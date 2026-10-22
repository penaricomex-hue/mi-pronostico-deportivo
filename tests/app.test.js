import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';

const fakeDeps = {
  analysis: {}, bets: {}, footballData: { stats: () => ({}) }, odds: { quotaStatus: async () => ({}) },
  ratings: { summary: () => ({ leagues: {} }), getRatings: async () => null, leagueParams: () => ({}) },
  store: { persistent: false }, teams: { unresolved: () => [] }, bankroll: {}
};

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}

test('/health es público y el resto exige credenciales', async () => {
  const app = createApp(fakeDeps, { auth: { username: 'mk', password: 'secreto-largo' } });
  await withServer(app, async base => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const denied = await fetch(`${base}/api/status`);
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get('www-authenticate') || '', /Basic/);
    const wrong = await fetch(`${base}/api/backtest`, { headers: { Authorization: `Basic ${Buffer.from('mk:mal').toString('base64')}` } });
    assert.equal(wrong.status, 401);
    const ok = await fetch(`${base}/api/nope`, { headers: { Authorization: `Basic ${Buffer.from('mk:secreto-largo').toString('base64')}` } });
    assert.equal(ok.status, 404);
    assert.equal((await ok.json()).ok, false);
  });
});

test('no expone código fuente ni descargas antiguas', async () => {
  const app = createApp(fakeDeps, {});
  await withServer(app, async base => {
    for (const p of ['/server.js', '/src.zip', '/api/download-zip', '/.env', '/package.json']) {
      const res = await fetch(`${base}${p}`);
      const body = await res.text();
      assert.ok(!body.includes('import express'), `${p} expone código`);
      assert.ok(!/FOOTBALL_DATA_TOKEN\s*=/.test(body), `${p} expone secretos`);
    }
  });
});

test('cabeceras de seguridad', async () => {
  const app = createApp(fakeDeps, {});
  await withServer(app, async base => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('content-security-policy'));
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

test('bloquea la IP tras 10 intentos fallidos', async () => {
  const app = createApp(fakeDeps, { auth: { username: 'mk', password: 'secreto-largo' }, logger: { warn() {}, error() {} } });
  await withServer(app, async base => {
    const bad = { headers: { Authorization: `Basic ${Buffer.from('mk:x').toString('base64')}` } };
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/api/status`, bad)).status, 401);
    assert.equal((await fetch(`${base}/api/status`, bad)).status, 429);
    const good = { headers: { Authorization: `Basic ${Buffer.from('mk:secreto-largo').toString('base64')}` } };
    const after = await fetch(`${base}/api/nope`, good);
    assert.equal(after.status, 404, 'la contraseña correcta levanta el bloqueo');
    assert.equal((await fetch(`${base}/api/status`, bad)).status, 401, 'tras entrar, el contador vuelve a empezar');
  });
});

test('el bloqueo de contraseña sobrevive a un reinicio si hay almacén', async () => {
  const mem = new Map();
  const store = {
    persistent: true,
    get: async k => mem.get(k) ?? null,
    set: async (k, v) => { mem.set(k, v); },
    del: async k => { mem.delete(k); }
  };
  const deps = { ...fakeDeps, store };
  const opts = { auth: { username: 'mk', password: 'secreto-largo' }, logger: { warn() {}, error() {} } };
  const bad = { headers: { Authorization: `Basic ${Buffer.from('mk:x').toString('base64')}` } };
  const app1 = createApp(deps, opts);
  await withServer(app1, async base => {
    for (let i = 0; i < 10; i++) assert.equal((await fetch(`${base}/api/status`, bad)).status, 401);
  });
  const app2 = createApp(deps, opts);
  await withServer(app2, async base => {
    assert.equal((await fetch(`${base}/api/status`, bad)).status, 429);
    const good = { headers: { Authorization: `Basic ${Buffer.from('mk:secreto-largo').toString('base64')}` } };
    assert.equal((await fetch(`${base}/api/nope`, good)).status, 404);
  });
  assert.equal(mem.size, 0, 'entrar borra el bloqueo guardado');
});

test('POST sin la cabecera de la app se rechaza', async () => {
  const app = createApp(fakeDeps, {});
  await withServer(app, async base => {
    const res = await fetch(`${base}/api/bets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(res.status, 403);
  });
});

test('/health dice si la base falló', async () => {
  let database = 'migrating';
  const app = createApp(fakeDeps, { healthStatus: () => ({ ok: database !== 'error', database }) });
  await withServer(app, async base => {
    const pending = await fetch(`${base}/health`);
    assert.equal(pending.status, 200);
    assert.equal((await pending.json()).database, 'migrating');
    database = 'error';
    const failed = await fetch(`${base}/health`);
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).database, 'error');
  });
});

test('en producción sin credenciales falla cerrado', async () => {
  const app = createApp(fakeDeps, { auth: { required: true } });
  await withServer(app, async base => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`)).status, 503);
    assert.equal((await fetch(`${base}/`)).status, 503);
  });
});

test('limita peticiones por minuto a la API', async () => {
  const app = createApp(fakeDeps, { apiRateLimitPerMinute: 3 });
  await withServer(app, async base => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/api/nope`)).status);
    assert.deepEqual(codes, [404, 404, 404, 429, 429]);
  });
});

test('JSON mal formado devuelve 400 sin traza', async () => {
  const app = createApp(fakeDeps, { logger: { error() {} } });
  await withServer(app, async base => {
    const res = await fetch(`${base}/api/bets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-MK-Request': '1' },
      body: '{mal'
    });
    assert.equal(res.status, 400);
    const body = await res.text();
    assert.ok(!body.includes('at '), 'sin traza de pila');
  });
});
