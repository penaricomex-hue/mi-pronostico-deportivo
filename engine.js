function poisson(k, lambda) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}

function matchModel(homeXg, awayXg) {
  let homeWin = 0, draw = 0, awayWin = 0, over25 = 0, under25 = 0, btts = 0;
  for (let h = 0; h <= 10; h++) for (let a = 0; a <= 10; a++) {
    const p = poisson(h, homeXg) * poisson(a, awayXg);
    if (h > a) homeWin += p;
    else if (h === a) draw += p;
    else awayWin += p;
    if (h + a >= 3) over25 += p; else under25 += p;
    if (h >= 1 && a >= 1) btts += p;
  }
  return { homeWin, draw, awayWin, over25, under25, btts };
}

function pct(x) { return Math.round(x * 1000) / 10; }
function clamp(x, min, max) { return Math.min(max, Math.max(min, x)); }

function implied(decimalOdds) {
  if (!decimalOdds || decimalOdds <= 1) return null;
  return 1 / decimalOdds;
}

function ev(probability, decimalOdds) {
  if (probability == null || !decimalOdds || decimalOdds <= 1) return null;
  return probability * decimalOdds - 1;
}

function confidence(probability, sampleSize, edge = 0) {
  const base = Math.abs(probability - 0.5) * 100;
  const sample = clamp((sampleSize / 10) * 20, 0, 20);
  const value = clamp(50 + base * 0.55 + sample + Math.max(0, edge * 100) * 0.25, 0, 99);
  return Math.round(value);
}

module.exports = { matchModel, pct, implied, ev, confidence };
