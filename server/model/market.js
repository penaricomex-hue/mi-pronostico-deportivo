/**
 * Utilidades de mercado: eliminación del margen, consenso, EV, Kelly y detección
 * de cuotas atípicas.
 */
import { clamp } from './poisson.js';

/** Probabilidades sin margen por normalización proporcional. */
export function devig(oddsList) {
  const inv = oddsList.map(o => (Number(o) > 1 ? 1 / Number(o) : NaN));
  if (inv.some(x => !Number.isFinite(x))) return null;
  const s = inv.reduce((a, b) => a + b, 0);
  return { probs: inv.map(x => x / s), overround: s - 1 };
}

export function median(values) {
  const v = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** EV en tanto por uno: p·cuota − 1 */
export function expectedValue(probability, odds) {
  const p = Number(probability);
  const o = Number(odds);
  if (!Number.isFinite(p) || !(o > 1)) return null;
  return p * o - 1;
}

/** Fracción de Kelly completa (puede ser negativa). */
export function kellyFraction(probability, odds) {
  const b = Number(odds) - 1;
  const p = Number(probability);
  if (!(b > 0) || !Number.isFinite(p)) return 0;
  return (b * p - (1 - p)) / b;
}

/**
 * Stake de Kelly fraccional sobre bankroll con tope.
 * @returns {number} importe redondeado a 2 decimales (0 si no hay ventaja)
 */
export function kellyStake({ probability, odds, bankroll, fraction = 0.25, maxPct = 0.02 }) {
  const k = kellyFraction(probability, odds);
  if (!(k > 0) || !(bankroll > 0)) return 0;
  const pct = clamp(k * fraction, 0, maxPct);
  return Number((bankroll * pct).toFixed(2));
}

/**
 * Cuota atípica: la mejor cuota se separa demasiado del consenso. Suele ser un
 * precio desactualizado o un error que la casa anula.
 */
export function isOutlierPrice(best, reference, secondBest = null) {
  if (!(best > 1) || !(reference > 1)) return false;
  if (best > reference * 1.15) return true;
  if (secondBest && best > secondBest * 1.10) return true;
  return false;
}

/**
 * Consenso de mercado a partir de las cuotas por casa (formato The Odds API ya
 * agrupado): [{ bookmaker, prices: { h, d, a } }].
 * Quita el margen de cada casa y promedia las probabilidades.
 */
export function consensus(bookPrices, keys) {
  const acc = keys.map(() => 0);
  let n = 0;
  for (const b of bookPrices) {
    const odds = keys.map(k => b.prices[k]);
    if (odds.some(o => !(o > 1))) continue;
    const dv = devig(odds);
    if (!dv) continue;
    dv.probs.forEach((p, i) => { acc[i] += p; });
    n++;
  }
  if (!n) return null;
  const probs = acc.map(x => x / n);
  return { probs: Object.fromEntries(keys.map((k, i) => [k, probs[i]])), bookmakers: n };
}

/** Resumen de precios para una selección. */
export function priceSummary(entries) {
  const valid = entries.filter(e => e.odds > 1).sort((a, b) => b.odds - a.odds);
  if (!valid.length) return { best: null, bestBookmaker: null, secondBest: null, reference: null, count: 0, prices: [] };
  const unique = [...new Set(valid.map(v => v.odds))];
  return {
    best: valid[0].odds,
    bestBookmaker: valid[0].bookmaker,
    secondBest: unique.length > 1 ? unique[1] : null,
    reference: median(valid.map(v => v.odds)),
    count: valid.length,
    prices: valid
  };
}
