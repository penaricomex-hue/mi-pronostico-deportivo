/**
 * Calibración de probabilidades por competición y mercado.
 *
 *   < 50 muestras    → sin calibrar (identidad), se indica "muestra insuficiente"
 *   50–299 muestras  → Platt scaling (regresión logística sobre logit(p))
 *   ≥ 300 muestras   → regresión isotónica (Pool Adjacent Violators)
 *
 * Así el modelo aprende de sus errores sin inventar confianza: si en el rango
 * 60–70 % solo ha acertado el 61 %, la probabilidad calibrada baja a ~61 %.
 */

export const CALIBRATION_KEYS = [
  'la_liga_1x2', 'la_liga_over_under', 'la_liga_btts', 'la_liga_double_chance', 'la_liga_asian_handicap',
  'champions_league_1x2', 'champions_league_over_under', 'champions_league_btts', 'champions_league_double_chance', 'champions_league_asian_handicap'
];

export const MIN_SAMPLES_PLATT = 50;
export const MIN_SAMPLES_ISOTONIC = 300;
const EPS = 1e-4;

export function calibrationKey(competitionSlug, group) {
  return `${competitionSlug}_${group}`;
}

const clampP = p => Math.min(1 - EPS, Math.max(EPS, p));
const logit = p => Math.log(clampP(p) / (1 - clampP(p)));
const sigmoid = z => 1 / (1 + Math.exp(-z));

/**
 * Regresión isotónica (PAV) robusta.
 * - Fusiona bloques adyacentes hasta que cada uno tenga al menos `minBlock` casos
 *   (los extremos con pocos datos no generan saltos bruscos).
 * - Encoge la tasa de cada bloque hacia la probabilidad media del modelo con
 *   un prior de `prior` casos virtuales.
 * Devuelve bloques {x0, x1, xm, y, n} ordenados.
 */
export function fitIsotonic(samples, { minBlock = 40, prior = 20 } = {}) {
  const pts = samples.map(s => ({ x: s.p, y: s.y ? 1 : 0 })).sort((a, b) => a.x - b.x);
  const merge = (a, b) => ({ x0: a.x0, x1: b.x1, sum: a.sum + b.sum, sumX: a.sumX + b.sumX, n: a.n + b.n });
  let blocks = [];
  for (const p of pts) {
    const top = blocks[blocks.length - 1];
    if (top && top.x1 === p.x && top.x0 === p.x) {
      // Empates en x: se agrupan antes del PAV
      top.sum += p.y; top.sumX += p.x; top.n++;
    } else {
      blocks.push({ x0: p.x, x1: p.x, sum: p.y, sumX: p.x, n: 1 });
    }
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.n <= b.sum / b.n) break;
      blocks.splice(blocks.length - 2, 2, merge(a, b));
    }
  }
  // Fusionar bloques pequeños con su vecino (la media ponderada conserva la monotonía)
  let changed = true;
  while (changed && blocks.length > 1) {
    changed = false;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].n >= minBlock) continue;
      const j = i === 0 ? 1 : i === blocks.length - 1 ? i - 1 : (blocks[i - 1].n <= blocks[i + 1].n ? i - 1 : i + 1);
      const [lo, hi] = i < j ? [i, j] : [j, i];
      blocks.splice(lo, 2, merge(blocks[lo], blocks[hi]));
      changed = true;
      break;
    }
  }
  return blocks.map(b => {
    const xm = b.sumX / b.n;
    return { x0: b.x0, x1: b.x1, xm, y: (b.sum + prior * xm) / (b.n + prior), n: b.n };
  });
}

/** Interpolación lineal entre los centros de los bloques; plano fuera de los extremos. */
export function applyIsotonic(blocks, p) {
  if (!blocks?.length) return p;
  const pts = blocks.map(b => ({ x: b.xm ?? (b.x0 + b.x1) / 2, y: b.y }));
  if (p <= pts[0].x) return pts[0].y;
  const last = pts[pts.length - 1];
  if (p >= last.x) return last.y;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (p >= a.x && p <= b.x) {
      const t = b.x > a.x ? (p - a.x) / (b.x - a.x) : 0;
      return a.y + t * (b.y - a.y);
    }
  }
  return p;
}

/** Platt scaling: y ≈ σ(a·logit(p) + b), ajustado por Newton-Raphson. */
export function fitPlatt(samples, { iterations = 50 } = {}) {
  let a = 1, b = 0;
  const xs = samples.map(s => logit(s.p));
  const ys = samples.map(s => (s.y ? 1 : 0));
  for (let it = 0; it < iterations; it++) {
    let gA = 0, gB = 0, hAA = 0, hAB = 0, hBB = 0;
    for (let i = 0; i < xs.length; i++) {
      const q = sigmoid(a * xs[i] + b);
      const d = q - ys[i];
      const w = q * (1 - q);
      gA += d * xs[i]; gB += d;
      hAA += w * xs[i] * xs[i]; hAB += w * xs[i]; hBB += w;
    }
    // Pequeña regularización para estabilidad
    hAA += 1e-6; hBB += 1e-6;
    const det = hAA * hBB - hAB * hAB;
    if (Math.abs(det) < 1e-12) break;
    const dA = (hBB * gA - hAB * gB) / det;
    const dB = (hAA * gB - hAB * gA) / det;
    a -= dA; b -= dB;
    if (Math.abs(dA) < 1e-8 && Math.abs(dB) < 1e-8) break;
  }
  return { a, b };
}

export function applyPlatt(params, p) {
  return sigmoid(params.a * logit(p) + params.b);
}

/** Tasa de acierto histórica por rangos de 10 pts (para explicar la calibración). */
export function binStats(samples, width = 0.1) {
  const bins = new Map();
  for (const s of samples) {
    const i = Math.min(Math.floor(s.p / width), Math.round(1 / width) - 1);
    if (!bins.has(i)) bins.set(i, { lo: i * width, hi: (i + 1) * width, n: 0, wins: 0, sumP: 0 });
    const b = bins.get(i);
    b.n++; b.sumP += s.p; if (s.y) b.wins++;
  }
  return [...bins.values()].sort((a, b) => a.lo - b.lo).map(b => ({
    range: `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`,
    lo: Number(b.lo.toFixed(2)),
    hi: Number(b.hi.toFixed(2)),
    n: b.n,
    predictedPct: Number(((100 * b.sumP) / b.n).toFixed(1)),
    actualPct: Number(((100 * b.wins) / b.n).toFixed(1))
  }));
}

/**
 * Ajusta un calibrador.
 * @param {Array<{p:number, y:boolean}>} samples
 */
export function fitCalibrator(key, samples, { fittedAt = new Date().toISOString(), source = 'mixed' } = {}) {
  const clean = samples.filter(s => Number.isFinite(s.p) && s.p > 0 && s.p < 1);
  const n = clean.length;
  const base = { key, n, fittedAt, source, bins: binStats(clean) };
  if (n < MIN_SAMPLES_PLATT) return { ...base, method: 'identity' };
  if (n < MIN_SAMPLES_ISOTONIC) return { ...base, method: 'platt', platt: fitPlatt(clean) };
  return { ...base, method: 'isotonic', isotonic: fitIsotonic(clean) };
}

export function applyCalibrator(cal, p) {
  if (p == null || !Number.isFinite(p)) return p;
  if (!cal || cal.method === 'identity') return p;
  const q = cal.method === 'platt' ? applyPlatt(cal.platt, p) : applyIsotonic(cal.isotonic, p);
  return clampP(q);
}

/** Texto para la app: “El modelo dijo 68 %, pero en ese rango ha ganado 61 % …”. */
export function explainCalibration(cal, rawP) {
  if (rawP == null) return null;
  const calibrated = applyCalibrator(cal, rawP);
  const pct = x => `${Math.round(x * 100)}%`;
  if (!cal || cal.method === 'identity') {
    return {
      raw: rawP, calibrated, method: 'identity', sample: cal?.n ?? 0, bin: null,
      text: `El modelo dijo ${pct(rawP)}. Aún no hay muestra suficiente (${cal?.n ?? 0} de ${MIN_SAMPLES_PLATT}) para calibrar este mercado; se usa la probabilidad original.`
    };
  }
  const bin = cal.bins.find(b => rawP >= b.lo && rawP < b.hi + 1e-9) || null;
  const hist = bin && bin.n >= 15 ? `en ese rango (${bin.range}) ha ganado ${Math.round(bin.actualPct)}% históricamente (${bin.n} casos)` : 'en ese rango aún hay pocos casos';
  const conj = calibrated < rawP - 0.005 ? 'pero' : 'y';
  return {
    raw: rawP, calibrated, method: cal.method, sample: cal.n, bin,
    text: `El modelo dijo ${pct(rawP)}, ${conj} ${hist}; probabilidad calibrada: ${pct(calibrated)}.`
  };
}
