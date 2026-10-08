/**
 * Backtest walk-forward sin fuga de información.
 *
 * 1. Recorre los partidos en orden cronológico.
 * 2. Antes de cada semana reajusta Dixon-Coles SOLO con partidos anteriores.
 * 3. Predice con el mismo pipeline de producción (predictMatch + evaluateSelections).
 * 4. Aprende los pesos de mezcla modelo/mercado en temporadas de entrenamiento
 *    y mide en temporadas de prueba que el ajuste nunca vio.
 */
import { fitDixonColes, DEFAULT_FIT_OPTIONS } from '../model/dixonColes.js';
import { devig } from '../model/market.js';
import { predictMatch, blendProbabilities, evaluateSelections, pickBestByRules, DEFAULT_VALUE_RULES } from '../model/predict.js';
import { createScorer, calibrationTable, outcomeOf, UNIFORM_1X2, verdict } from '../model/metrics.js';

const DAY_MS = 86400000;

function addDays(dateStr, days) {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

export function fairFromOdds(o) {
  if (!o) return null;
  const r = { home: null, draw: null, away: null, over25: null, under25: null };
  const a = devig([o.h, o.d, o.a]);
  if (a) [r.home, r.draw, r.away] = a.probs;
  const b = devig([o.o25, o.u25]);
  if (b) [r.over25, r.under25] = b.probs;
  if (r.home == null && r.over25 == null) return null;
  return r;
}

/** Precios del backtest con la misma forma que en producción. */
export function pricesFromHistory(m, minBookmakers = DEFAULT_VALUE_RULES.minBookmakers) {
  const map = { home: 'h', draw: 'd', away: 'a', over25: 'o25', under25: 'u25' };
  const out = {};
  for (const [sel, k] of Object.entries(map)) {
    const best = m.max?.[k] || m.open?.[k] || null;
    const reference = m.open?.[k] || null;
    if (!best) continue;
    out[sel] = { best, bestBookmaker: 'Máximo de mercado', secondBest: null, reference, count: minBookmakers };
  }
  return out;
}

/**
 * Genera las predicciones del modelo (sin mezcla) para cada partido evaluable.
 */
export function generateRecords(matches, { evalFrom, xi = DEFAULT_FIT_OPTIONS.xi, refitDays = 7 } = {}) {
  const sorted = [...matches].sort((a, b) => a.date.localeCompare(b.date));
  const records = [];
  let ratings = null;
  let nextRefit = null;

  for (const m of sorted) {
    if (evalFrom && m.season < evalFrom) continue;
    if (!nextRefit || m.date >= nextRefit) {
      const fit = fitDixonColes(sorted, { asOf: m.date, xi, warmStart: ratings?.ok ? ratings : null });
      ratings = fit.ok ? fit : null;
      nextRefit = addDays(m.date, refitDays);
    }
    if (!ratings) continue;

    const market = fairFromOdds(m.open);
    const pred = predictMatch({ ratings, home: m.home, away: m.away, market: null, params: { w1x2: 1, wOU: 1 } });
    if (!pred.model) continue;

    records.push({
      season: m.season,
      date: m.date,
      home: m.home,
      away: m.away,
      hg: m.hg,
      ag: m.ag,
      model: pred.model,
      xg: pred.xg,
      market,
      close: fairFromOdds(m.close),
      prices: pricesFromHistory(m)
    });
  }
  return records;
}

function blendRecord(r, w1x2, wOU) {
  return blendProbabilities(r.model, r.market, { w1x2, wOU }).final;
}

/** Predicción con la misma mezcla que producción, sin reajustar el modelo. */
function predictMatchFromRecord(r, w1x2, wOU) {
  return { modelAvailable: true, final: blendRecord(r, w1x2, wOU) };
}

/** Busca el peso de mezcla que minimiza el log-loss en los registros dados. */
export function learnBlendWeights(records) {
  const grid = Array.from({ length: 21 }, (_, i) => i / 20);
  const withMarket = records.filter(r => r.market?.home != null);
  const withOU = records.filter(r => r.market?.over25 != null);
  let best1 = { w: 0, ll: Infinity };
  let bestOU = { w: 0, ll: Infinity };
  for (const w of grid) {
    let ll = 0;
    for (const r of withMarket) {
      const p = blendRecord(r, w, 0);
      ll += -Math.log(Math.max(1e-6, p[outcomeOf(r.hg, r.ag)]));
    }
    ll /= Math.max(1, withMarket.length);
    if (ll < best1.ll) best1 = { w, ll };

    let ll2 = 0;
    for (const r of withOU) {
      const p = blendRecord(r, 0, w);
      const over = r.hg + r.ag >= 3;
      ll2 += -Math.log(Math.max(1e-6, over ? p.over25 : p.under25));
    }
    ll2 /= Math.max(1, withOU.length);
    if (ll2 < bestOU.ll) bestOU = { w, ll: ll2 };
  }
  return { w1x2: best1.w, wOU: bestOU.w };
}

/** Evalúa un conjunto de registros con pesos dados. */
export function evaluateRecords(records, { w1x2, wOU, rules = DEFAULT_VALUE_RULES } = {}) {
  const sModel = createScorer();
  const sBlend = createScorer();
  const sMarket = createScorer();
  const sUniform = createScorer();
  const calib = [];

  let bets = 0, won = 0, staked = 0, profit = 0, balance = 0, peak = 0, maxDd = 0;
  let clvSum = 0, clvN = 0, clvPositive = 0;
  const betLog = [];

  for (const r of records) {
    const outcome = outcomeOf(r.hg, r.ag);
    const isOver = r.hg + r.ag >= 3;
    const pred = predictMatchFromRecord(r, w1x2, wOU);

    sModel.add(r.model, outcome, r.model.over25, isOver);
    sBlend.add(pred.final, outcome, pred.final.over25, isOver);
    if (r.market?.home != null) {
      sMarket.add(r.market, outcome, r.market.over25, r.market.over25 != null ? isOver : null);
      sUniform.add(UNIFORM_1X2, outcome);
    }

    calib.push({
      p: pred.final,
      actual: { home: outcome === 'home', draw: outcome === 'draw', away: outcome === 'away', over25: isOver }
    });

    // Mismas reglas que producción; aquí ignoramos valueEnabled para medir la estrategia.
    const sels = evaluateSelections(pred, r.prices, { valueEnabled: true, rules });
    const pick = pickBestByRules(sels);
    if (!pick) continue;

    const hit = pick.selection === 'over25' ? isOver
      : pick.selection === 'under25' ? !isOver
      : pick.selection === outcome;
    const pnl = hit ? pick.bestOdds - 1 : -1;
    bets++; staked += 1; profit += pnl; if (hit) won++;
    balance += pnl; peak = Math.max(peak, balance); maxDd = Math.max(maxDd, peak - balance);

    const closeP = r.close?.[pick.selection];
    let clv = null;
    if (closeP) {
      clv = pick.bestOdds * closeP - 1; // cuota tomada vs cuota justa de cierre
      clvSum += clv; clvN++; if (clv > 0) clvPositive++;
    }
    betLog.push({
      date: r.date, home: r.home, away: r.away, score: `${r.hg}-${r.ag}`,
      selection: pick.selection, label: pick.label,
      probabilityPct: Number((pick.probability * 100).toFixed(1)),
      odds: pick.bestOdds, evPct: Number((pick.ev * 100).toFixed(1)),
      clvPct: clv != null ? Number((clv * 100).toFixed(1)) : null,
      result: hit ? 'won' : 'lost', profitUnits: Number(pnl.toFixed(2))
    });
  }

  const model = sModel.result();
  const blended = sBlend.result();
  const market = sMarket.result();
  const uniform = sUniform.result();

  return {
    matches: records.length,
    metrics: { model, blended, market, uniform },
    verdicts: {
      modelBrier: verdict(model.brier, market.brier, uniform.brier),
      blendedBrier: verdict(blended.brier, market.brier, uniform.brier),
      modelLogLoss: verdict(model.logLoss, market.logLoss, uniform.logLoss),
      blendedLogLoss: verdict(blended.logLoss, market.logLoss, uniform.logLoss)
    },
    calibration: calibrationTable(calib),
    betting: {
      bets,
      won,
      hitRatePct: bets ? Number(((100 * won) / bets).toFixed(1)) : null,
      stakedUnits: staked,
      profitUnits: Number(profit.toFixed(2)),
      roiPct: staked ? Number(((100 * profit) / staked).toFixed(2)) : null,
      maxDrawdownUnits: Number(maxDd.toFixed(2)),
      avgClvPct: clvN ? Number(((100 * clvSum) / clvN).toFixed(2)) : null,
      clvPositivePct: clvN ? Number(((100 * clvPositive) / clvN).toFixed(1)) : null,
      recentBets: betLog.slice(-40).reverse()
    }
  };
}

/**
 * Backtest completo de una liga: ajusta ξ y pesos en entrenamiento, mide en prueba.
 */
export function runLeagueBacktest(matches, { trainSeasons, testSeasons, xiGrid = [0.0012, 0.0019, 0.003, 0.005], rules = DEFAULT_VALUE_RULES, minTestBets = 50 } = {}) {
  const evalFrom = trainSeasons[0];
  let bestXi = xiGrid[0];
  let bestLL = Infinity;
  let bestRecords = null;

  for (const xi of xiGrid) {
    const recs = generateRecords(matches, { evalFrom, xi });
    const train = recs.filter(r => trainSeasons.includes(r.season));
    const ll = train.reduce((s, r) => s - Math.log(Math.max(1e-6, r.model[outcomeOf(r.hg, r.ag)])), 0) / Math.max(1, train.length);
    if (ll < bestLL) { bestLL = ll; bestXi = xi; bestRecords = recs; }
  }

  const train = bestRecords.filter(r => trainSeasons.includes(r.season));
  const test = bestRecords.filter(r => testSeasons.includes(r.season));
  const weights = learnBlendWeights(train);

  const trainEval = evaluateRecords(train, { ...weights, rules });
  const testEval = evaluateRecords(test, { ...weights, rules });

  const b = testEval.betting;
  // Criterio conservador: muestra suficiente, CLV medio positivo y ROI no negativo
  // en temporadas que el ajuste nunca vio.
  const valueEnabled = b.bets >= minTestBets && b.avgClvPct != null && b.avgClvPct > 0 && b.roiPct != null && b.roiPct >= 0;

  return {
    xi: bestXi,
    weights,
    trainSeasons,
    testSeasons,
    valueEnabled,
    valueRule: `Valor habilitado solo si en prueba hay ≥${minTestBets} apuestas, CLV medio > 0 y ROI ≥ 0`,
    train: trainEval,
    test: testEval
  };
}
