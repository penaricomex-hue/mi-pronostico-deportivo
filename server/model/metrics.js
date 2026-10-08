/**
 * Métricas de evaluación probabilística.
 * Las referencias siempre son: azar uniforme y mercado (cuotas sin margen).
 */

const OUTCOMES = ['home', 'draw', 'away'];

export function outcomeOf(hg, ag) {
  return hg > ag ? 'home' : hg === ag ? 'draw' : 'away';
}

export function brier1x2(p, outcome) {
  return OUTCOMES.reduce((s, k) => s + (p[k] - (k === outcome ? 1 : 0)) ** 2, 0);
}

export function logLoss1x2(p, outcome) {
  return -Math.log(Math.max(1e-6, p[outcome]));
}

/** Ranked Probability Score para 1X2 (resultados ordenados). */
export function rps1x2(p, outcome) {
  const y = OUTCOMES.map(k => (k === outcome ? 1 : 0));
  const pv = OUTCOMES.map(k => p[k]);
  let cumP = 0, cumY = 0, s = 0;
  for (let i = 0; i < 2; i++) {
    cumP += pv[i];
    cumY += y[i];
    s += (cumP - cumY) ** 2;
  }
  return s / 2;
}

export function brierBinary(p, hit) {
  return (p - (hit ? 1 : 0)) ** 2;
}

export function logLossBinary(p, hit) {
  return -Math.log(Math.max(1e-6, hit ? p : 1 - p));
}

export const UNIFORM_1X2 = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };

/** Acumulador de métricas 1X2 + O/U 2.5 */
export function createScorer() {
  const s = { n: 0, brier: 0, logLoss: 0, rps: 0, hits: 0, nOU: 0, brierOU: 0, logLossOU: 0 };
  return {
    add(p1x2, outcome, pOver = null, isOver = null) {
      if (p1x2) {
        s.n++;
        s.brier += brier1x2(p1x2, outcome);
        s.logLoss += logLoss1x2(p1x2, outcome);
        s.rps += rps1x2(p1x2, outcome);
        const pick = OUTCOMES.reduce((a, b) => (p1x2[b] > p1x2[a] ? b : a), 'home');
        if (pick === outcome) s.hits++;
      }
      if (pOver != null && isOver != null) {
        s.nOU++;
        s.brierOU += brierBinary(pOver, isOver);
        s.logLossOU += logLossBinary(pOver, isOver);
      }
    },
    result() {
      const r = (x, n) => (n ? Number((x / n).toFixed(4)) : null);
      return {
        matches: s.n,
        brier: r(s.brier, s.n),
        logLoss: r(s.logLoss, s.n),
        rps: r(s.rps, s.n),
        accuracyPct: s.n ? Number(((100 * s.hits) / s.n).toFixed(1)) : null,
        brierOU: r(s.brierOU, s.nOU),
        logLossOU: r(s.logLossOU, s.nOU)
      };
    }
  };
}

/** Calibración por resultado: agrupa predicciones en rangos de 10 pts. */
export function calibrationTable(records, bins = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1.0001]) {
  const out = [];
  for (const key of ['home', 'draw', 'away', 'over25']) {
    for (let i = 0; i < bins.length - 1; i++) {
      const lo = bins[i], hi = bins[i + 1];
      const sel = records.filter(r => r.p[key] != null && r.p[key] >= lo && r.p[key] < hi);
      if (sel.length < 10) continue;
      const predicted = sel.reduce((s, r) => s + r.p[key], 0) / sel.length;
      const actual = sel.filter(r => r.actual[key]).length / sel.length;
      out.push({
        outcome: key,
        range: `${Math.round(lo * 100)}-${Math.round(Math.min(hi, 1) * 100)}%`,
        matches: sel.length,
        predictedPct: Number((predicted * 100).toFixed(1)),
        actualPct: Number((actual * 100).toFixed(1)),
        gapPts: Number(((actual - predicted) * 100).toFixed(1))
      });
    }
  }
  return out;
}

/**
 * Etiqueta honesta: compara contra mercado y contra azar en lugar de usar
 * umbrales fijos.
 */
export function verdict(modelMetric, marketMetric, uniformMetric) {
  if (modelMetric == null) return 'Sin datos';
  if (uniformMetric != null && modelMetric >= uniformMetric) return 'Peor que el azar';
  if (marketMetric == null) return 'Mejor que el azar (sin referencia de mercado)';
  const diff = modelMetric - marketMetric;
  if (diff <= -0.002) return 'Mejor que el mercado';
  if (diff <= 0.002) return 'Igual que el mercado';
  return 'Peor que el mercado';
}
