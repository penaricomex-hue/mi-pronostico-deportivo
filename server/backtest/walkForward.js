/**
 * Backtest walk-forward v10 sin fuga de información (solo LaLiga y Champions).
 *
 * 1. Recorre los partidos en orden cronológico.
 * 2. Antes de cada semana reajusta Dixon-Coles SOLO con partidos anteriores.
 * 3. Guarda la probabilidad ORIGINAL del modelo.
 * 4. Ajusta la calibración (isotónica / Platt) en temporadas de entrenamiento y
 *    mide en temporadas de prueba que nunca vio.
 * 5. Si la competición tiene cuotas históricas (LaLiga), simula el
 *    ValueBettingEngine con las mismas reglas que producción:
 *    EV ≥ 5%, |modelo − mercado| ≤ 10 pts, cuotas 1.50–4.00, máx. 3 por jornada.
 */
import { fitDixonColes, DEFAULT_FIT_OPTIONS } from '../model/dixonColes.js';
import { devig } from '../model/market.js';
import { predictMatch } from '../model/predict.js';
import { createScorer, outcomeOf, UNIFORM_1X2, verdict } from '../model/metrics.js';
import { emptyBins, addObservation, fitCalibration, calibrateVector, mergeBins } from '../model/calibration.js';
import { createValueBettingEngine, VALUE_RULES } from '../model/valueEngine.js';
import { selectionLabel, settleSelection, profitMultiplier } from '../model/markets.js';
import { jornadaKey } from '../competitions.js';

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

const PRICE_KEYS = { home: 'h', draw: 'd', away: 'a', over25: 'o25', under25: 'u25' };

/** Predicciones originales del modelo para cada partido evaluable. */
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

    const pred = predictMatch({ ratings, home: m.home, away: m.away, market: null, params: { w1x2: 1, wOU: 1 } });
    if (!pred.model) continue;

    records.push({
      season: m.season,
      date: m.date,
      time: m.time || null,
      home: m.home,
      away: m.away,
      hg: m.hg,
      ag: m.ag,
      model: { ...pred.model, btts_yes: pred.model.btts, btts_no: 1 - pred.model.btts },
      market: fairFromOdds(m.open),
      close: fairFromOdds(m.close),
      open: m.open,
      max: m.max
    });
  }
  return records;
}

/** Observaciones por grupo de calibración a partir de registros. */
export function calibrationBins(records) {
  const bins = { '1x2': emptyBins(), over_under: emptyBins(), btts: emptyBins() };
  for (const r of records) {
    const o = outcomeOf(r.hg, r.ag);
    const over = r.hg + r.ag >= 3;
    const both = r.hg > 0 && r.ag > 0;
    for (const k of ['home', 'draw', 'away']) addObservation(bins['1x2'], r.model[k], o === k);
    addObservation(bins.over_under, r.model.over25, over);
    addObservation(bins.over_under, r.model.under25, !over);
    addObservation(bins.btts, r.model.btts_yes, both);
    addObservation(bins.btts, r.model.btts_no, !both);
  }
  return bins;
}

export function fitMaps(bins, method = 'auto') {
  return Object.fromEntries(Object.entries(bins).map(([g, b]) => [g, fitCalibration(b, { method })]));
}

export function calibrateRecord(r, maps) {
  const c1 = calibrateVector(maps['1x2'], { home: r.model.home, draw: r.model.draw, away: r.model.away });
  const c2 = calibrateVector(maps.over_under, { over25: r.model.over25, under25: r.model.under25 });
  const c3 = calibrateVector(maps.btts, { btts_yes: r.model.btts_yes, btts_no: r.model.btts_no });
  return { ...c1, ...c2, ...c3 };
}

/** Tabla de calibración por bandas (50–60, 60–70, 70–80) para todas las selecciones. */
function bandTable(records, probsOf, bands = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8]]) {
  const obs = [];
  for (const r of records) {
    const p = probsOf(r);
    const o = outcomeOf(r.hg, r.ag);
    const over = r.hg + r.ag >= 3;
    const both = r.hg > 0 && r.ag > 0;
    obs.push([p.home, o === 'home'], [p.draw, o === 'draw'], [p.away, o === 'away'],
      [p.over25, over], [p.under25, !over], [p.btts_yes, both], [p.btts_no, !both]);
  }
  return bands.map(([lo, hi]) => {
    const sel = obs.filter(([p]) => p >= lo && p < hi);
    return {
      range: `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`,
      samples: sel.length,
      predictedPct: sel.length ? Number((100 * sel.reduce((a, [p]) => a + p, 0) / sel.length).toFixed(1)) : null,
      actualPct: sel.length ? Number((100 * sel.filter(([, y]) => y).length / sel.length).toFixed(1)) : null
    };
  });
}

function scoreBinary(list) {
  if (!list.length) return { n: 0, brier: null, logLoss: null };
  let b = 0, l = 0;
  for (const [p, y] of list) { b += (p - (y ? 1 : 0)) ** 2; l += -Math.log(Math.max(1e-6, y ? p : 1 - p)); }
  return { n: list.length, brier: Number((b / list.length).toFixed(4)), logLoss: Number((l / list.length).toFixed(4)) };
}

/**
 * Simulación del ValueBettingEngine. `priceMode`:
 *   'average' → cuota media de mercado (conservador; lo que casi cualquier casa paga)
 *   'best'    → mejor cuota del mercado (optimista; requiere cuentas en muchas casas)
 */
export function simulateBetting(records, maps, { slug, rules = VALUE_RULES, priceMode = 'average' } = {}) {
  const engine = createValueBettingEngine(rules);
  const candidates = [];
  for (const r of records) {
    if (!r.market) continue;
    const p = calibrateRecord(r, maps);
    for (const sel of ['home', 'draw', 'away', 'over25', 'under25']) {
      const k = PRICE_KEYS[sel];
      const odds = priceMode === 'best' ? (r.max?.[k] || r.open?.[k]) : r.open?.[k];
      if (!(odds > 1) || r.market[sel] == null) continue;
      const ev = engine.evaluate({
        selection: sel, modelProbability: p[sel], marketProbability: r.market[sel], executionOdds: odds,
        bookmakerCount: rules.minBookmakers, modelAvailable: true
      });
      candidates.push({ ...ev, r, selection: sel, probability: p[sel], rawProbability: r.model[sel], jornadaKey: jornadaKey(slug, `${r.date}T${r.time || '20:00'}:00Z`) });
    }
  }
  // Una selección por partido (la de mayor EV) y máximo 3 por jornada
  const bestPerMatch = new Map();
  for (const c of candidates.filter(x => x.recommended)) {
    const key = `${c.r.date}|${c.r.home}`;
    if (!bestPerMatch.has(key) || c.ev > bestPerMatch.get(key).ev) bestPerMatch.set(key, c);
  }
  const capped = engine.capPerJornada([...bestPerMatch.values()]).filter(c => c.recommended)
    .sort((a, b) => a.r.date.localeCompare(b.r.date));

  let won = 0, staked = 0, profit = 0, balance = 0, peak = 0, maxDd = 0, evSum = 0;
  let clvSum = 0, clvN = 0, clvPositive = 0;
  const byMarket = {};
  const log = [];
  for (const c of capped) {
    const status = settleSelection(c.selection, 0, c.r.hg, c.r.ag);
    const pnl = profitMultiplier(status, c.executionOdds);
    staked += 1; profit += pnl; evSum += c.ev; if (status === 'won') won++;
    balance += pnl; peak = Math.max(peak, balance); maxDd = Math.max(maxDd, peak - balance);
    const closeP = c.r.close?.[c.selection];
    let clv = null;
    if (closeP) { clv = c.executionOdds * closeP - 1; clvSum += clv; clvN++; if (clv > 0) clvPositive++; }
    const mk = c.market;
    byMarket[mk] = byMarket[mk] || { bets: 0, won: 0, profit: 0 };
    byMarket[mk].bets++; byMarket[mk].profit += pnl; if (status === 'won') byMarket[mk].won++;
    log.push({
      date: c.r.date, home: c.r.home, away: c.r.away, score: `${c.r.hg}-${c.r.ag}`,
      selection: c.selection, label: selectionLabel(c.selection),
      rawProbabilityPct: Number((c.rawProbability * 100).toFixed(1)),
      probabilityPct: Number((c.probability * 100).toFixed(1)),
      marketPct: Number(((c.probability - c.marketGap) * 100).toFixed(1)),
      odds: c.executionOdds, evPct: Number((c.ev * 100).toFixed(1)),
      clvPct: clv != null ? Number((clv * 100).toFixed(1)) : null,
      result: status, profitUnits: Number(pnl.toFixed(2))
    });
  }
  const bets = capped.length;
  return {
    priceMode,
    bets,
    won,
    hitRatePct: bets ? Number(((100 * won) / bets).toFixed(1)) : null,
    stakedUnits: staked,
    profitUnits: Number(profit.toFixed(2)),
    yieldPct: staked ? Number(((100 * profit) / staked).toFixed(2)) : null,
    roiPct: staked ? Number(((100 * profit) / staked).toFixed(2)) : null,
    avgEvPct: bets ? Number(((100 * evSum) / bets).toFixed(2)) : null,
    maxDrawdownUnits: Number(maxDd.toFixed(2)),
    avgClvPct: clvN ? Number(((100 * clvSum) / clvN).toFixed(2)) : null,
    clvPositivePct: clvN ? Number(((100 * clvPositive) / clvN).toFixed(1)) : null,
    byMarket: Object.fromEntries(Object.entries(byMarket).map(([k, v]) => [k, { ...v, profit: Number(v.profit.toFixed(2)), hitRatePct: Number(((100 * v.won) / v.bets).toFixed(1)) }])),
    recentBets: log.slice(-40).reverse()
  };
}

/** Evalúa probabilísticamente un conjunto (modelo original vs calibrado vs mercado). */
export function evaluateRecords(records, maps) {
  const sModel = createScorer(), sCal = createScorer(), sMarket = createScorer(), sUniform = createScorer();
  const bttsRaw = [], bttsCal = [];
  for (const r of records) {
    const o = outcomeOf(r.hg, r.ag);
    const over = r.hg + r.ag >= 3;
    const both = r.hg > 0 && r.ag > 0;
    const c = calibrateRecord(r, maps);
    sModel.add(r.model, o, r.model.over25, over);
    sCal.add(c, o, c.over25, over);
    sUniform.add(UNIFORM_1X2, o);
    if (r.market?.home != null) sMarket.add(r.market, o, r.market.over25, r.market.over25 != null ? over : null);
    bttsRaw.push([r.model.btts_yes, both]);
    bttsCal.push([c.btts_yes, both]);
  }
  const model = sModel.result(), calibrated = sCal.result(), market = sMarket.result(), uniform = sUniform.result();
  return {
    matches: records.length,
    metrics: { model, calibrated, market, uniform, bttsModel: scoreBinary(bttsRaw), bttsCalibrated: scoreBinary(bttsCal) },
    verdicts: {
      modelBrier: verdict(model.brier, market.brier, uniform.brier),
      calibratedBrier: verdict(calibrated.brier, market.brier, uniform.brier),
      modelLogLoss: verdict(model.logLoss, market.logLoss, uniform.logLoss),
      calibratedLogLoss: verdict(calibrated.logLoss, market.logLoss, uniform.logLoss)
    },
    calibration: {
      model: bandTable(records, r => r.model),
      calibrated: bandTable(records, r => calibrateRecord(r, maps))
    }
  };
}

/**
 * Backtest completo de una competición.
 * @returns informe + bins de calibración (semilla para producción)
 */
export function runLeagueBacktest(matches, { slug, trainSeasons, testSeasons, xiGrid = [0.0012, 0.0019, 0.003, 0.005], rules = VALUE_RULES, method = 'auto', hasOdds = true } = {}) {
  const evalFrom = trainSeasons[0];
  let bestXi = xiGrid[0], bestLL = Infinity, bestRecords = null;
  for (const xi of xiGrid) {
    const recs = generateRecords(matches, { evalFrom, xi });
    const train = recs.filter(r => trainSeasons.includes(r.season));
    const ll = train.reduce((s, r) => s - Math.log(Math.max(1e-6, r.model[outcomeOf(r.hg, r.ag)])), 0) / Math.max(1, train.length);
    if (ll < bestLL) { bestLL = ll; bestXi = xi; bestRecords = recs; }
  }

  const train = bestRecords.filter(r => trainSeasons.includes(r.season));
  const test = bestRecords.filter(r => testSeasons.includes(r.season));
  const trainMaps = fitMaps(calibrationBins(train), method);

  const out = {
    competitionSlug: slug,
    xi: bestXi,
    trainSeasons,
    testSeasons,
    rules,
    calibrationMaps: Object.fromEntries(Object.entries(trainMaps).map(([g, m]) => [g, { method: m.method, samples: m.samples }])),
    train: evaluateRecords(train, trainMaps),
    test: evaluateRecords(test, trainMaps),
    betting: null,
    bettingBestPrice: null
  };

  if (hasOdds) {
    out.betting = simulateBetting(test, trainMaps, { slug, rules, priceMode: 'average' });
    out.bettingBestPrice = simulateBetting(test, trainMaps, { slug, rules, priceMode: 'best' });
  }

  // Semilla de producción: TODOS los registros fuera de muestra (entrenamiento + prueba)
  const seed = calibrationBins(bestRecords);
  return { report: out, seed };
}

export { mergeBins };
