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

const logger = console;

const pool = createPool({ databaseUrl: config.databaseUrl, caCert: config.databaseCa, logger });
const store = createStore({ pool, logger });

if (pool) {
  try {
    await migrate(pool, logger);
  } catch (err) {
    logger.error(`[db] Migraciones fallidas, se continúa sin persistencia de caché: ${err.message}`);
    store.disableDb();
  }
}

const teams = createTeamRegistry();
const footballData = createFootballDataProvider({ ...config.footballData, store, logger });
const odds = createOddsProvider({ ...config.odds, store, logger });
const bigBalls = createBigBallsProvider({ apiKey: config.bigBalls.apiKey, store, teams, logger });
const history = createHistoryProvider({ store, logger });
const ratings = createRatingsService({ history, logger });
const analysis = createAnalysisService({ footballData, odds, bigBalls, ratings, teams, store, bankroll: config.bankroll, logger });
const bets = createBetsService({ pool, footballData, odds, analysis, teams, bankroll: config.bankroll, logger });

const app = createApp(
  { analysis, bets, ratings, footballData, odds, store, teams, bankroll: config.bankroll },
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
if (config.jobs.enabled && pool) {
  const settleMs = config.jobs.settleEveryMinutes * 60000;
  setInterval(() => {
    bets.autoSettle()
      .then(r => r.settled && logger.log(`[jobs] ${r.settled} apuestas liquidadas`))
      .catch(err => logger.warn(`[jobs] autoSettle: ${err.message}`));
  }, settleMs).unref();

  if (config.jobs.trackClosingOdds) {
    setInterval(() => {
      bets.captureClosingOdds()
        .then(r => r.captured && logger.log(`[jobs] ${r.captured} cuotas de cierre guardadas`))
        .catch(err => logger.warn(`[jobs] closingOdds: ${err.message}`));
    }, 10 * 60000).unref();
  }

  setInterval(() => store.purgeExpired().catch(() => {}), 6 * 3600000).unref();
}

// Calentar los modelos de liga en segundo plano
for (const lg of ['PL', 'PD', 'SA', 'BL1', 'FL1']) ratings.getRatings(lg).catch(() => {});
