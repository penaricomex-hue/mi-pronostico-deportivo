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
import { createApp } from './app.js';
import { createMatchesRepo } from './services/matchesRepo.js';
import { createOddsStore } from './services/oddsStore.js';
import { createCalibrationService } from './services/calibrationService.js';
import { createCalienteService } from './services/caliente.js';
import { createSignalsService } from './services/signals.js';
import { ACTIVE_CODES } from './competitions.js';
import { DEFAULT_ENGINE_RULES } from './model/valueEngine.js';

const logger = console;

const pool = createPool({ databaseUrl: config.databaseUrl, caCert: config.databaseCa, logger });
const store = createStore({ pool, logger });

let migrated = false;
if (pool) {
  try {
    await migrate(pool, logger);
    migrated = true;
  } catch (err) {
    logger.error(`[db] Migraciones fallidas, se continúa sin persistencia de caché: ${err.message}`);
    store.disableDb();
  }
}

const teams = createTeamRegistry();
const db = pool && migrated ? pool : null;
const engineRules = { ...DEFAULT_ENGINE_RULES, ...config.engine };
const footballData = createFootballDataProvider({ ...config.footballData, store, logger });
const odds = createOddsProvider({ ...config.odds, store, logger });
const bigBalls = createBigBallsProvider({ apiKey: config.bigBalls.apiKey, store, teams, logger });
const history = createHistoryProvider({ store, footballData, logger });
const ratings = createRatingsService({ history, logger });
const matchesRepo = db ? createMatchesRepo({ pool: db, logger }) : null;
const oddsStore = db ? createOddsStore({ pool: db, logger }) : null;
const calibration = createCalibrationService({ pool: db, logger });
await calibration.loadFromDb();
const analysis = createAnalysisService({
  footballData, odds, bigBalls, ratings, teams, store, bankroll: config.bankroll, logger,
  matchesRepo, oddsStore, calibration, engineRules
});
const bets = createBetsService({ pool, footballData, odds, analysis, teams, bankroll: config.bankroll, logger });
const caliente = db ? createCalienteService({ pool: db, oddsStore, matchesRepo, analysis, teams, feedUrl: config.caliente.feedUrl, feedToken: config.caliente.feedToken, logger }) : null;
const signals = db ? createSignalsService({
  pool: db, analysis, footballData, matchesRepo, oddsStore, calibration, odds, teams,
  bankroll: config.bankroll, paperTrading: config.paperTrading, engineRules, logger
}) : null;

const app = createApp(
  { analysis, bets, ratings, footballData, odds, store, teams, bankroll: config.bankroll, signals, caliente, calibration, engineRules },
  {
    auth: config.auth,
    production: config.auth.required,
    apiRateLimitPerMinute: config.apiRateLimitPerMinute,
    logger
  }
);

app.listen(config.port, '0.0.0.0', () => {
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

// Tareas periódicas (en Render free solo corren mientras el servicio está despierto)
function every(minutes, name, fn) {
  setInterval(() => {
    fn().then(r => r && logger.log(`[jobs] ${name}: ${JSON.stringify(r)}`)).catch(err => logger.warn(`[jobs] ${name}: ${err.message}`));
  }, minutes * 60000).unref();
}

if (config.jobs.enabled && pool) {
  every(config.jobs.settleEveryMinutes, 'autoSettle', async () => {
    const a = await bets.autoSettle();
    const b = signals ? await signals.settle() : null;
    return a.settled || b?.settled || b?.predictions ? { bets: a.settled, ...b } : null;
  });

  if (config.jobs.trackClosingOdds) {
    every(10, 'closingOdds', async () => {
      const a = await bets.captureClosingOdds();
      const b = signals ? await signals.captureClosing() : null;
      return a.captured || b?.captured ? { bets: a.captured, matches: b?.captured } : null;
    });
  }

  if (signals) {
    // Señales en paper trading con la cuota real de Caliente MX
    every(config.jobs.signalsEveryMinutes, 'signals', async () => {
      const r = await signals.generate({ days: 4 });
      return r.created ? { created: r.created, candidates: r.candidates } : null;
    });
    // Calibración después de cada jornada (diaria)
    every(config.jobs.calibrateEveryHours * 60, 'calibration', async () => {
      const r = await calibration.refit();
      return { models: r.models.length };
    });
  }

  if (caliente?.feedConfigured) {
    every(config.caliente.feedEveryMinutes, 'calienteFeed', async () => caliente.syncFeed());
  }

  setInterval(() => store.purgeExpired().catch(() => {}), 6 * 3600000).unref();
}

// Calentar los modelos de LaLiga y Champions en segundo plano
for (const lg of ACTIVE_CODES) ratings.getRatings(lg).catch(() => {});
