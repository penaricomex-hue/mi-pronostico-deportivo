import 'dotenv/config';

function num(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== '' ? v : fallback;
}

function bool(name, fallback = false) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(String(v).toLowerCase());
}

export const config = {
  port: num('PORT', 3000),
  nodeEnv: process.env.NODE_ENV || 'development',

  auth: {
    username: process.env.APP_USERNAME || '',
    password: process.env.APP_PASSWORD || '',
    // En Render/producción la app se niega a servir datos sin credenciales.
    required: process.env.REQUIRE_AUTH
      ? process.env.REQUIRE_AUTH !== 'false'
      : Boolean(process.env.RENDER || process.env.NODE_ENV === 'production')
  },
  // Peticiones por minuto y por IP a /api (protección básica contra abuso).
  apiRateLimitPerMinute: num('API_RATE_LIMIT_PER_MINUTE', 120),

  footballData: {
    token: process.env.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_API_KEY || '',
    baseUrl: 'https://api.football-data.org/v4',
    // Plan gratuito: 10 llamadas por minuto (no hay tope mensual).
    requestsPerMinute: num('FOOTBALL_DATA_RPM', 10)
  },

  odds: {
    apiKey: process.env.ODDS_API_KEY || process.env.THE_ODDS_API_KEY || '',
    baseUrl: process.env.ODDS_API_BASE_URL || 'https://api.the-odds-api.com/v4',
    regions: process.env.ODDS_REGIONS || 'eu',
    cacheMinutes: num('ODDS_CACHE_MINUTES', 20),
    // Créditos que nunca se gastan (reserva). The Odds API devuelve los restantes en cada respuesta.
    reserveCredits: num('ODDS_RESERVE_CREDITS', 40),
    dailyCreditBudget: num('ODDS_DAILY_CREDIT_BUDGET', 30),
    preferredBookmaker: process.env.PREFERRED_BOOKMAKER || ''
  },

  bigBalls: {
    apiKey: process.env.BIGBALLS_KEY || ''
  },

  databaseUrl: process.env.DATABASE_URL || '',
  databaseCa: process.env.DATABASE_CA_CERT || '',

  bankroll: {
    currency: process.env.CURRENCY || 'MXN',
    flatStake: num('STAKE', num('STAKE_EUR', 100)),
    bankroll: num('BANKROLL', 5000),
    kellyFraction: num('KELLY_FRACTION', 0.25),
    maxStakePct: num('MAX_STAKE_PCT', 0.02)
  },

  jobs: {
    enabled: bool('ENABLE_JOBS', true),
    settleEveryMinutes: num('SETTLE_EVERY_MINUTES', 60),
    trackClosingOdds: bool('TRACK_CLOSING_ODDS', false)
  }
};

export function publicConfig() {
  return {
    footballDataConfigured: Boolean(config.footballData.token),
    oddsApiConfigured: Boolean(config.odds.apiKey),
    databaseConfigured: Boolean(config.databaseUrl),
    bigBallsConfigured: Boolean(config.bigBalls.apiKey),
    currency: config.bankroll.currency,
    flatStake: config.bankroll.flatStake,
    bankroll: config.bankroll.bankroll,
    kellyFraction: config.bankroll.kellyFraction,
    maxStakePct: config.bankroll.maxStakePct,
    oddsCacheMinutes: config.odds.cacheMinutes,
    trackClosingOdds: config.jobs.trackClosingOdds
  };
}
