function factorial(n) {
  if (n <= 1) return 1;

  let result = 1;

  for (let i = 2; i <= n; i++) {
    result *= i;
  }

  return result;
}

function poisson(k, lambda) {
  if (lambda <= 0) {
    return k === 0 ? 1 : 0;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial(k)
  );
}

/*
 * Corrección tipo Dixon-Coles.
 *
 * Mejora el tratamiento de marcadores de pocos goles,
 * especialmente 0-0, 1-0, 0-1 y 1-1.
 *
 * No garantiza resultados; solamente busca una distribución
 * más estable para el modelo.
 */
function lowScoreCorrection(homeGoals, awayGoals, homeXg, awayXg) {
  const rho = -0.08;

  if (homeGoals === 0 && awayGoals === 0) {
    return 1 - homeXg * awayXg * rho;
  }

  if (homeGoals === 0 && awayGoals === 1) {
    return 1 + homeXg * rho;
  }

  if (homeGoals === 1 && awayGoals === 0) {
    return 1 + awayXg * rho;
  }

  if (homeGoals === 1 && awayGoals === 1) {
    return 1 - rho;
  }

  return 1;
}

function matchModel(homeXg, awayXg) {
  homeXg = clamp(Number(homeXg) || 0.15, 0.15, 6);
  awayXg = clamp(Number(awayXg) || 0.15, 0.15, 6);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  let over25 = 0;
  let under25 = 0;

  let btts = 0;

  let totalProbability = 0;

  /*
   * Ampliamos el rango de goles de 0-10 a 0-12
   * para reducir la probabilidad perdida en las colas.
   */
  for (let h = 0; h <= 12; h++) {
    for (let a = 0; a <= 12; a++) {
      const baseProbability =
        poisson(h, homeXg) *
        poisson(a, awayXg);

      const correction =
        lowScoreCorrection(
          h,
          a,
          homeXg,
          awayXg
        );

      const probability =
        Math.max(0, baseProbability * correction);

      totalProbability += probability;

      if (h > a) {
        homeWin += probability;
      } else if (h === a) {
        draw += probability;
      } else {
        awayWin += probability;
      }

      if (h + a >= 3) {
        over25 += probability;
      } else {
        under25 += probability;
      }

      if (h >= 1 && a >= 1) {
        btts += probability;
      }
    }
  }

  /*
   * Normalizamos para que todas las probabilidades
   * vuelvan a sumar 100%.
   */
  if (totalProbability > 0) {
    homeWin /= totalProbability;
    draw /= totalProbability;
    awayWin /= totalProbability;

    over25 /= totalProbability;
    under25 /= totalProbability;

    btts /= totalProbability;
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

function pct(x) {
  return Math.round(x * 1000) / 10;
}

function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

function implied(decimalOdds) {
  if (!decimalOdds || decimalOdds <= 1) {
    return null;
  }

  return 1 / decimalOdds;
}

function ev(probability, decimalOdds) {
  if (
    probability == null ||
    !decimalOdds ||
    decimalOdds <= 1
  ) {
    return null;
  }

  return probability * decimalOdds - 1;
}

function confidence(probability, sampleSize, edge = 0) {
  const base =
    Math.abs(probability - 0.5) * 100;

  const sample =
    clamp((sampleSize / 10) * 20, 0, 20);

  const positiveEdge =
    Math.max(0, edge * 100);

  const value =
    50 +
    base * 0.55 +
    sample +
    positiveEdge * 0.25;

  return Math.round(
    clamp(value, 0, 99)
  );
}

module.exports = {
  matchModel,
  pct,
  implied,
  ev,
  confidence
};
