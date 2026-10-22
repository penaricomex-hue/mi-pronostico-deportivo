import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MODEL_VERSION } from './version.js';
import { createApiRouter } from './routes/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Contador por IP en ventana fija. Se usa para limitar intentos de login
 * fallidos y peticiones a la API.
 */
export function createIpCounter({ windowMs, max, now = () => Date.now() }) {
  const hits = new Map();
  function entry(ip) {
    const t = now();
    let e = hits.get(ip);
    if (!e || t - e.start >= windowMs) {
      e = { start: t, count: 0 };
      hits.set(ip, e);
    }
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    }
    return e;
  }
  return {
    hit(ip) { const e = entry(ip); e.count++; return e.count; },
    blocked(ip) { return entry(ip).count >= max; },
    retryAfterSec(ip) { const e = entry(ip); return Math.max(1, Math.ceil((e.start + windowMs - now()) / 1000)); },
    reset(ip) { hits.delete(ip); },
    snapshot(ip) {
      const e = hits.get(ip);
      if (!e || now() - e.start >= windowMs) return null;
      return { start: e.start, count: e.count };
    },
    seed(ip, saved) {
      const start = Number(saved?.start);
      const count = Number(saved?.count);
      if (!Number.isFinite(start) || !Number.isFinite(count)) return;
      if (now() - start >= windowMs) return;
      const cur = hits.get(ip);
      if (!cur || count > cur.count) hits.set(ip, { start, count });
    }
  };
}

/**
 * Basic Auth para TODO salvo /health (necesario para el health check de Render).
 * Tras 10 intentos fallidos en 15 minutos, la IP queda bloqueada. La contraseña
 * correcta levanta el bloqueo: un error propio no deja fuera al dueño.
 * Si hay almacén, el conteo sobrevive a que Render duerma el proceso.
 */
function readBasic(req) {
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return null;
  let decoded = '';
  try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch { return { user: '', pass: '' }; }
  const sep = decoded.indexOf(':');
  return {
    user: sep >= 0 ? decoded.slice(0, sep) : decoded,
    pass: sep >= 0 ? decoded.slice(sep + 1) : ''
  };
}

export function basicAuth({ username, password, maxFailures = 10, windowMs = 15 * 60000, logger = console, store = null }) {
  const failures = createIpCounter({ windowMs, max: maxFailures });
  const hydrated = new Set();
  const keyFor = ip => `authfail:${ip}`;

  async function hydrate(ip) {
    if (hydrated.has(ip) || !store || typeof store.get !== 'function') return;
    hydrated.add(ip);
    try {
      const saved = await store.get(keyFor(ip));
      if (saved) failures.seed(ip, saved);
    } catch { /* sigue valiendo el conteo en memoria */ }
  }

  function remember(ip) {
    if (!store || typeof store.set !== 'function') return;
    const snap = failures.snapshot(ip);
    const ttl = snap ? Math.max(1, Math.ceil((snap.start + windowMs - Date.now()) / 1000)) : 1;
    const op = snap
      ? store.set(keyFor(ip), snap, ttl)
      : (typeof store.del === 'function' ? store.del(keyFor(ip)) : null);
    if (op && typeof op.catch === 'function') op.catch(() => {});
  }

  return async (req, res, next) => {
    try {
      if (req.path === '/health') return next();
      const ip = clientIp(req);
      await hydrate(ip);
      const creds = readBasic(req);
      if (creds) {
        const okUser = safeEqual(creds.user, username);
        const okPass = safeEqual(creds.pass, password);
        if (okUser && okPass) {
          failures.reset(ip);
          remember(ip);
          return next();
        }
      }
      if (failures.blocked(ip)) {
        res.set('Retry-After', String(failures.retryAfterSec(ip)));
        return res.status(429).send('Demasiados intentos fallidos. Espera unos minutos.');
      }
      if (creds) {
        const n = failures.hit(ip);
        remember(ip);
        if (n === maxFailures) logger.warn(`[auth] IP ${ip} bloqueada tras ${n} intentos fallidos.`);
      }
      res.set('WWW-Authenticate', 'Basic realm="MK Bets", charset="UTF-8"');
      return res.status(401).send('Acceso restringido.');
    } catch (err) {
      next(err);
    }
  };
}

function apiRateLimit(perMinute) {
  const counter = createIpCounter({ windowMs: 60000, max: perMinute });
  return (req, res, next) => {
    const ip = clientIp(req);
    if (counter.hit(ip) > perMinute) {
      res.set('Retry-After', String(counter.retryAfterSec(ip)));
      return res.status(429).json({ ok: false, error: 'Demasiadas peticiones. Inténtalo en un minuto.' });
    }
    next();
  };
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

function securityHeaders(production) {
  return (_req, res, next) => {
    res.set('Content-Security-Policy', CSP);
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'DENY');
    res.set('Cross-Origin-Opener-Policy', 'same-origin');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/**
 * @param {object} deps servicios (analysis, bets, ratings, ...)
 * @param {object} opts
 * @param {{username?:string, password?:string, required?:boolean}} [opts.auth]
 * @param {boolean} [opts.production]
 * @param {() => {ok?: boolean}} [opts.healthStatus] detalle de /health (la base, sobre todo)
 * @param {() => boolean} [opts.isReady] mientras sea false, /api responde 503
 */
export function createApp(deps, { auth, production = false, apiRateLimitPerMinute = 120, logger = console, healthStatus = null, isReady = null } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Render (y casi cualquier PaaS) pone un proxy delante: confiar en el primero para obtener la IP real.
  app.set('trust proxy', 1);
  app.use(securityHeaders(production));

  app.get('/health', (_req, res) => {
    const extra = typeof healthStatus === 'function' ? healthStatus() : {};
    const ok = extra.ok !== false;
    res.set('Cache-Control', 'no-store');
    res.status(ok ? 200 : 503).json({ modelVersion: MODEL_VERSION, ...extra, ok });
  });

  const hasCredentials = Boolean(auth?.username && auth?.password);
  if (hasCredentials) {
    app.use(basicAuth({ username: auth.username, password: auth.password, logger, store: deps?.store }));
  } else if (auth?.required) {
    // Fallar cerrado: sin credenciales configuradas no se sirve nada.
    app.use((_req, res) => res.status(503).send(
      'Configura APP_USERNAME y APP_PASSWORD en las variables de entorno del servidor para activar la app.'
    ));
  }

  app.use('/api', (req, res, next) => {
    if (typeof isReady === 'function' && !isReady()) {
      res.set('Retry-After', '5');
      return res.status(503).json({ ok: false, error: 'El servidor está arrancando. Inténtalo en unos segundos.' });
    }
    next();
  });
  // Un formulario de otro sitio no puede añadir esta cabecera; las peticiones
  // que cambian datos o gastan créditos quedan así fuera del alcance de un CSRF.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (req.get('x-mk-request') === '1') return next();
    return res.status(403).json({ ok: false, error: 'Petición rechazada.' });
  });
  app.use('/api', apiRateLimit(apiRateLimitPerMinute), express.json({ limit: '100kb' }));
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', createApiRouter(deps));

  if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    app.use(express.static(DIST_DIR, { index: false, dotfiles: 'deny', maxAge: '7d', setHeaders(res, file) {
      if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache');
    } }));
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => res.status(503).send('Frontend no compilado. Ejecuta: npm run build'));
  }

  // Errores no controlados (p. ej. JSON mal formado): nunca devolver la traza.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) logger.error('[app]', err);
    res.status(status).json({ ok: false, error: status >= 500 ? 'Error interno.' : 'Petición no válida.' });
  });

  return app;
}
