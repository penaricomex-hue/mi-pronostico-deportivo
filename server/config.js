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
    // Con 2 competiciones y 3 mercados cada llamada cuesta 3 créditos: 60 min de caché por defecto.
    cacheMinutes: num('ODDS_CACHE_MINUTES', 60),  // en Render se recomienda 240 con el plan gratuito
    markets: process.env.ODDS_MARKETS || 'h2h,totals,spreads',
    // Mercados por evento (cuestan créditos por partido). Vacío = desactivados.
    extraMarkets: process.env.ODDS_EXTRA_MARKETS ?? 'btts,double_chance',
    extrasCacheMinutes: num('ODDS_EXTRAS_CACHE_MINUTES', 720),
    extrasHours: num('ODDS_EXTRAS_HOURS', 30),
    extrasDailyBudget: num('ODDS_EXTRAS_DAILY_BUDGET', 4),
    // Créditos que nunca se gastan (reserva). The Odds API devuelve los restantes en cada respuesta.
    reserveCredits: num('ODDS_RESERVE_CREDITS', 20),
    // Plan gratuito: 500 créditos/mes ≈ 16 al día. Parte se reserva para las cuotas de cierre (CLV).
    dailyCreditBudget: num('ODDS_DAILY_CREDIT_BUDGET', 16),
    closingReserveCredits: num('ODDS_CLOSING_RESERVE_CREDITS', 6),
    preferredBookmaker: process.env.PREFERRED_BOOKMAKER || ''
  },

  /**
   * Casa de ejecución: la cuota que REALMENTE puedes tomar. Si se deja vacío se
   * usa la mejor cuota no atípica entre las casas disponibles. Para fijar una
   * casa usa su nombre o clave de The Odds API (p. ej. "Pinnacle", "betsson").
   */
  execution: {
    bookmaker: process.env.EXECUTION_BOOKMAKER || process.env.PREFERRED_BOOKMAKER || ''
  },

  valueRules: {
    minEv: num('VALUE_MIN_EV', 0.05),
    maxMarketGap: num('VALUE_MAX_MARKET_GAP', 0.10),
    minOdds: num('VALUE_MIN_ODDS', 1.5),
    maxOdds: num('VALUE_MAX_ODDS', 4.0),
    minBookmakers: num('VALUE_MIN_BOOKMAKERS', 3),
    maxBetsPerJornada: num('VALUE_MAX_BETS_PER_JORNADA', 3)
  },

  calibration: {
    method: process.env.CALIBRATION_METHOD || 'auto' // auto | isotonic | platt
  },

  /** paper = simulación (sin dinero real). Recomendado 30–60 días antes de apostar dinero. */
  tradingMode: process.env.TRADING_MODE === 'live' ? 'live' : 'paper',

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
    // Genera y registra señales automáticamente (paper trading).
    scanEveryMinutes: num('SIGNAL_SCAN_EVERY_MINUTES', 120),
    // Cuota de cierre: imprescindible para medir CLV. Activado por defecto en v10.
    trackClosingOdds: bool('TRACK_CLOSING_ODDS', true)
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
    oddsMarkets: config.odds.markets,
    oddsExtraMarkets: config.odds.extraMarkets,
    trackClosingOdds: config.jobs.trackClosingOdds,
    executionBookmaker: config.execution.bookmaker || null,
    valueRules: config.valueRules,
    tradingMode: config.tradingMode,
    calibrationMethod: config.calibration.method
  };
}
