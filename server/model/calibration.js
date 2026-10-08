/**
 * Calibración de probabilidades por competición y mercado.
 *
 * Mapas: la_liga_1x2, la_liga_over_under, la_liga_btts,
 *        champions_league_1x2, champions_league_over_under, champions_league_btts
 *
 * Los datos se guardan agregados en 100 cubetas de 1 punto porcentual
 * ({ n, wins } por cubeta). Así el histórico del backtest (semilla) y las
 * predicciones reales ya resueltas se combinan sin guardar millones de filas.
 *
 * Método:
 *   - Regresión isotónica (Pool Adjacent Violators) con ≥ ISOTONIC_MIN muestras.
 *   - Platt scaling (regresión logística sobre logit(p)) con menos muestras.
 *   - Identidad si no hay muestras suficientes (MIN_SAMPLES).
 */

export const CALIBRATION_GROUPS = ['1x2', 'over_under', 'btts'];
export const BINS = 100;
export const MIN_SAMPLES = 150;
export const ISOTONIC_MIN = 600;
/** Cada bloque isotónico debe tener al menos estas muestras (evita escalones con 3 partidos). */
export const MIN_BLOCK = 40;

export function mapKey(slug, group) {
  return `${slug}_${group}`;
}

export function emptyBins() {
  return { n: new Array(BINS).fill(0), wins: new Array(BINS).fill(0) };
}

export function binIndex(p) {
  return Math.max(0, Math.min(BINS - 1, Math.floor(Number(p) * BINS)));
}

/** Añade una observación (probabilidad original del modelo, ¿acertó?). */
export function addObservation(bins, p, hit, weight = 1) {
  if (!Number.isFinite(Number(p))) return bins;
  const i = binIndex(p);
  bins.n[i] += weight;
  if (hit) bins.wins[i] += weight;
  return bins;
}

export function mergeBins(...list) {
  const out = emptyBins();
  for (const b of list) {
    if (!b) continue;
    for (let i = 0; i < BINS; i++) {
      out.n[i] += Number(b.n?.[i]) || 0;
      out.wins[i] += Number(b.wins?.[i]) || 0;
    }
  }
  return out;
}

export function totalSamples(bins) {
  return bins ? bins.n.reduce((a, b) => a + b, 0) : 0;
}

/** Pool Adjacent Violators sobre cubetas ponderadas. */
export function fitIsotonic(bins, { minBlock = MIN_BLOCK } = {}) {
  // Bloques iniciales: cubetas no vacías
  let blocks = [];
  for (let i = 0; i < BINS; i++) {
    if (!bins.n[i]) continue;
    blocks.push({ lo: i, hi: i, n: bins.n[i], wins: bins.wins[i], pSum: bins.n[i] * ((i + 0.5) / BINS) });
  }
  if (!blocks.length) return null;

  // 1) Fusionar bloques pequeños con su vecino para estabilizar
  const merged = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.n < minBlock) {
      last.hi = b.hi; last.n += b.n; last.wins += b.wins; last.pSum += b.pSum;
    } else merged.push({ ...b });
  }
  if (merged.length > 1 && merged[merged.length - 1].n < minBlock) {
    const tail = merged.pop();
    const prev = merged[merged.length - 1];
    prev.hi = tail.hi; prev.n += tail.n; prev.wins += tail.wins; prev.pSum += tail.pSum;
  }
  blocks = merged;

  // 2) PAV: forzar monotonía creciente de la tasa observada
  const stack = [];
  for (const b of blocks) {
    stack.push({ ...b });
    while (stack.length > 1) {
      const a = stack[stack.length - 2];
      const c = stack[stack.length - 1];
      if (a.wins / a.n <= c.wins / c.n) break;
      stack.splice(stack.length - 2, 2, { lo: a.lo, hi: c.hi, n: a.n + c.n, wins: a.wins + c.wins, pSum: a.pSum + c.pSum });
    }
  }

  return stack.map(b => ({
    pMin: b.lo / BINS,
    pMax: (b.hi + 1) / BINS,
    pMean: b.pSum / b.n,
    rate: b.wins / b.n,
    n: b.n
  }));
}

/** Interpolación lineal entre los centros de los bloques isotónicos. */
export function applyIsotonic(blocks, p) {
  if (!blocks?.length) return p;
  const knots = blocks.map(b => ({ x: b.pMean, y: b.rate }));
  if (p <= knots[0].x) return clampP(knots[0].y + (p - knots[0].x)); // pendiente 1 fuera del rango
  const last = knots[knots.length - 1];
  if (p >= last.x) return clampP(last.y + (p - last.x));
  for (let i = 1; i < knots.length; i++) {
    if (p <= knots[i].x) {
      const a = knots[i - 1], b = knots[i];
      const t = (p - a.x) / Math.max(1e-9, b.x - a.x);
      return clampP(a.y + t * (b.y - a.y));
    }
  }
  return p;
}

function clampP(p) {
  return Math.max(0.01, Math.min(0.99, p));
}

const logit = p => Math.log(p / (1 - p));
const sigmoid = z => 1 / (1 + Math.exp(-z));

/** Platt scaling: p' = σ(a · logit(p) + b), ajustado por Newton-Raphson. */
export function fitPlatt(bins, { iterations = 50 } = {}) {
  let a = 1, b = 0;
  for (let it = 0; it < iterations; it++) {
    let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
    for (let i = 0; i < BINS; i++) {
      const n = bins.n[i];
      if (!n) continue;
      const x = logit(Math.min(0.995, Math.max(0.005, (i + 0.5) / BINS)));
      const q = sigmoid(a * x + b);
      const y = bins.wins[i];
      ga += (y - n * q) * x;
      gb += (y - n * q);
      const w = n * q * (1 - q);
      haa += w * x * x; hab += w * x; hbb += w;
    }
    // Pequeña regularización hacia la identidad (a=1, b=0)
    const lam = 2;
    ga -= lam * (a - 1); gb -= lam * b; haa += lam; hbb += lam;
    const det = haa * hbb - hab * hab;
    if (!(Math.abs(det) > 1e-12)) break;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    a += da; b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-8) break;
  }
  return { a, b };
}

export function applyPlatt({ a, b }, p) {
  return clampP(sigmoid(a * logit(Math.min(0.995, Math.max(0.005, p))) + b));
}

/** Ajusta el mapa elegido según el tamaño de muestra. */
export function fitCalibration(bins, { method = 'auto' } = {}) {
  const n = totalSamples(bins);
  if (n < MIN_SAMPLES) return { method: 'identity', samples: n, fittedAt: new Date().toISOString() };
  const useIso = method === 'isotonic' || (method === 'auto' && n >= ISOTONIC_MIN);
  if (useIso) {
    return { method: 'isotonic', samples: n, blocks: fitIsotonic(bins), fittedAt: new Date().toISOString() };
  }
  return { method: 'platt', samples: n, platt: fitPlatt(bins), fittedAt: new Date().toISOString() };
}

export function applyCalibration(map, p) {
  if (p == null || !Number.isFinite(p)) return p;
  if (!map || map.method === 'identity') return p;
  if (map.method === 'isotonic') return applyIsotonic(map.blocks, p);
  if (map.method === 'platt') return applyPlatt(map.platt, p);
  return p;
}

/** Tasa histórica de acierto en el rango de 10 puntos que contiene p. */
export function rangeStats(bins, p) {
  if (!bins || !Number.isFinite(p)) return null;
  const lo = Math.floor(p * 10) / 10;
  const hi = lo + 0.1;
  let n = 0, wins = 0;
  for (let i = Math.round(lo * BINS); i < Math.round(hi * BINS) && i < BINS; i++) {
    n += bins.n[i]; wins += bins.wins[i];
  }
  return {
    range: `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`,
    samples: n,
    hitRate: n ? wins / n : null
  };
}

/** Texto explicativo para la app. */
export function calibrationMessage(raw, calibrated, stats) {
  const pct = x => `${Math.round(x * 100)}%`;
  if (!Number.isFinite(raw)) return null;
  if (!stats || !stats.samples || stats.hitRate == null) {
    return `El modelo dijo ${pct(raw)}; aún no hay suficiente historial en ese rango, se usa sin calibrar.`;
  }
  return `El modelo dijo ${pct(raw)}, pero en ese rango ha ganado ${pct(stats.hitRate)} históricamente (${Math.round(stats.samples)} casos); probabilidad calibrada: ${pct(calibrated)}.`;
}

/**
 * Calibra un vector de probabilidades de un mercado y renormaliza para que
 * sume 1 (1X2: 3 resultados; O/U y BTTS: 2).
 */
export function calibrateVector(map, probs) {
  const keys = Object.keys(probs).filter(k => Number.isFinite(probs[k]));
  if (!keys.length) return { ...probs };
  const cal = Object.fromEntries(keys.map(k => [k, applyCalibration(map, probs[k])]));
  const s = keys.reduce((acc, k) => acc + cal[k], 0);
  if (s > 0) for (const k of keys) cal[k] /= s;
  return cal;
}
