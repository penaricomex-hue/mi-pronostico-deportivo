import pg from 'pg';

/**
 * Conexión y migraciones de PostgreSQL. Si no hay DATABASE_URL devuelve null y
 * la app funciona en memoria (sin historial de apuestas persistente).
 */
export function createPool({ databaseUrl, caCert = '', logger = console } = {}) {
  if (!databaseUrl) return null;
  const isLocal = /localhost|127\.0\.0\.1/.test(databaseUrl);
  let ssl = false;
  if (!isLocal) {
    // Con DATABASE_CA_CERT se valida el certificado. Sin él, se mantiene el
    // comportamiento compatible con Render (TLS sin validar la cadena).
    ssl = caCert ? { ca: caCert, rejectUnauthorized: true } : { rejectUnauthorized: false };
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, ssl, max: 5 });
  pool.on('error', err => logger.warn(`[db] Error en conexión inactiva: ${err.message}`));
  return pool;
}

export const MIGRATIONS = [
  {
    id: 1,
    name: 'simulated_bets base',
    sql: `
      CREATE TABLE IF NOT EXISTS simulated_bets (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        match_date DATE,
        home TEXT NOT NULL,
        away TEXT NOT NULL,
        competition TEXT,
        market TEXT NOT NULL,
        outcome TEXT NOT NULL,
        market_name TEXT NOT NULL,
        odds NUMERIC NOT NULL,
        model_probability NUMERIC,
        stake_eur NUMERIC NOT NULL DEFAULT 10,
        status TEXT NOT NULL DEFAULT 'pending',
        profit_eur NUMERIC,
        settled_at TIMESTAMPTZ,
        legs_json JSONB
      );`
  },
  {
    id: 2,
    name: 'v9: moneda configurable, fixture id, kickoff UTC y cuota de cierre',
    sql: `
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='simulated_bets' AND column_name='stake_eur') THEN
          ALTER TABLE simulated_bets RENAME COLUMN stake_eur TO stake;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='simulated_bets' AND column_name='profit_eur') THEN
          ALTER TABLE simulated_bets RENAME COLUMN profit_eur TO profit;
        END IF;
      END $$;
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'EUR';
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS fixture_id TEXT;
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS kickoff_utc TIMESTAMPTZ;
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS selection TEXT;
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS closing_odds NUMERIC;
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS closing_fair_probability NUMERIC;
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS home_goals INT;
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS away_goals INT;
      CREATE INDEX IF NOT EXISTS simulated_bets_status_idx ON simulated_bets (status);
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        expires_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS kv_store_expires_idx ON kv_store (expires_at);`
  },
  {
    id: 3,
    name: 'v10: LaLiga + Champions, competition_slug, bookmaker_odds (Caliente MX), señales y calibración',
    sql: `
      -- Partidos ingeridos (calendario + resultado). Se conserva todo el histórico.
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        external_id TEXT NOT NULL UNIQUE,
        league_name TEXT NOT NULL,
        competition_code TEXT,
        match_date DATE NOT NULL,
        kickoff_utc TIMESTAMPTZ,
        matchday INT,
        stage TEXT,
        home TEXT NOT NULL,
        away TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'SCHEDULED',
        home_goals INT,
        away_goals INT,
        odds_event_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Columna de control de competición
      ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS competition_slug VARCHAR(50);

      UPDATE matches
      SET competition_slug = CASE
      WHEN league_name ILIKE '%la liga%' OR league_name ILIKE '%laliga%' THEN 'la_liga'
      WHEN league_name ILIKE '%champions%' THEN 'champions_league'
      ELSE 'excluded'
      END;

      CREATE INDEX IF NOT EXISTS idx_matches_competition
      ON matches (competition_slug, match_date);

      -- Cuotas por casa: Caliente MX (ejecución) + casas de referencia (mercado sin margen)
      CREATE TABLE IF NOT EXISTS bookmaker_odds (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        bookmaker VARCHAR(50) NOT NULL,
        market VARCHAR(50) NOT NULL,
        selection VARCHAR(50) NOT NULL,
        odds NUMERIC(10, 3) NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_closing BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (match_id, bookmaker, market, selection, captured_at)
      );
      ALTER TABLE bookmaker_odds ADD COLUMN IF NOT EXISTS is_opening BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE bookmaker_odds ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'api';
      CREATE INDEX IF NOT EXISTS idx_bookmaker_odds_lookup
        ON bookmaker_odds (match_id, bookmaker, market, selection, captured_at DESC);

      -- Predicción original del modelo (para calibrar después de cada jornada)
      CREATE TABLE IF NOT EXISTS model_predictions (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        competition_slug VARCHAR(50) NOT NULL,
        market VARCHAR(50) NOT NULL,
        selection VARCHAR(50) NOT NULL,
        raw_probability NUMERIC(8, 6) NOT NULL,
        calibrated_probability NUMERIC(8, 6),
        market_probability NUMERIC(8, 6),
        model_version TEXT,
        predicted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        result VARCHAR(12),
        UNIQUE (match_id, market, selection)
      );
      CREATE INDEX IF NOT EXISTS idx_model_predictions_comp ON model_predictions (competition_slug, market);

      -- Señales / apuestas registradas (paper trading o real)
      CREATE TABLE IF NOT EXISTS bet_signals (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        competition_slug VARCHAR(50) NOT NULL,
        matchday_key VARCHAR(80) NOT NULL,
        market VARCHAR(50) NOT NULL,
        selection VARCHAR(50) NOT NULL,
        label TEXT,
        model_version TEXT,
        model_probability_raw NUMERIC(8, 6) NOT NULL,
        model_probability NUMERIC(8, 6) NOT NULL,
        market_probability NUMERIC(8, 6) NOT NULL,
        market_books INT,
        market_avg_odds NUMERIC(10, 3),
        caliente_odds NUMERIC(10, 3) NOT NULL,
        caliente_captured_at TIMESTAMPTZ NOT NULL,
        ev NUMERIC(10, 6) NOT NULL,
        market_gap NUMERIC(10, 6) NOT NULL,
        stake NUMERIC(12, 2) NOT NULL,
        currency VARCHAR(8) NOT NULL DEFAULT 'MXN',
        mode VARCHAR(10) NOT NULL DEFAULT 'paper',
        status VARCHAR(12) NOT NULL DEFAULT 'pending',
        profit NUMERIC(12, 2),
        closing_caliente_odds NUMERIC(10, 3),
        closing_market_probability NUMERIC(8, 6),
        closing_market_avg_odds NUMERIC(10, 3),
        clv NUMERIC(10, 6),
        home_goals INT,
        away_goals INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        settled_at TIMESTAMPTZ,
        UNIQUE (match_id, market, selection)
      );
      CREATE INDEX IF NOT EXISTS idx_bet_signals_comp ON bet_signals (competition_slug, created_at);

      -- Calibradores ajustados por competición y mercado
      CREATE TABLE IF NOT EXISTS calibration_models (
        key VARCHAR(80) PRIMARY KEY,
        method VARCHAR(20) NOT NULL,
        n INT NOT NULL,
        model JSONB NOT NULL,
        fitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Apuestas simuladas anteriores: se conservan, marcadas por competición
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS competition_slug VARCHAR(50);
      UPDATE simulated_bets
      SET competition_slug = CASE
      WHEN competition = 'PD' OR competition ILIKE '%la liga%' OR competition ILIKE '%laliga%' THEN 'la_liga'
      WHEN competition = 'CL' OR competition ILIKE '%champions%' THEN 'champions_league'
      ELSE 'excluded'
      END
      WHERE competition_slug IS NULL;
      CREATE INDEX IF NOT EXISTS idx_simulated_bets_competition ON simulated_bets (competition_slug, created_at);`
  }
];

export async function migrate(pool, logger = console) {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (id INT PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ DEFAULT now())`);
  const { rows } = await pool.query('SELECT id FROM schema_migrations');
  const done = new Set(rows.map(r => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
      await client.query('COMMIT');
      logger.log(`[db] Migración ${m.id} aplicada: ${m.name}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
