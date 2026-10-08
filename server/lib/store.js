/**
 * Almacén clave-valor con caducidad.
 * - L1: memoria del proceso.
 * - L2: tabla kv_store de PostgreSQL (si hay base de datos), para que la caché
 *   y el consumo de cuota sobrevivan a reinicios y a la suspensión de Render.
 */
export function createStore({ pool = null, logger = console, now = () => Date.now() } = {}) {
  const mem = new Map();
  let dbFailed = false;

  function memGet(key) {
    const item = mem.get(key);
    if (!item) return undefined;
    if (item.expiresAt && item.expiresAt <= now()) { mem.delete(key); return undefined; }
    return item.value;
  }

  async function get(key) {
    const v = memGet(key);
    if (v !== undefined) return v;
    if (!pool || dbFailed) return null;
    try {
      const { rows } = await pool.query(
        'SELECT value, expires_at FROM kv_store WHERE key = $1 AND (expires_at IS NULL OR expires_at > now())',
        [key]
      );
      if (!rows.length) return null;
      const expiresAt = rows[0].expires_at ? new Date(rows[0].expires_at).getTime() : null;
      mem.set(key, { value: rows[0].value, expiresAt });
      return rows[0].value;
    } catch (err) {
      logger.warn(`[store] Lectura en BD falló (${key}): ${err.message}`);
      return null;
    }
  }

  async function set(key, value, ttlSeconds = null) {
    const expiresAt = ttlSeconds ? now() + ttlSeconds * 1000 : null;
    mem.set(key, { value, expiresAt });
    if (!pool || dbFailed) return value;
    try {
      await pool.query(
        `INSERT INTO kv_store (key, value, expires_at) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(value), expiresAt ? new Date(expiresAt) : null]
      );
    } catch (err) {
      logger.warn(`[store] Escritura en BD falló (${key}): ${err.message}`);
    }
    return value;
  }

  async function del(key) {
    mem.delete(key);
    if (pool && !dbFailed) {
      try { await pool.query('DELETE FROM kv_store WHERE key = $1', [key]); } catch { /* sin efecto */ }
    }
  }

  async function purgeExpired() {
    const t = now();
    for (const [k, v] of mem) if (v.expiresAt && v.expiresAt <= t) mem.delete(k);
    if (pool && !dbFailed) {
      try { await pool.query('DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at <= now()'); } catch { /* sin efecto */ }
    }
  }

  /** Lee de caché o calcula y guarda. No guarda valores null/undefined ni arrays vacíos. */
  async function remember(key, ttlSeconds, compute) {
    const cached = await get(key);
    if (cached != null) return cached;
    const value = await compute();
    const empty = value == null || (Array.isArray(value) && value.length === 0);
    if (!empty) await set(key, value, ttlSeconds);
    return value;
  }

  return {
    get, set, del, remember, purgeExpired,
    disableDb() { dbFailed = true; },
    persistent: Boolean(pool)
  };
}
