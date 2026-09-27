/**
 * MK Bets - Motor Estadístico de Modelado de Fútbol (engine.js)
 * Versión V7.16.2
 */

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function shrinkToMean(value, baseline, sampleSize = 10) {
  const n = Math.max(0, Number(sampleSize) || 0);
  const m = 4; // pseudo-observaciones de regresión a la media
  const weight = n / (n + m);
  return weight * Number(value) + (1 - weight) * Number(baseline);
}

function implied(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o <= 1) return null;
  return Number(((1 / o) * 100).toFixed(1));
}

function ev(probability, odds) {
  let p = Number(probability);
  const o = Number(odds);
  if (!Number.isFinite(p) || !Number.isFinite(o) || o <= 1) return null;
  if (p > 1) p = p / 100;
  return Number(((p * o - 1) * 100).toFixed(1));
}

function confidence(bestProbability, sampleSize = 10) {
  let prob = Number(bestProbability);
  if (!Number.isFinite(prob)) return 50;
  if (prob > 1) prob = prob / 100;

  const n = clamp(Number(sampleSize) || 0, 0, 15);
  const sampleFactor = clamp(n / 10, 0.4, 1.0);

  // Probabilidad base sobre 1/3 (0.333)
  const edge = Math.max(0, prob - 0.333);
  const rawScore = 35 + (edge / 0.45) * 55;

  const finalScore = rawScore * sampleFactor;
  return Math.round(clamp(finalScore, 20, 95));
}

function poisson(k, lambda) {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial;
}

function matchModel(homeXg, awayXg) {
  const hXg = Math.max(0.1, Number(homeXg) || 1.3);
  const aXg = Math.max(0.1, Number(awayXg) || 1.1);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over25 = 0;
  let under25 = 0;
  let btts = 0;

  const maxGoals = 8;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poisson(h, hXg) * poisson(a, aXg);

      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;

      if (h + a >= 3) over25 += p;
      else under25 += p;

      if (h >= 1 && a >= 1) btts += p;
    }
  }

  // Normalizar 1X2 para que sume exactamente 1.0
  const sum1x2 = homeWin + draw + awayWin;
  if (sum1x2 > 0) {
    homeWin /= sum1x2;
    draw /= sum1x2;
    awayWin /= sum1x2;
  }

  return {
    homeWin,
    draw,
    awayWin,
    over25,
    under25,
    btts
  };
}

module.exports = {
  clamp,
  shrinkToMean,
  implied,
  ev,
  confidence,
  matchModel
};
