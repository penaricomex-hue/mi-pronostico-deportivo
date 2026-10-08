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
