import { config } from './config.js';
import { MODEL_VERSION } from './version.js';
import { createPool, migrate } from './db.js';
import { createStore } from './lib/store.js';
import { createTeamRegistry } from './lib/teams.js';
import { createFootballDataProvider } from './providers/footballData.js';
import { createOddsProvider } from './providers/oddsApi.js';
import { createBigBallsProvider } from './providers/bigBalls.js';
import { createHistoryProvider } from './providers/history.js';
import { createRatingsService } from './services/ratings.js';
import { createAnalysisService } from './services/analysis.js';
import { createBetsService } from './services/bets.js';
import { createCalibrationService } from './services/calibration.js';
import { createIngestService } from './services/ingest.js';
import { createSignalsService } from './services/signals.js';
import { createLessonsService } from './services/lessons.js';
import { createReportService } from './services/reports.js';
import { ACTIVE_CODES } from './competitions.js';
import { createApp } from './app.js';

const logger = console;

const pool = createPool({ databaseUrl: config.databaseUrl, caCert: config.databaseCa, logger });
const store = createStore({ pool, logger });
// pending: el puerto ya escucha (Render no mata el arranque) pero /api espera.
// error: la migración falló; no se consulta la base ni se gastan créditos en tareas.
const migration = { state: pool ? 'pending' : 'disabled' };

function disableQueries(db) {
  db.query = async () => {
    const err = new Error('La base de datos no está disponible.');
    err.status = 503;
    throw err;
  };
}

const teams = createTeamRegistry();
const footballData = createFootballDataProvider({ ...config.footballData, store, logger });
const odds = createOddsProvider({ ...config.odds, store, logger });
const bigBalls = createBigBallsProvider({ apiKey: config.bigBalls.apiKey, store, teams, logger });
const history = createHistoryProvider({ store, logger });
const ratings = createRatingsService({ history, footballData, teams, logger });
const dbPool = pool;
const calibration = createCalibrationService({ pool: dbPool, method: config.calibration.method, logger });
const lessons = createLessonsService({ pool: dbPool, calibration, logger });
const ingest = createIngestService({ pool: dbPool, logger, modelVersion: MODEL_VERSION });
const analysis = createAnalysisService({
  footballData, odds, bigBalls, ratings, teams, store, bankroll: config.bankroll, calibration, ingest,
  executionBookmaker: config.execution.bookmaker, valueRules: config.valueRules, blend: config.blend, lessons, logger
});
const bets = createBetsService({ pool, footballData, odds, analysis, teams, bankroll: config.bankroll, lessons, logger });
const signals = createSignalsService({
  pool: dbPool, analysis, footballData, odds, teams, ingest, calibration, bankroll: config.bankroll,
  mode: config.tradingMode, modelVersion: MODEL_VERSION, logger
});
const reports = createReportService({
  to: config.reports.to,
  smtp: config.reports.smtp,
  bets, signals, lessons, calibration, store, pool: dbPool,
  currency: config.bankroll.currency,
  everyMs: config.reports.everyHours * 3600000,
  logger
});

const app = createApp(
  { analysis, bets, signals, calibration, ratings, footballData, odds, store, teams, bankroll: config.bankroll, lessons, reports },
  {
    auth: config.auth,
    production: config.auth.required,
    apiRateLimitPerMinute: config.apiRateLimitPerMinute,
    logger,
    healthStatus() {
      if (migration.state === 'error') return { ok: false, database: 'error' };
      const database = migration.state === 'ok' ? 'ok' : migration.state === 'pending' ? 'migrating' : 'disabled';
      return { ok: true, database };
    },
    isReady() { return migration.state !== 'pending'; }
  }
);

const server = app.listen(config.port, '0.0.0.0', () => {
  logger.log(`MK Bets ${MODEL_VERSION} escuchando en el puerto ${config.port}`);
  const { username, password, required } = config.auth;
  if (username && password) {
    logger.log('[auth] Basic Auth activada para toda la app.');
    if (password.length < 12) logger.warn('[auth] APP_PASSWORD es corta: usa al menos 12 caracteres.');
  } else if (required) {
    logger.error('[auth] Faltan APP_USERNAME/APP_PASSWORD: la app responde 503 hasta que se configuren.');
  } else {
    logger.warn('[auth] APP_USERNAME/APP_PASSWORD no configurados: la app es pública (solo desarrollo local).');
  }
});
server.on('error', err => logger.error(`[server] No se pudo escuchar: ${err.message}`));

function startJobs() {
  const runSettle = () => {
    bets.autoSettle()
      .then(r => r.settled && logger.log(`[jobs] ${r.settled} apuestas manuales liquidadas`))
      .catch(err => logger.warn(`[jobs] autoSettle: ${err.message}`));
    // Señales + predicciones; si se resolvió alguna predicción, se recalibra (aprendizaje por jornada)
    return signals.settle()
      .then(r => (r.settled || r.predictions) && logger.log(`[jobs] ${r.settled} señales y ${r.predictions} predicciones liquidadas${r.recalibrated ? ' · calibración actualizada' : ''}`))
      .catch(err => logger.warn(`[jobs] settle señales: ${err.message}`));
  };
  // Escaneo de valor: registra señales nuevas (paper trading) con la cuota del momento
  const runScan = () => signals.scan()
    .then(r => logger.log(`[jobs] Escaneo: ${r.analyzed} partidos analizados · ${r.recorded} señales nuevas`))
    .catch(err => logger.warn(`[jobs] scan: ${err.message}`));
  const runClosing = () => {
    bets.captureClosingOdds().catch(() => {});
    return signals.captureClosing()
      .then(r => r.matches && logger.log(`[jobs] Cierre guardado en ${r.matches} partidos · CLV de ${r.signals} señales`))
      .catch(err => logger.warn(`[jobs] closing: ${err.message}`));
  };

  setInterval(runSettle, config.jobs.settleEveryMinutes * 60000).unref();
  setInterval(runScan, config.jobs.scanEveryMinutes * 60000).unref();
  if (config.jobs.trackClosingOdds) setInterval(runClosing, 5 * 60000).unref();

  // Al arrancar (o al despertar en Render free) no esperar al primer intervalo
  setTimeout(() => {
    if (config.jobs.trackClosingOdds) runClosing();
    runSettle().finally(() => setTimeout(runScan, 30000));
  }, 45000).unref();

  setInterval(() => {
    store.purgeExpired().catch(() => {});
    ingest.purgeOldSnapshots(30).catch(() => {});
  }, 6 * 3600000).unref();

  // Recalibración semanal de respaldo (además de la que ocurre tras cada liquidación)
  setInterval(() => calibration.refit().catch(() => {}), 7 * 86400000).unref();

  const runReport = () => reports.deliver()
    .then(r => {
      if (r.sent) logger.log(`[jobs] Informe enviado a ${reports.to}`);
      else if (r.needsSmtp) logger.warn('[jobs] Informe listo, pero falta SMTP_HOST/SMTP_USER/SMTP_PASS para enviarlo.');
    })
    .catch(err => logger.warn(`[jobs] informe: ${err.message}`));
  setInterval(runReport, 6 * 3600000).unref();
  setTimeout(runReport, 120000).unref();
}

async function bootDatabase() {
  if (!pool) {
    calibration.refit().catch(err => logger.warn(`[calibration] ${err.message}`));
    return;
  }
  try {
    await migrate(pool, logger);
    migration.state = 'ok';
    calibration.refit().catch(err => logger.warn(`[calibration] ${err.message}`));
    if (config.jobs.enabled) startJobs();
  } catch (err) {
    migration.state = 'error';
    store.disableDb();
    disableQueries(pool);
    logger.error(`[db] Migraciones fallidas. No se usará la base ni se gastarán créditos en tareas: ${err.message}`);
    calibration.refit().catch(err2 => logger.warn(`[calibration] ${err2.message}`));
  }
}

bootDatabase();

// Calentar los modelos (solo LaLiga y Champions) en segundo plano
for (const lg of ACTIVE_CODES) ratings.getRatings(lg).catch(() => {});
