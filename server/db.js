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
    name: 'v10: LaLiga + Champions, matches.competition_slug, bookmaker_odds, señales, predicciones y calibración',
    sql: `
      -- Partidos ingeridos (todas las fuentes). No existía: se crea aquí.
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        external_id TEXT NOT NULL UNIQUE,
        odds_event_id TEXT,
        league_name TEXT,
        competition_code TEXT,
        match_date DATE,
        kickoff_utc TIMESTAMPTZ,
        home TEXT NOT NULL,
        away TEXT NOT NULL,
        home_goals INT,
        away_goals INT,
        status TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Columna de control (especificación v10)
      ALTER TABLE matches ADD COLUMN IF NOT EXISTS competition_slug VARCHAR(50);

      UPDATE matches
      SET competition_slug = CASE
        WHEN league_name ILIKE '%la liga%' OR league_name ILIKE '%laliga%' THEN 'la_liga'
        WHEN league_name ILIKE '%champions%' THEN 'champions_league'
        ELSE 'excluded'
      END;

      CREATE INDEX IF NOT EXISTS idx_matches_competition
      ON matches (competition_slug, match_date);

      -- Cuotas por casa. 'line' distingue líneas (O/U 2.5, hándicap del local);
      -- vale 0 en mercados sin línea.
      CREATE TABLE IF NOT EXISTS bookmaker_odds (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        bookmaker VARCHAR(50) NOT NULL,
        market VARCHAR(50) NOT NULL,
        selection VARCHAR(50) NOT NULL,
        line NUMERIC(6, 2) NOT NULL DEFAULT 0,
        odds NUMERIC(10, 3) NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_opening BOOLEAN NOT NULL DEFAULT FALSE,
        is_closing BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (match_id, bookmaker, market, selection, line, captured_at)
      );
      CREATE INDEX IF NOT EXISTS idx_bookmaker_odds_match ON bookmaker_odds (match_id, market, selection, captured_at);

      -- Probabilidad ORIGINAL del modelo por partido y selección (base de la calibración)
      CREATE TABLE IF NOT EXISTS model_predictions (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id),
        competition_slug VARCHAR(50) NOT NULL,
        market VARCHAR(50) NOT NULL,
        selection VARCHAR(50) NOT NULL,
        line NUMERIC(6, 2) NOT NULL DEFAULT 0,
        model_probability NUMERIC(8, 5) NOT NULL,
        calibrated_probability NUMERIC(8, 5),
        market_probability NUMERIC(8, 5),
        model_version TEXT,
        predicted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        outcome SMALLINT,
        settled_at TIMESTAMPTZ,
        UNIQUE (match_id, market, selection, line)
      );
      CREATE INDEX IF NOT EXISTS idx_model_predictions_calib ON model_predictions (competition_slug, market, settled_at);

      -- Señales/apuestas registradas (paper trading por defecto)
      CREATE TABLE IF NOT EXISTS value_signals (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        match_id INTEGER REFERENCES matches(id),
        fixture_id TEXT NOT NULL,
        competition_slug VARCHAR(50) NOT NULL,
        jornada_key TEXT,
        kickoff_utc TIMESTAMPTZ,
        home TEXT NOT NULL,
        away TEXT NOT NULL,
        market VARCHAR(50) NOT NULL,
        selection VARCHAR(50) NOT NULL,
        line NUMERIC(6, 2) NOT NULL DEFAULT 0,
        label TEXT,
        bookmaker TEXT,
        odds NUMERIC(10, 3) NOT NULL,
        odds_captured_at TIMESTAMPTZ,
        model_probability NUMERIC(8, 5),
        calibrated_probability NUMERIC(8, 5),
        market_probability NUMERIC(8, 5),
        push_probability NUMERIC(8, 5),
        ev NUMERIC(8, 5),
        market_gap NUMERIC(8, 5),
        avg_market_odds NUMERIC(10, 3),
        bookmaker_count INT,
        stake NUMERIC(12, 2) NOT NULL,
        currency TEXT NOT NULL DEFAULT 'MXN',
        mode TEXT NOT NULL DEFAULT 'paper',
        model_version TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        profit NUMERIC(12, 2),
        home_goals INT,
        away_goals INT,
        settled_at TIMESTAMPTZ,
        closing_odds NUMERIC(10, 3),
        closing_fair_probability NUMERIC(8, 5),
        closing_captured_at TIMESTAMPTZ,
        clv NUMERIC(8, 5),
        UNIQUE (fixture_id, market, selection, line)
      );
      CREATE INDEX IF NOT EXISTS idx_value_signals_comp ON value_signals (competition_slug, created_at);
      CREATE INDEX IF NOT EXISTS idx_value_signals_status ON value_signals (status, kickoff_utc);

      CREATE TABLE IF NOT EXISTS calibration_maps (
        key TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        samples NUMERIC NOT NULL DEFAULT 0,
        live_samples NUMERIC NOT NULL DEFAULT 0,
        payload JSONB NOT NULL,
        fitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Apuestas manuales previas: se conservan, marcadas por competición.
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS competition_slug VARCHAR(50);
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS line NUMERIC(6, 2);
      ALTER TABLE simulated_bets ADD COLUMN IF NOT EXISTS bookmaker TEXT;
      UPDATE simulated_bets
      SET competition_slug = CASE
        WHEN competition ILIKE 'PD' OR competition ILIKE '%la liga%' OR competition ILIKE '%laliga%' THEN 'la_liga'
        WHEN competition ILIKE 'CL' OR competition ILIKE '%champions%' THEN 'champions_league'
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
