/**
 * MK Bets - Motor Estadístico de Modelado de Fútbol
 * Versión V8.0.1 (Núcleo Canónico Unificado con Corrección Dixon-Coles)
 * 
 * Basado en:
 * - Dixon, M. J., & Coles, S. G. (1997). Modelling Association Football Scores
 *   and Inefficiencies in the Football Betting Market. Applied Statistics, 46(2), 265-280.
 */

export const ENGINE_VERSION = '8.0.1';
export const DIXON_COLES_RHO = -0.11; // Parámetro canónico empírico de correlación de bajas anotaciones

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function shrinkToMean(value, baseline, sampleSize = 10) {
  const n = Math.max(0, Number(sampleSize) || 0);
  const m = 4; // pseudo-observaciones de regresión a la media
  const weight = n / (n + m);
  return weight * Number(value) + (1 - weight) * Number(baseline);
}

export function implied(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o <= 1) return null;
  return Number(((1 / o) * 100).toFixed(1));
}

export function ev(probability, odds) {
  let p = Number(probability);
  const o = Number(odds);
  if (!Number.isFinite(p) || !Number.isFinite(o) || o <= 1) return null;
  if (p > 1) p = p / 100;
  return Number(((p * o - 1) * 100).toFixed(1));
}

export function confidence(bestProbability, sampleSize = 10) {
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

export function poisson(k, lambda) {
  if (lambda <= 0 || k < 0) return 0;
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial;
}

/**
 * Factor tau de correlación bivariada de Dixon-Coles (1997)
 * Corrige la sobrestimación o subestimación independiente en marcadores bajos (0 y 1 gol).
 */
export function dixonColesTau(x, y, lambda, mu, rho = DIXON_COLES_RHO) {
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

/**
 * Modelo de partido con Dixon-Coles
 * @param {number} homeXg Expectativa de goles del local (lambda)
 * @param {number} awayXg Expectativa de goles del visitante (mu)
 * @param {number} rho Parámetro de correlación (por defecto -0.11)
 * @returns {object} Probabilidades normalizadas (1X2, Over/Under 2.5, BTTS)
 */
export function matchModel(homeXg, awayXg, rho = DIXON_COLES_RHO) {
  const lambda = Math.max(0.15, Number(homeXg) || 1.35);
  const mu = Math.max(0.15, Number(awayXg) || 1.15);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let under25 = 0;
  let btts = 0;

  const maxGoals = 8;
  const scoreMatrix = [];

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

  // Normalizar 1X2 para que la suma total sea exactamente 1.0 (100%)
  const sum1x2 = homeWin + draw + awayWin;
  if (sum1x2 > 0) {
    homeWin /= sum1x2;
    draw /= sum1x2;
    awayWin /= sum1x2;
  }

  // Normalizar Over/Under 2.5
  const sumGoals = over25 + under25;
  if (sumGoals > 0) {
    over25 /= sumGoals;
    under25 /= sumGoals;
  }

  // Acotar BTTS a [0, 1]
  btts = clamp(btts, 0.05, 0.95);

  return {
    engineVersion: ENGINE_VERSION,
    modelName: 'Dixon-Coles Bivariate Poisson (V8.0.1)',
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

export default {
  ENGINE_VERSION,
  DIXON_COLES_RHO,
  clamp,
  shrinkToMean,
  implied,
  ev,
  confidence,
  poisson,
  dixonColesTau,
  matchModel
};
