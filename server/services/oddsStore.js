/**
 * Persistencia de cuotas en `bookmaker_odds`.
 *
 * - Se guarda un registro por casa × selección SOLO cuando la cuota cambia
 *   (o es de cierre), con la hora exacta de captura.
 * - La primera cuota registrada de cada casa/selección se marca is_opening.
 * - La última antes del inicio se marca is_closing.
 * - Caliente MX se guarda como bookmaker = 'caliente_mx' y nunca entra en el
 *   consenso de mercado.
 */
import { marketOf } from '../model/markets.js';

export const CALIENTE = 'caliente_mx';

export function createOddsStore({ pool, logger = console }) {
  async function latestRows(matchId, { bookmaker = null, before = null } = {}) {
    const params = [matchId];
    let where = 'match_id = $1';
    if (bookmaker) { params.push(bookmaker); where += ` AND bookmaker = $${params.length}`; }
    if (before) { params.push(new Date(before)); where += ` AND captured_at <= $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (bookmaker, selection) bookmaker, market, selection, odds, captured_at, is_opening, is_closing, source
         FROM bookmaker_odds WHERE ${where}
        ORDER BY bookmaker, selection, captured_at DESC`,
      params
    );
    return rows;
  }

  /**
   * Guarda un snapshot de cuotas.
   * @param {number} matchId
   * @param {Array<{bookmaker:string, prices:Record<string,number>}>} books
   */
  async function recordBooks(matchId, books, { source = 'api', isClosing = false, capturedAt = new Date() } = {}) {
    if (!pool || !matchId || !books?.length) return { inserted: 0 };
    try {
      const prev = await latestRows(matchId);
      const prevMap = new Map(prev.map(r => [`${r.bookmaker}|${r.selection}`, Number(r.odds)]));
      const cols = { bookmaker: [], market: [], selection: [], odds: [], opening: [] };
      for (const b of books) {
        for (const [sel, price] of Object.entries(b.prices || {})) {
          const market = marketOf(sel);
          const odds = Number(price);
          if (!market || !(odds > 1)) continue;
          const key = `${b.bookmaker}|${sel}`;
          const before = prevMap.get(key);
          if (!isClosing && before != null && Math.abs(before - odds) < 0.0005) continue;
          cols.bookmaker.push(String(b.bookmaker).slice(0, 50));
          cols.market.push(market);
          cols.selection.push(sel.slice(0, 50));
          cols.odds.push(Number(odds.toFixed(3)));
          cols.opening.push(before == null);
        }
      }
      if (!cols.odds.length) return { inserted: 0 };
      const { rowCount } = await pool.query(
        `INSERT INTO bookmaker_odds (match_id, bookmaker, market, selection, odds, captured_at, is_closing, is_opening, source)
         SELECT $1, b, m, s, o, $2, $3, op, $4
           FROM unnest($5::text[], $6::text[], $7::text[], $8::numeric[], $9::boolean[]) AS t(b, m, s, o, op)
         ON CONFLICT (match_id, bookmaker, market, selection, captured_at) DO NOTHING`,
        [matchId, capturedAt, isClosing, source, cols.bookmaker, cols.market, cols.selection, cols.odds, cols.opening]
      );
      return { inserted: rowCount };
    } catch (err) {
      logger.warn(`[odds-store] match ${matchId}: ${err.message}`);
      return { inserted: 0, error: err.message };
    }
  }

  /** Marca como cierre la última cuota antes del inicio (para casas sin snapshot de cierre, p. ej. Caliente manual). */
  async function markClosing(matchId, kickoff, bookmaker = CALIENTE) {
    if (!pool) return 0;
    const { rowCount } = await pool.query(
      `UPDATE bookmaker_odds SET is_closing = TRUE
        WHERE id IN (
          SELECT DISTINCT ON (selection) id FROM bookmaker_odds
           WHERE match_id = $1 AND bookmaker = $2 AND captured_at <= $3
           ORDER BY selection, captured_at DESC)`,
      [matchId, bookmaker, new Date(kickoff)]
    );
    return rowCount;
  }

  /** Cuotas actuales agrupadas por casa: [{ bookmaker, prices, capturedAt }]. */
  async function currentBooks(matchId, { before = null } = {}) {
    if (!pool || !matchId) return [];
    const rows = await latestRows(matchId, { before });
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.bookmaker)) by.set(r.bookmaker, { bookmaker: r.bookmaker, prices: {}, capturedAt: {} });
      const b = by.get(r.bookmaker);
      b.prices[r.selection] = Number(r.odds);
      b.capturedAt[r.selection] = r.captured_at;
    }
    return [...by.values()];
  }

  /** Cuotas de Caliente MX por selección, con hora de captura, apertura y cierre. */
  async function calienteOdds(matchId) {
    if (!pool || !matchId) return {};
    const { rows } = await pool.query(
      `SELECT selection, market, odds, captured_at, is_opening, is_closing, source
         FROM bookmaker_odds WHERE match_id = $1 AND bookmaker = $2 ORDER BY selection, captured_at`,
      [matchId, CALIENTE]
    );
    const out = {};
    for (const r of rows) {
      const o = out[r.selection] || (out[r.selection] = { selection: r.selection, market: r.market, opening: null, current: null, closing: null, history: [] });
      const point = { odds: Number(r.odds), capturedAt: r.captured_at, source: r.source };
      o.history.push(point);
      if (r.is_opening || !o.opening) o.opening = o.opening || point;
      if (r.is_closing) o.closing = point;
      o.current = point;
    }
    return out;
  }

  /** Cuotas de cierre de todas las casas (para CLV). */
  async function closingBooks(matchId) {
    if (!pool || !matchId) return [];
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (bookmaker, selection) bookmaker, selection, odds
         FROM bookmaker_odds WHERE match_id = $1 AND is_closing ORDER BY bookmaker, selection, captured_at DESC`,
      [matchId]
    );
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.bookmaker)) by.set(r.bookmaker, { bookmaker: r.bookmaker, prices: {} });
      by.get(r.bookmaker).prices[r.selection] = Number(r.odds);
    }
    return [...by.values()];
  }

  return { recordBooks, markClosing, currentBooks, calienteOdds, closingBooks };
}
