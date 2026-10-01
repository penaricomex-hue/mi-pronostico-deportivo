/**
 * MK Bets - Motor Estadístico de Modelado de Fútbol
 * Versión V8.0.4 (Núcleo Canónico Unificado con Corrección Dixon-Coles)
 * 
 * Basado en:
 * - Dixon, M. J., & Coles, S. G. (1997). Modelling Association Football Scores
 *   and Inefficiencies in the Football Betting Market. Applied Statistics, 46(2), 265-280.
 */

export const ENGINE_VERSION = '8.0.4';
export const DIXON_COLES_RHO = -0.11; // Parámetro canónico empírico de correlación de bajas anotaciones

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function shrinkToMean(value: number, baseline: number, sampleSize: number = 10): number {
  const n = Math.max(0, Number(sampleSize) || 0);
  const m = 4;
  const weight = n / (n + m);
  return weight * Number(value) + (1 - weight) * Number(baseline);
}

export function implied(odds: number): number | null {
  const o = Number(odds);
  if (!Number.isFinite(o) || o <= 1) return null;
  return Number(((1 / o) * 100).toFixed(1));
}

export function ev(probability: number, odds: number): number | null {
  let p = Number(probability);
  const o = Number(odds);
  if (!Number.isFinite(p) || !Number.isFinite(o) || o <= 1) return null;
  if (p > 1) p = p / 100;
  return Number(((p * o - 1) * 100).toFixed(1));
}

/**
 * Model Signal (Índice de Fuerza del Modelo): Puntuación analítica heurística (20-95).
 * NOTA DE RIGOR ANALÍTICO: No representa una probabilidad porcentual de acierto calibrada,
 * sino la convicción del modelo en función del edge detectado y la robustez muestral.
 */
export function modelSignal(bestProbability: number, sampleSize: number = 10): number {
  let prob = Number(bestProbability);
  if (!Number.isFinite(prob)) return 50;
  if (prob > 1) prob = prob / 100;

  const n = clamp(Number(sampleSize) || 0, 0, 15);
  const sampleFactor = clamp(n / 10, 0.4, 1.0);

  const edge = Math.max(0, prob - 0.333);
  const rawScore = 35 + (edge / 0.45) * 55;

  const finalScore = rawScore * sampleFactor;
  return Math.round(clamp(finalScore, 20, 95));
}

export const confidence = modelSignal;

export function poisson(k: number, lambda: number): number {
  if (lambda <= 0 || k < 0) return 0;
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial;
}

/**
 * Factor tau de correlación bivariada de Dixon-Coles (1997)
 */
export function dixonColesTau(x: number, y: number, lambda: number, mu: number, rho: number = DIXON_COLES_RHO): number {
  if (x === 0 && y === 0) {
    return Math.max(0, 1 - (lambda * mu * rho));
  } else if (x === 0 && y === 1) {
    return Math.max(0, 1 + (lambda * rho));
  } else if (x === 1 && y === 0) {
    return Math.max(0, 1 + (mu * rho));
  } else if (x === 1 && y === 1) {
    return Math.max(0, 1 - rho);
  }
  return 1.0;
}

export interface MatchModelOutput {
  engineVersion: string;
  modelName: string;
  homeXg: number;
  awayXg: number;
  rho: number;
  homeWin: number;
  draw: number;
  awayWin: number;
  over25: number;
  under25: number;
  btts: number;
  scoreMatrix?: number[][];
}

/**
 * Modelo de partido con Dixon-Coles
 */
export function matchModel(homeXg: number, awayXg: number, rho: number = DIXON_COLES_RHO): MatchModelOutput {
  const lambda = Math.max(0.15, Number(homeXg) || 1.35);
  const mu = Math.max(0.15, Number(awayXg) || 1.15);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let under25 = 0;
  let btts = 0;

  const maxGoals = 8;
  const scoreMatrix: number[][] = [];

  for (let h = 0; h <= maxGoals; h++) {
    scoreMatrix[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const pIndep = poisson(h, lambda) * poisson(a, mu);
      const tau = dixonColesTau(h, a, lambda, mu, rho);
      const p = Math.max(0, pIndep * tau);

      scoreMatrix[h][a] = p;

      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;

      if (h + a >= 3) over25 += p;
      else under25 += p;

      if (h >= 1 && a >= 1) btts += p;
    }
  }

  const sum1x2 = homeWin + draw + awayWin;
  if (sum1x2 > 0) {
    homeWin /= sum1x2;
    draw /= sum1x2;
    awayWin /= sum1x2;
  }

  const sumGoals = over25 + under25;
  if (sumGoals > 0) {
    over25 /= sumGoals;
    under25 /= sumGoals;
  }

  btts = clamp(btts, 0.05, 0.95);

  return {
    engineVersion: ENGINE_VERSION,
    modelName: 'Dixon-Coles Bivariate Poisson (V8.0.4)',
    homeXg: lambda,
    awayXg: mu,
    rho,
    homeWin,
    draw,
    awayWin,
    over25,
    under25,
    btts,
    scoreMatrix
  };
}
