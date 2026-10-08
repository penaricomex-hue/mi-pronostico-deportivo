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
    reset(ip) { hits.delete(ip); }
  };
}

/**
 * Basic Auth para TODO salvo /health (necesario para el health check de Render).
 * Tras 10 intentos fallidos en 15 minutos, la IP queda bloqueada temporalmente.
 */
export function basicAuth({ username, password, maxFailures = 10, windowMs = 15 * 60000, logger = console }) {
  const failures = createIpCounter({ windowMs, max: maxFailures });
  return (req, res, next) => {
    if (req.path === '/health') return next();
    const ip = clientIp(req);
    if (failures.blocked(ip)) {
      res.set('Retry-After', String(failures.retryAfterSec(ip)));
      return res.status(429).send('Demasiados intentos fallidos. Espera unos minutos.');
    }
    const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
      // Evaluar ambas comparaciones siempre (sin cortocircuito)
      const okUser = safeEqual(user, username);
      const okPass = safeEqual(pass, password);
      if (okUser && okPass) return next();
      const n = failures.hit(ip);
      if (n === maxFailures) logger.warn(`[auth] IP ${ip} bloqueada tras ${n} intentos fallidos.`);
    }
    res.set('WWW-Authenticate', 'Basic realm="MK Bets", charset="UTF-8"');
    return res.status(401).send('Acceso restringido.');
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
 * @param {number} [opts.apiRateLimitPerMinute]
 */
export function createApp(deps, { auth, production = false, apiRateLimitPerMinute = 120, logger = console } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Render (y casi cualquier PaaS) pone un proxy delante: confiar en el primero para obtener la IP real.
  app.set('trust proxy', 1);
  app.use(securityHeaders(production));

  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, modelVersion: MODEL_VERSION });
  });

  const hasCredentials = Boolean(auth?.username && auth?.password);
  if (hasCredentials) {
    app.use(basicAuth({ username: auth.username, password: auth.password, logger }));
  } else if (auth?.required) {
    // Fallar cerrado: sin credenciales configuradas no se sirve nada.
    app.use((_req, res) => res.status(503).send(
      'Configura APP_USERNAME y APP_PASSWORD en las variables de entorno del servidor para activar la app.'
    ));
  }

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
