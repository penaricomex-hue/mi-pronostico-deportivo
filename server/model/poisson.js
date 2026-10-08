/**
 * Distribución de marcadores Poisson bivariada con corrección Dixon-Coles (1997).
 *
 * Dixon, M. J., & Coles, S. G. (1997). Modelling Association Football Scores and
 * Inefficiencies in the Football Betting Market. Applied Statistics, 46(2), 265-280.
 */

export const MAX_GOALS = 10;

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function poissonPmf(k, lambda) {
  if (!(lambda > 0) || k < 0) return k === 0 && lambda === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/** Factor tau de Dixon-Coles para marcadores bajos. */
export function dixonColesTau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/** Matriz de probabilidades de marcador normalizada (suma 1). */
export function scoreMatrix(lambda, mu, rho = 0, maxGoals = MAX_GOALS) {
  const ph = [];
  const pa = [];
  for (let k = 0; k <= maxGoals; k++) {
    ph.push(poissonPmf(k, lambda));
    pa.push(poissonPmf(k, mu));
  }
  const matrix = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const p = Math.max(0, ph[h] * pa[a] * dixonColesTau(h, a, lambda, mu, rho));
      matrix[h][a] = p;
      total += p;
    }
  }
  if (total > 0) {
    for (let h = 0; h <= maxGoals; h++) {
      for (let a = 0; a <= maxGoals; a++) matrix[h][a] /= total;
    }
  }
  return matrix;
}

/** Probabilidades de los mercados principales a partir de la matriz. */
export function marketsFromMatrix(matrix) {
  let home = 0, draw = 0, away = 0, over25 = 0, btts = 0;
  let best = { home: 0, away: 0, probability: 0 };
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
      if (h + a >= 3) over25 += p;
      if (h >= 1 && a >= 1) btts += p;
      if (p > best.probability) best = { home: h, away: a, probability: p };
    }
  }
  return {
    home,
    draw,
    away,
    over25,
    under25: 1 - over25,
    btts,
    mostLikelyScore: best
  };
}

export function matchProbabilities(lambda, mu, rho = 0) {
  const matrix = scoreMatrix(lambda, mu, rho);
  return { lambda, mu, rho, ...marketsFromMatrix(matrix), matrix };
}
