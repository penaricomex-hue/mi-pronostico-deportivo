/**
 * Mezcla modelo + mercado (pooling logarítmico).
 *
 *   p_i ∝ p_modelo_i^w · p_mercado_i^(1 − w)      (normalizado dentro del mercado)
 *
 * w = peso del modelo (0 = solo mercado, 1 = solo modelo). El EV se calcula con
 * la probabilidad mezclada: solo aparece valor cuando el modelo discrepa del
 * mercado con suficiente fuerza como para mover el consenso.
 *
 * Los pesos por competición y grupo se ajustan en el backtest (temporadas de
 * entrenamiento, mínima log-loss) y se guardan en data/blend-weights.json.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const EPS = 1e-6;
const clamp = p => Math.min(1 - EPS, Math.max(EPS, p));

/** Grupos de selecciones mutuamente excluyentes que se mezclan juntas. */
export const BLEND_GROUPS = {
  '1x2': ['home', 'draw', 'away'],
  over_under: ['over25', 'under25'],
  btts: ['btts_yes', 'btts_no']
};

/** Peso por defecto si no hay pesos ajustados (prudente: el mercado manda). */
export const DEFAULT_MODEL_WEIGHT = 0.3;

/** Mezcla un vector de probabilidades de un mismo mercado. */
export function poolVector(model, market, weight, keys) {
  const w = Math.min(1, Math.max(0, Number(weight)));
  if (keys.some(k => !(model?.[k] > 0) || !(market?.[k] > 0))) return null;
  const raw = keys.map(k => Math.exp(w * Math.log(clamp(model[k])) + (1 - w) * Math.log(clamp(market[k]))));
  const s = raw.reduce((a, b) => a + b, 0);
  return Object.fromEntries(keys.map((k, i) => [k, raw[i] / s]));
}

/** Mezcla binaria (p.ej. hándicap asiático sin push). */
export function poolBinary(pModel, pMarket, weight) {
  if (!(pModel > 0) || !(pMarket > 0)) return null;
  return poolVector({ a: pModel, b: 1 - pModel }, { a: pMarket, b: 1 - pMarket }, weight, ['a', 'b'])?.a ?? null;
}

/**
 * Mezcla todas las probabilidades calibradas con el mercado sin margen.
 * Devuelve las probabilidades de los grupos fijos más la doble oportunidad
 * derivada del 1X2 mezclado. Los grupos sin mercado completo quedan en null.
 */
export function blendProbabilities(calibrated, marketFair, weights = {}) {
  if (!calibrated || !marketFair) return null;
  const out = {};
  for (const [group, keys] of Object.entries(BLEND_GROUPS)) {
    const w = weights[group] ?? DEFAULT_MODEL_WEIGHT;
    const v = poolVector(calibrated, marketFair, w, keys);
    for (const k of keys) out[k] = v ? v[k] : null;
  }
  if (out.home != null) {
    out.dc_1x = out.home + out.draw;
    out.dc_x2 = out.draw + out.away;
    out.dc_12 = out.home + out.away;
  }
  return out;
}

/** Grupo de pesos que gobierna cada selección. */
export function weightGroupFor(selection) {
  if (selection.startsWith('over') || selection.startsWith('under')) return 'over_under';
  if (selection.startsWith('btts')) return 'btts';
  return '1x2'; // 1X2, doble oportunidad y hándicap asiático (diferencia de goles)
}

/**
 * Peso w ∈ [0, 1] de la mezcla. Se busca el mínimo de log-loss y, como la curva
 * suele ser casi plana cerca del óptimo, se elige el MAYOR peso cuya log-loss
 * queda a menos de `tolerance` nats del mínimo (regla de tolerancia): el modelo
 * conserva voz sin empeorar de forma apreciable la predicción.
 * @param {Array<{model:object, market:object, outcome:string}>} rows outcome = clave ganadora
 */
export function fitWeight(rows, keys, { step = 0.05, tolerance = 0.001 } = {}) {
  const usable = rows.filter(r => keys.every(k => r.model?.[k] > 0 && r.market?.[k] > 0) && keys.includes(r.outcome));
  if (usable.length < 100) return { weight: DEFAULT_MODEL_WEIGHT, samples: usable.length, fitted: false };
  let best = { weight: DEFAULT_MODEL_WEIGHT, logLoss: Infinity };
  const grid = [];
  for (let w = 0; w <= 1 + 1e-9; w += step) grid.push(Number(w.toFixed(2)));
  for (const w of grid) {
    let ll = 0;
    for (const r of usable) ll -= Math.log(clamp(poolVector(r.model, r.market, w, keys)[r.outcome]));
    ll /= usable.length;
    if (ll < best.logLoss) best = { weight: w, logLoss: ll };
  }
  const ll = w => usable.reduce((s, r) => s - Math.log(clamp(poolVector(r.model, r.market, w, keys)[r.outcome])), 0) / usable.length;
  let chosen = best.weight;
  for (const w of grid) if (w > chosen && ll(w) <= best.logLoss + tolerance) chosen = w;
  return {
    weight: chosen,
    optimumWeight: best.weight,
    tolerance,
    samples: usable.length,
    fitted: true,
    logLoss: Number(ll(chosen).toFixed(4)),
    logLossOptimum: Number(best.logLoss.toFixed(4)),
    logLossMarketOnly: Number(ll(0).toFixed(4)),
    logLossModelOnly: Number(ll(1).toFixed(4))
  };
}

/* ---------- Pesos de producción ---------- */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WEIGHTS_FILE = path.resolve(__dirname, '..', '..', 'data', 'blend-weights.json');

export function loadBlendWeights(file = WEIGHTS_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { competitions: {} }; }
}

/**
 * Resolver de pesos por competición.
 * @param {{enabled?: boolean, modelWeight?: number|null, data?: object}} opts
 *   enabled=false → peso 1 (solo modelo, comportamiento v10.0)
 *   modelWeight   → fuerza un peso global (BLEND_MODEL_WEIGHT)
 */
export function createBlendResolver({ enabled = true, modelWeight = null, data = null } = {}) {
  const file = data || loadBlendWeights();
  function weightsFor(slug) {
    if (!enabled) return { '1x2': 1, over_under: 1, btts: 1, source: 'mezcla desactivada (solo modelo)' };
    if (Number.isFinite(modelWeight)) {
      const w = Math.min(1, Math.max(0, modelWeight));
      return { '1x2': w, over_under: w, btts: w, source: 'BLEND_MODEL_WEIGHT' };
    }
    const c = file.competitions?.[slug];
    if (!c) return { '1x2': DEFAULT_MODEL_WEIGHT, over_under: DEFAULT_MODEL_WEIGHT, btts: DEFAULT_MODEL_WEIGHT, source: 'por defecto' };
    return { '1x2': c['1x2'], over_under: c.over_under, btts: c.btts, source: c.source };
  }
  function summary() {
    return {
      enabled,
      override: Number.isFinite(modelWeight) ? modelWeight : null,
      competitions: Object.fromEntries(['la_liga', 'champions_league'].map(s => [s, weightsFor(s)]))
    };
  }
  return { weightsFor, summary };
}
