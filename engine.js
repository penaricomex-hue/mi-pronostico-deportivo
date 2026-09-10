/*
  ============================================================
  MI PRONÓSTICO DEPORTIVO
  ENGINE V7.6.1 ANALYST
  ============================================================

  Motor estadístico:
  - Poisson
  - Dixon-Coles
  - Matriz de marcadores 0-12
  - 1X2
  - Over / Under 2.5
  - BTTS
  - xG
  - Marcador más probable
  - Sample weighting
  - Shrinkage hacia media
  - Confidence score
  - EV
  - Implied probability

  IMPORTANTE:
  BTTS se calcula estadísticamente.
  NO se solicita como mercado a The Odds API.
*/


/* ============================================================
   BASIC HELPERS
   ============================================================ */

function factorial(n) {
  n = Math.floor(Number(n));

  if (!Number.isFinite(n) || n <= 1) {
    return 1;
  }

  let result = 1;

  for (let i = 2; i <= n; i++) {
    result *= i;
  }

  return result;
}


/* ============================================================
   POISSON
   ============================================================ */

function poisson(lambda, k) {
  lambda = Number(lambda);
  k = Math.floor(Number(k));

  if (
    !Number.isFinite(lambda) ||
    !Number.isFinite(k) ||
    lambda <= 0 ||
    k < 0
  ) {
    return 0;
  }

  return (
    Math.exp(-lambda) *
    Math.pow(lambda, k) /
    factorial(k)
  );
}


/* ============================================================
   DIXON-COLES
   ============================================================

   rho negativo:
   - aumenta ligeramente 0-0 y 1-1
   - reduce ligeramente 0-1 y 1-0

   Esta es la corrección estándar utilizada
   para resultados de pocos goles.
*/

function dixonColesCorrection(
  homeGoals,
  awayGoals,
  rho = -0.08
) {
  homeGoals = Math.floor(Number(homeGoals));
  awayGoals = Math.floor(Number(awayGoals));
  rho = Number(rho);

  if (!Number.isFinite(rho)) {
    rho = -0.08;
  }

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


/* ============================================================
   SCORE MATRIX
   ============================================================

   Genera probabilidades de todos los marcadores
   desde 0-0 hasta 12-12.

   La matriz se normaliza al final.
*/

function scoreMatrix(
  homeXg,
  awayXg
) {
  const maxGoals = 12;

  homeXg = Number(homeXg);
  awayXg = Number(awayXg);

  if (!Number.isFinite(homeXg)) {
    homeXg = 1.35;
  }

  if (!Number.isFinite(awayXg)) {
    awayXg = 1.35;
  }

  homeXg = clamp(
    homeXg,
    0.20,
    4.50
  );

  awayXg = clamp(
    awayXg,
    0.20,
    4.50
  );

  const matrix = [];

  let totalProbability = 0;

  for (
    let home = 0;
    home <= maxGoals;
    home++
  ) {
    matrix[home] = [];

    const homeProbability =
      poisson(
        homeXg,
        home
      );

    for (
      let away = 0;
      away <= maxGoals;
      away++
    ) {
      const awayProbability =
        poisson(
          awayXg,
          away
        );

      const correction =
        dixonColesCorrection(
          home,
          away
        );

      let probability =
        homeProbability *
        awayProbability *
        correction;

      /*
        Protección contra valores inválidos.
      */
      if (
        !Number.isFinite(probability) ||
        probability < 0
      ) {
        probability = 0;
      }

      matrix[home][away] =
        probability;

      totalProbability +=
        probability;
    }
  }

  /*
    Normalización final.
  */
  if (
    !Number.isFinite(totalProbability) ||
    totalProbability <= 0
  ) {
    return matrix;
  }

  for (
    let home = 0;
    home <= maxGoals;
    home++
  ) {
    for (
      let away = 0;
      away <= maxGoals;
      away++
    ) {
      matrix[home][away] =
        matrix[home][away] /
        totalProbability;
    }
  }

  return matrix;
}


/* ============================================================
   PERCENTAGE
   ============================================================ */

function pct(value) {
  value = Number(value);

  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.round(
    value * 1000
  ) / 10;
}


/* ============================================================
   CLAMP
   ============================================================ */

function clamp(
  value,
  min,
  max
) {
  value = Number(value);
  min = Number(min);
  max = Number(max);

  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(
    max,
    Math.max(
      min,
      value
    )
  );
}


/* ============================================================
   IMPLIED PROBABILITY
   ============================================================

   Decimal odds -> implied probability.

   Ejemplo:
   2.00 -> 50%
*/

function implied(odds) {
  odds = Number(odds);

  if (
    !Number.isFinite(odds) ||
    odds <= 0
  ) {
    return null;
  }

  return 1 / odds;
}


/* ============================================================
   EXPECTED VALUE
   ============================================================

   EV = probability × odds - 1

   Ejemplo:
   p = 0.60
   odds = 2.00

   EV = 0.60 × 2 - 1
      = 0.20
      = +20%
*/

function ev(
  probability,
  odds
) {
  probability =
    Number(probability);

  odds =
    Number(odds);

  if (
    !Number.isFinite(probability) ||
    !Number.isFinite(odds) ||
    probability < 0 ||
    probability > 1 ||
    odds <= 0
  ) {
    return null;
  }

  return (
    probability *
    odds
  ) - 1;
}


/* ============================================================
   SAMPLE WEIGHT
   ============================================================

   Da más peso a muestras grandes.

   k = 5:

   1 partido  -> 16.7%
   3 partidos -> 37.5%
   5 partidos -> 50.0%
   10 partidos -> 66.7%
   20 partidos -> 80.0%
*/

function sampleWeight(
  sampleSize,
  k = 5
) {
  const n =
    Number(sampleSize);

  const smoothing =
    Number(k);

  if (
    !Number.isFinite(n) ||
    n <= 0
  ) {
    return 0;
  }

  if (
    !Number.isFinite(smoothing) ||
    smoothing < 0
  ) {
    return 0;
  }

  return clamp(
    n /
      (n + smoothing),
    0,
    1
  );
}


/* ============================================================
   SHRINK TO MEAN
   ============================================================

   Reduce extremos producidos por muestras pequeñas.
*/

function shrinkToMean(
  observed,
  baseline,
  sampleSize,
  k = 5
) {
  baseline =
    Number(baseline);

  if (
    !Number.isFinite(baseline)
  ) {
    baseline = 0;
  }

  if (
    observed == null ||
    !Number.isFinite(
      Number(observed)
    )
  ) {
    return baseline;
  }

  const weight =
    sampleWeight(
      sampleSize,
      k
    );

  return (
    baseline +
    (
      Number(observed) -
      baseline
    ) *
    weight
  );
}


/* ============================================================
   STABILIZE STATS
   ============================================================

   Baselines conservadores.

   attackBaseline:
     1.35 goles

   defenseBaseline:
     1.20 goles concedidos
*/

function stabilizeStats(
  stats = {},
  sampleSize = 0
) {
  const attackBaseline =
    1.35;

  const defenseBaseline =
    1.20;

  if (
    !stats ||
    typeof stats !== 'object'
  ) {
    stats = {};
  }

  return {
    gf:
      shrinkToMean(
        stats.gf,
        attackBaseline,
        sampleSize
      ),

    ga:
      shrinkToMean(
        stats.ga,
        defenseBaseline,
        sampleSize
      ),

    homeGF:
      shrinkToMean(
        stats.homeGF,
        attackBaseline,
        sampleSize
      ),

    homeGA:
      shrinkToMean(
        stats.homeGA,
        defenseBaseline,
        sampleSize
      ),

    awayGF:
      shrinkToMean(
        stats.awayGF,
        attackBaseline,
        sampleSize
      ),

    awayGA:
      shrinkToMean(
        stats.awayGA,
        defenseBaseline,
        sampleSize
      )
  };
}


/* ============================================================
   CONFIDENCE
   ============================================================

   V7.6.1

   La confianza considera:

   1. Distancia respecto al 50%
   2. Tamaño de muestra
   3. EV positivo
   4. Penalización por muestras pequeñas
   5. Bonificación limitada por probabilidades fuertes

   IMPORTANTE:

   Confidence NO significa probabilidad de ganar.

   Es una puntuación técnica de la calidad
   de la señal estadística.
*/

function confidence(
  probability,
  sampleSize,
  edge = 0
) {
  probability =
    Number(probability);

  if (
    !Number.isFinite(probability)
  ) {
    return 0;
  }

  const p =
    clamp(
      probability,
      0,
      1
    );

  const n =
    Math.max(
      0,
      Number(sampleSize) || 0
    );

  /*
    Fuerza de la probabilidad
    solamente cuando supera 50%.
  */
  const probabilityStrength =
    Math.max(
      0,
      (p - 0.50) * 100
    );

  /*
    Fiabilidad por tamaño de muestra.
  */
  const reliability =
    sampleWeight(
      n,
      6
    );

  const sampleContribution =
    reliability * 22;

  /*
    Edge / EV positivo.
  */
  const positiveEdge =
    Math.max(
      0,
      Number(edge) || 0
    );

  const edgeContribution =
    Math.min(
      10,
      positiveEdge *
        100 *
        0.25
    );

  /*
    Penalización por muestra pequeña.
  */
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
    Evita confianza elevada
    cuando apenas existe una
    diferencia sobre 50%.
  */
  let baseScore =
    probabilityStrength *
    0.70;

  /*
    Bonificaciones controladas.
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


/* ============================================================
   MATCH MODEL
   ============================================================

   Genera:

   - 1X2
   - Over/Under 2.5
   - BTTS
   - xG
   - marcador más probable
*/

function matchModel(
  homeXg,
  awayXg
) {
  /*
    Validación y límites conservadores.
  */
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

  /*
    Marcador más probable.
  */
  let mostLikelyHome = 0;
  let mostLikelyAway = 0;
  let mostLikelyProbability = 0;

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
        Number(
          matrix[home]?.[away]
        ) || 0;

      /*
        1X2
      */
      if (home > away) {
        homeWin += probability;
      } else if (
        home === away
      ) {
        draw += probability;
      } else {
        awayWin += probability;
      }

      /*
        Over / Under 2.5
      */
      if (
        home + away >= 3
      ) {
        over25 += probability;
      } else {
        under25 += probability;
      }

      /*
        BTTS
      */
      if (
        home >= 1 &&
        away >= 1
      ) {
        bttsYes += probability;
      } else {
        bttsNo += probability;
      }

      /*
        Most probable score.
      */
      if (
        probability >
        mostLikelyProbability
      ) {
        mostLikelyProbability =
          probability;

        mostLikelyHome =
          home;

        mostLikelyAway =
          away;
      }
    }
  }

  /*
    Protección final contra pequeños
    errores numéricos.
  */
  const total1X2 =
    homeWin +
    draw +
    awayWin;

  if (
    total1X2 > 0
  ) {
    homeWin =
      homeWin /
      total1X2;

    draw =
      draw /
      total1X2;

    awayWin =
      awayWin /
      total1X2;
  }

  const totalOU =
    over25 +
    under25;

  if (
    totalOU > 0
  ) {
    over25 =
      over25 /
      totalOU;

    under25 =
      under25 /
      totalOU;
  }

  const totalBTTS =
    bttsYes +
    bttsNo;

  if (
    totalBTTS > 0
  ) {
    bttsYes =
      bttsYes /
      totalBTTS;

    bttsNo =
      bttsNo /
      totalBTTS;
  }

  /*
    Resultado completo.
  */
  return {
    /*
      1X2
    */
    homeWin,
    draw,
    awayWin,

    homeWinPct:
      pct(homeWin),

    drawPct:
      pct(draw),

    awayWinPct:
      pct(awayWin),

    /*
      Over / Under
    */
    over25,
    under25,

    over25Pct:
      pct(over25),

    under25Pct:
      pct(under25),

    /*
      BTTS
    */
    bttsYes,
    bttsNo,

    bttsYesPct:
      pct(bttsYes),

    bttsNoPct:
      pct(bttsNo),

    /*
      Alias utilizado por server.js.
    */
    btts:
      bttsYes,

    bttsPct:
      pct(bttsYes),

    /*
      xG
    */
    homeXg:
      Math.round(
        homeXg * 1000
      ) / 1000,

    awayXg:
      Math.round(
        awayXg * 1000
      ) / 1000,

    totalXg:
      Math.round(
        (
          homeXg +
          awayXg
        ) * 1000
      ) / 1000,

    /*
      Marcador más probable.
    */
    mostLikelyHome,
    mostLikelyAway,

    mostLikelyScore:
      `${mostLikelyHome}-${mostLikelyAway}`,

    mostLikelyProbability,

    mostLikelyScorePct:
      pct(
        mostLikelyProbability
      )
  };
}


/* ============================================================
   EXPORTS
   ============================================================ */

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
