/**
 * Intervalos de confianza al 95% para el panel de rendimiento.
 * Con pocas señales el azar domina: un ROI de +5% con 100 apuestas a cuota ~2
 * es perfectamente compatible con no tener ninguna ventaja.
 */
const Z = 1.96;
const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

/** Media e intervalo normal (t≈z para n ≥ 30) de una lista de valores. */
export function meanCI(values, { scale = 1, digits = 2 } = {}) {
  const v = values.filter(Number.isFinite);
  const n = v.length;
  if (!n) return { n: 0, mean: null, lo: null, hi: null, se: null };
  const mean = v.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean: r(mean * scale, digits), lo: null, hi: null, se: null };
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean: r(mean * scale, digits), lo: r((mean - Z * se) * scale, digits), hi: r((mean + Z * se) * scale, digits), se: r(se * scale, digits + 2) };
}

/** Intervalo de Wilson para una proporción (tasa de acierto, % CLV+). */
export function wilsonCI(k, n, { scale = 100, digits = 1 } = {}) {
  if (!n) return { n: 0, pct: null, lo: null, hi: null };
  const p = k / n;
  const den = 1 + (Z * Z) / n;
  const center = (p + (Z * Z) / (2 * n)) / den;
  const half = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / den;
  return { n, pct: r(p * scale, digits), lo: r((center - half) * scale, digits), hi: r((center + half) * scale, digits) };
}

export const REVIEW_SAMPLE = 300;
export const MIN_SAMPLE = 30;

/**
 * Veredicto sobre el CLV medio (la métrica que decide si hay ventaja).
 * Regla de parada: al llegar a 300 señales con CLV, si el intervalo no está
 * claramente por encima de 0, se cambia el enfoque en lugar de seguir esperando.
 * @param {{n:number, mean:number, lo:number, hi:number}} ci CLV en %
 */
export function clvVerdict(ci, { reviewAt = REVIEW_SAMPLE, minSample = MIN_SAMPLE } = {}) {
  const n = ci?.n || 0;
  const remaining = Math.max(0, reviewAt - n);
  if (n < minSample || ci.lo == null) {
    return { level: 'insufficient', title: 'Muestra insuficiente', text: `Con ${n} señales con cuota de cierre todavía no se puede concluir nada (mínimo ${minSample}). Faltan ${remaining} para la revisión de ${reviewAt}.`, remaining };
  }
  if (ci.lo > 0) {
    return { level: 'positive', title: 'Ventaja detectada', text: `CLV positivo con 95% de confianza (${ci.lo}% a ${ci.hi}%). Las señales toman cuotas mejores que las de cierre de forma consistente.`, remaining };
  }
  if (ci.hi < 0) {
    return n >= 100
      ? { level: 'negative', title: 'Sin ventaja', text: `CLV negativo con 95% de confianza (${ci.lo}% a ${ci.hi}%) en ${n} señales. Hay que cambiar el enfoque (mercados, umbral, momento de la señal o modelo).`, remaining }
      : { level: 'warning', title: 'Señal de alerta', text: `CLV negativo con 95% de confianza (${ci.lo}% a ${ci.hi}%), aunque con solo ${n} señales. Si se mantiene a las 100, hay que cambiar el enfoque.`, remaining };
  }
  if (n >= reviewAt) {
    return { level: 'review', title: 'Revisar el enfoque', text: `${n} señales y el CLV sigue sin ser claramente positivo (${ci.lo}% a ${ci.hi}%). Según la regla de parada, no hay evidencia de ventaja: cambiar el enfoque.`, remaining: 0 };
  }
  return { level: 'inconclusive', title: 'No concluyente todavía', text: `El intervalo del CLV (${ci.lo}% a ${ci.hi}%) incluye 0. Faltan ${remaining} señales para la revisión de ${reviewAt}.`, remaining };
}
