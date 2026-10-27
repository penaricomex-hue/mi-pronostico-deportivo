/**
 * Lo que el usuario apuesta a mano en fútbol (LaLiga y Champions) entra en el
 * criterio del motor. No hay otros deportes.
 *
 * - Con 8 o más resultados en un mercado, el EV mínimo se mueve ±1 punto
 *   (nunca sale de 3%–8%).
 * - Si además guardamos la probabilidad del modelo, el resultado alimenta
 *   la calibración (manual_outcomes).
 */
import { MARKETS } from '../model/markets.js';

export const REASON_TAGS = [
  { id: 'forma', label: 'Forma reciente' },
  { id: 'bajas', label: 'Bajas o alineación' },
  { id: 'cuota', label: 'La cuota me parece alta' },
  { id: 'goles', label: 'Goles (más o menos)' },
  { id: 'localia', label: 'Localía' },
  { id: 'rival', label: 'El rival llega peor' },
  { id: 'contexto', label: 'Calendario o motivación' }
];

const TAG_IDS = new Set(REASON_TAGS.map(t => t.id));
const GROUP_LABEL = { '1x2': '1X2', over_under: 'Más/menos 2.5', btts: 'Ambos anotan' };
const MIN_SAMPLE = 8;

export function normalizeTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const out = [];
  for (const raw of list) {
    const id = String(raw || '').trim().toLowerCase();
    if (TAG_IDS.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export function tagLabel(id) {
  return REASON_TAGS.find(t => t.id === id)?.label || id;
}

/** 1 ganada, 0 perdida, null si no enseña (pendiente, nula). */
export function outcomeBit(status) {
  if (status === 'won' || status === 'half_won') return 1;
  if (status === 'lost' || status === 'half_lost') return 0;
  return null;
}

export function calibrationGroup(market) {
  return MARKETS[market]?.calibrationGroup || null;
}

/**
 * @param {Array<object>} rows filas de simulated_bets ya liquidadas
 */
export function criteriaFromBets(rows) {
  const buckets = new Map();
  for (const r of rows) {
    if (r.source && r.source !== 'manual') continue;
    const group = calibrationGroup(r.market);
    if (!group || !r.competition_slug) continue;
    if (outcomeBit(r.status) == null) continue;
    const key = `${r.competition_slug}|${group}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        key, competitionSlug: r.competition_slug, group, n: 0, hits: 0,
        staked: 0, profit: 0, tagHits: new Map()
      };
      buckets.set(key, b);
    }
    b.n += 1;
    const hit = outcomeBit(r.status) === 1;
    if (hit) b.hits += 1;
    b.staked += Number(r.stake) || 0;
    b.profit += Number(r.profit) || 0;
    if (hit) {
      for (const t of normalizeTags(r.tags)) b.tagHits.set(t, (b.tagHits.get(t) || 0) + 1);
    }
  }

  const byKey = {};
  const groups = [];
  for (const b of buckets.values()) {
    const hit = b.n ? b.hits / b.n : 0;
    const roi = b.staked ? b.profit / b.staked : 0;
    let minEvDelta = 0;
    let stance = 'estable';
    if (b.n < MIN_SAMPLE) stance = 'pocos datos';
    else if (roi >= 0.05 && hit >= 0.55) { minEvDelta = -0.01; stance = 'afloja'; }
    else if (roi <= -0.08) { minEvDelta = 0.01; stance = 'aprieta'; }
    const top = [...b.tagHits.entries()].sort((a, c) => c[1] - a[1])[0];
    const item = {
      key: b.key,
      competitionSlug: b.competitionSlug,
      group: b.group,
      groupLabel: GROUP_LABEL[b.group] || b.group,
      n: b.n,
      hits: b.hits,
      hitPct: Number((100 * hit).toFixed(1)),
      roiPct: b.staked ? Number((100 * roi).toFixed(1)) : null,
      minEvDelta,
      stance,
      topTag: top && top[1] > 0 ? top[0] : null,
      topTagLabel: top && top[1] > 0 ? tagLabel(top[0]) : null
    };
    byKey[b.key] = item;
    groups.push(item);
  }
  groups.sort((a, c) => c.n - a.n);
  return { sport: 'football', minSample: MIN_SAMPLE, byKey, groups };
}

export function createLessonsService({ pool = null, calibration = null, logger = console } = {}) {
  let cache = null;
  let cacheAt = 0;

  function invalidate() {
    cache = null;
    cacheAt = 0;
  }

  async function criteria() {
    if (cache && Date.now() - cacheAt < 60_000) return cache;
    if (!pool) {
      cache = criteriaFromBets([]);
      cacheAt = Date.now();
      return cache;
    }
    try {
      const { rows } = await pool.query(
        `SELECT competition_slug, market, status, stake, profit, tags, source
           FROM simulated_bets
          WHERE source = 'manual'
            AND status IN ('won', 'lost', 'half_won', 'half_lost')
            AND competition_slug IN ('la_liga', 'champions_league')`
      );
      cache = criteriaFromBets(rows);
    } catch (err) {
      logger.warn(`[lessons] No se pudo leer el criterio: ${err.message}`);
      cache = criteriaFromBets([]);
    }
    cacheAt = Date.now();
    return cache;
  }

  /**
   * Incorpora el resultado de una apuesta manual. Las combinadas no enseñan:
   * no se sabe qué pata aportó.
   */
  async function absorb(row, { refit = true } = {}) {
    if (!pool || !row || row.source !== 'manual' || row.market === 'parlay') return { learned: false };
    const bit = outcomeBit(row.status);
    const group = calibrationGroup(row.market);
    const p = row.model_probability != null ? Number(row.model_probability) : null;
    if (bit == null || !group || !(p > 0 && p < 1) || !row.competition_slug) {
      await pool.query('DELETE FROM manual_outcomes WHERE bet_id = $1', [row.id]);
      await pool.query('UPDATE simulated_bets SET learned_at = NULL WHERE id = $1', [row.id]);
      invalidate();
      return { learned: false };
    }
    await pool.query(
      `INSERT INTO manual_outcomes (bet_id, competition_slug, market, model_probability, outcome, settled_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (bet_id) DO UPDATE SET
         competition_slug = EXCLUDED.competition_slug,
         market = EXCLUDED.market,
         model_probability = EXCLUDED.model_probability,
         outcome = EXCLUDED.outcome,
         settled_at = now()`,
      [row.id, row.competition_slug, group, p, bit]
    );
    await pool.query('UPDATE simulated_bets SET learned_at = now() WHERE id = $1', [row.id]);
    invalidate();
    if (refit && calibration) await calibration.refit().catch(err => logger.warn(`[lessons] ${err.message}`));
    return { learned: true };
  }

  async function forget(betId) {
    if (!pool || !betId) return;
    await pool.query('DELETE FROM manual_outcomes WHERE bet_id = $1', [Number(betId)]).catch(() => {});
    invalidate();
  }

  async function refit() {
    invalidate();
    if (calibration) await calibration.refit().catch(err => logger.warn(`[lessons] ${err.message}`));
  }

  return { criteria, absorb, forget, invalidate, refit };
}
