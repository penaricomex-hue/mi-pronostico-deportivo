function poisson(k, lambda) {
  let fact = 1;
  for (let i = 2; i <= k; i++) fact *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / fact;
}

function matchModel(homeXg, awayXg) {
  let homeWin = 0, draw = 0, awayWin = 0, over25 = 0, btts = 0;
  for (let h = 0; h <= 8; h++) for (let a = 0; a <= 8; a++) {
    const p = poisson(h, homeXg) * poisson(a, awayXg);
    if (h > a) homeWin += p;
    else if (h === a) draw += p;
    else awayWin += p;
    if (h + a >= 3) over25 += p;
    if (h >= 1 && a >= 1) btts += p;
  }
  return { homeWin, draw, awayWin, over25, btts };
}

function pct(x) { return Math.round(x * 1000) / 10; }

module.exports = { matchModel, pct };
