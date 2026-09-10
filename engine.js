function factorial(n) {
  if (n <= 1) return 1;

  let result = 1;

  for (let i = 2; i <= n; i++) {
    result *= i;
  }

  return result;
}

function poisson(lambda, k) {
  if (lambda <= 0) return 0;

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial(k)
  );
}

/*
  Dixon-Coles low-score correction.

  rho:
  - negative values slightly reduce 0-0 / 1-1 combinations
  - positive values increase them

  V7.3 keeps the same conservative correction
  used in V7.1.
*/
function dixonColesCorrection(homeGoals, awayGoals, rho = -0.08) {
  if (homeGoals === 0 && awayGoals === 0) {
    return 1 - rho;
  }

  if (homeGoals === 0 && awayGoals === 1) {
    return 1 + rho;
  }

  if (homeGoals === 1 && awayGoals === 0) {
    return 1 + rho;
  }

  if (homeGoals === 1 && awayGoals === 1) {
    return 1 - rho;
  }

  return 1;
}

/*
  Builds a score probability matrix.

  V7.3:
  - goal range remains 0-12
  - Dixon-Coles correction remains enabled
  - final matrix is normalized
*/
function scoreMatrix(homeXg, awayXg) {
  const maxGoals = 12;

  const matrix = [];

  let totalProbability = 0;

  for (let home = 0; home <= maxGoals; home++) {
    matrix[home] = [];

    for (let away = 0; away <= maxGoals; away++) {
      const homeProbability =
        poisson(homeXg, home);

      const awayProbability =
        poisson(awayXg, away);

      const correction =
        dixonColesCorrection(
          home,
          away
        );

      const probability =
        homeProbability *
        awayProbability *
        correction;

      matrix[home][away] = probability;

      totalProbability += probability;
    }
  }

  if (totalProbability <= 0) {
    return matrix;
  }

  for (let home = 0; home <= maxGoals; home++) {
    for (let away = 0; away <= maxGoals; away++) {
      matrix[home][away] =
        matrix[home][away] /
        totalProbability;
    }
  }

  return matrix;
}

/*
  Converts probability to percentage.
*/
function pct(value) {
  return Math.round(value * 1000) / 10;
}

/*
  Keeps a value inside a range.
*/
function clamp(value, min, max) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

/*
  Converts decimal odds into implied probability.
*/
function implied(odds) {
  if (
    odds == null ||
    !Number.isFinite(Number(odds)) ||
    Number(odds) <= 0
  ) {
    return null;
  }

  return 1 / Number(odds);
}

/*
  Expected value.

  EV = model probability × odds - 1
*/
function ev(probability, odds) {
  if (
    probability == null ||
    odds == null ||
    !Number.isFinite(Number(probability)) ||
    !Number.isFinite(Number(odds)) ||
    Number(odds) <= 0
  ) {
    return null;
  }

  return (
    Number(probability) *
    Number(odds)
  ) - 1;
}

/*
  V7.3
  Statistical reliability based on sample size.

  Instead of assuming that 3 matches are as reliable
  as 10 matches, the model gradually increases the
  weight of observed data.

  k = 5 means:
    1 match  -> 16.7%
    3 matches -> 37.5%
    4 matches -> 44.4%
    5 matches -> 50.0%
    10 matches -> 66.7%
    20 matches -> 80.0%
*/
function sampleWeight(sampleSize, k = 5) {
  const n = Number(sampleSize);

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {
    return 0;
  }

  return clamp(
    n / (n + k),
    0,
    1
  );
}

/*
  Shrinks an observed statistic toward
  a neutral/league baseline.

  This prevents small samples from producing
  extreme values.
*/
function shrinkToMean(
  observed,
  baseline,
  sampleSize,
  k = 5
) {
  if (
    observed == null ||
    !Number.isFinite(Number(observed))
  ) {
    return baseline;
  }

  const weight =
    sampleWeight(sampleSize, k);

  return (
    baseline +
    (
      Number(observed) -
      baseline
    ) *
    weight
  );
}

/*
  V7.3 helper for stabilizing attacking
  and defensive statistics.

  attackBaseline:
    approximately 1.35 goals

  defenseBaseline:
    approximately 1.20 goals conceded
*/
function stabilizeStats(
  stats = {},
  sampleSize = 0
) {
  const attackBaseline = 1.35;
  const defenseBaseline = 1.20;

  const result = {
    gf: shrinkToMean(
      stats.gf,
      attackBaseline,
      sampleSize
    ),

    ga: shrinkToMean(
      stats.ga,
      defenseBaseline,
      sampleSize
    ),

    homeGF: shrinkToMean(
      stats.homeGF,
      attackBaseline,
      sampleSize
    ),

    homeGA: shrinkToMean(
      stats.homeGA,
      defenseBaseline,
      sampleSize
    ),

    awayGF: shrinkToMean(
      stats.awayGF,
      attackBaseline,
      sampleSize
    ),

    awayGA: shrinkToMean(
      stats.awayGA,
      defenseBaseline,
      sampleSize
    )
  };

  return result;
}

/*
  V7.3 confidence.

  The previous model could become too confident
  with a very small number of matches.

  This version explicitly penalizes small samples.
*/
function confidence(
  probability,
  sampleSize,
  edge = 0
) {
  if (
    probability == null ||
    !Number.isFinite(Number(probability))
  ) {
    return 0;
  }

  const p =
    clamp(
      Number(probability),
      0,
      1
    );

  const n =
    Math.max(
      0,
      Number(sampleSize) || 0
    );

  /*
    V7.6
    La confianza se basa en:
    1. Distancia real respecto al 50%.
    2. Tamaño de muestra.
    3. Valor esperado.
    4. Penalización fuerte cuando
       existen muy pocos partidos.
  */

  const probabilityStrength =
    Math.max(
      0,
      (p - 0.50) * 100
    );

  const reliability =
    sampleWeight(
      n,
      6
    );

  const sampleContribution =
    reliability * 22;

  const positiveEdge =
    Math.max(
      0,
      Number(edge) || 0
    );

  const edgeContribution =
    Math.min(
      10,
      positiveEdge * 100 * 0.25
    );

  let uncertaintyPenalty = 0;

  if (n <= 2) {
    uncertaintyPenalty = 15;
  } else if (n <= 4) {
    uncertaintyPenalty = 10;
  } else if (n <= 6) {
    uncertaintyPenalty = 6;
  } else if (n <= 8) {
    uncertaintyPenalty = 3;
  }

  /*
    Evita que una probabilidad
    apenas superior al 50%
    produzca una confianza alta.
  */

  let baseScore =
    probabilityStrength * 0.70;

  /*
    Probabilidades especialmente fuertes.
  */

  if (p >= 0.70) {
    baseScore += 5;
  }

  if (p >= 0.75) {
    baseScore += 5;
  }

  if (p >= 0.80) {
    baseScore += 4;
  }

  const value =
    50 +
    baseScore +
    sampleContribution +
    edgeContribution -
    uncertaintyPenalty;

  return Math.round(
    clamp(
      value,
      0,
      99
    )
  ); 
}

/*
  Generates the principal probabilities
  from the score matrix.
*/
function matchModel(
  homeXg,
  awayXg
) {
  homeXg =
    clamp(
      Number(homeXg) || 0,
      0.20,
      4.50
    );

  awayXg =
    clamp(
      Number(awayXg) || 0,
      0.20,
      4.50
    );

  const matrix =
    scoreMatrix(
      homeXg,
      awayXg
    );

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  let over25 = 0;
  let under25 = 0;

  let bttsYes = 0;
  let bttsNo = 0;

  for (
    let home = 0;
    home <= 12;
    home++
  ) {
    for (
      let away = 0;
      away <= 12;
      away++
    ) {
      const probability =
        matrix[home][away];

      if (home > away) {
        homeWin += probability;
      } else if (home === away) {
        draw += probability;
      } else {
        awayWin += probability;
      }

      if (
        home + away >= 3
      ) {
        over25 += probability;
      } else {
        under25 += probability;
      }

      if (
        home >= 1 &&
        away >= 1
      ) {
        bttsYes += probability;
      } else {
        bttsNo += probability;
      }
    }
  }

  return {
    homeWin,
    draw,
    awayWin,

    over25,
    under25,

    bttsYes,
    bttsNo,

    homeWinPct: pct(homeWin),
    drawPct: pct(draw),
    awayWinPct: pct(awayWin),

    over25Pct: pct(over25),
    under25Pct: pct(under25),

    bttsYesPct: pct(bttsYes),
bttsNoPct: pct(bttsNo),

btts: bttsYes,

homeXg:
  Math.round(homeXg * 1000) / 1000,

    awayXg:
      Math.round(awayXg * 1000) / 1000,

    totalXg:
      Math.round(
        (homeXg + awayXg) * 1000
      ) / 1000
  };
}

module.exports = {
  factorial,
  poisson,
  dixonColesCorrection,
  scoreMatrix,
  matchModel,
  pct,
  clamp,
  implied,
  ev,
  confidence,
  sampleWeight,
  shrinkToMean,
  stabilizeStats
};
