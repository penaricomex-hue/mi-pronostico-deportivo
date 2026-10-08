/**
 * Backtest del ValueBettingEngine con calibración por competición y mercado.
 *
 * - Usa las predicciones walk-forward (sin fuga de información) de generateRecords.
 * - Ajusta los calibradores SOLO con temporadas de entrenamiento y los aplica en prueba.
 * - La cuota de ejecución histórica de Caliente MX no existe en ninguna base
 *   pública: se usa como proxy la cuota MEDIA de apertura del mercado (con margen),
 *   que es conservadora frente a la mejor cuota disponible.
 * - Mismas reglas que producción: EV ≥ 5 %, gap ≤ 10 pts, cuota 1.50–4.00,
 *   máximo 3 apuestas por jornada.
 */
import { matchProbabilities } from '../model/poisson.js';
import { modelFixedProbabilities, asianHandicapFromMatrix, settleSelection, profitPerUnit, ahSelection, marketOf, CALIBRATION_GROUP } from '../model/markets.js';
import { fitCalibrator, applyCalibrator, calibrationKey } from '../model/calibration.js';
import { evaluateCandidate, capPerMatchday, matchdayKey, DEFAULT_ENGINE_RULES } from '../model/valueEngine.js';

const AH_LINES = [-1.5, -1, -0.5, 0.5, 1, 1.5];
const FIXED = ['home', 'draw', 'away', 'dc_1x', 'dc_12', 'dc_x2', 'over25', 'under25', 'btts_yes', 'btts_no'];

/** Probabilidades crudas del modelo por selección para un registro walk-forward. */
export function recordProbabilities(r) {
  if (!r.xg) return {};
  const { matrix } = matchProbabilities(r.xg.home, r.xg.away, r.xg.rho);
  const out = { ...modelFixedProbabilities(matrix) };
  for (const l of AH_LINES) {
    for (const side of ['home', 'away']) {
      const res = asianHandicapFromMatrix(matrix, side, l);
      out[ahSelection(side, l)] = res.probability;
    }
  }
  return out;
}

/** Muestras (p, acierto) por clave de calibración. */
export function calibrationSamples(records, slug) {
  const samples = {};
  for (const r of records) {
    const probs = recordProbabilities(r);
    for (const [sel, p] of Object.entries(probs)) {
      if (p == null) continue;
      const res = settleSelection(sel, r.hg, r.ag);
      if (!res || res === 'void') continue;
      const key = calibrationKey(slug, CALIBRATION_GROUP[marketOf(sel)]);
      (samples[key] ||= []).push({ p, y: res === 'won' || res === 'half_won' });
    }
  }
  return samples;
}

function fitAll(samples) {
  const cals = {};
  for (const [k, arr] of Object.entries(samples)) cals[k] = fitCalibrator(k, arr, { source: 'backtest' });
  return cals;
}

function marketFromRecord(r) {
  const m = r.market || {};
  const probs = { home: m.home, draw: m.draw, away: m.away, over25: m.over25, under25: m.under25 };
  if (m.home != null) { probs.dc_1x = m.home + m.draw; probs.dc_12 = m.home + m.away; probs.dc_x2 = m.draw + m.away; }
  return probs;
}

export function runEngineBacktest(records, { slug, trainSeasons, testSeasons, rules = DEFAULT_ENGINE_RULES }) {
  const train = records.filter(r => trainSeasons.includes(r.season));
  const test = records.filter(r => testSeasons.includes(r.season));
  const cals = fitAll(calibrationSamples(train, slug));

  const candidates = [];
  let evaluated = 0;
  for (const r of test) {
    const probs = recordProbabilities(r);
    const mkt = marketFromRecord(r);
    for (const sel of FIXED) {
      const proxyOdds = r.prices?.[sel]?.reference ?? null; // cuota media de apertura
      if (!proxyOdds || mkt[sel] == null || probs[sel] == null) continue;
      evaluated++;
      const market = marketOf(sel);
      const cal = cals[calibrationKey(slug, CALIBRATION_GROUP[market])];
      const p = applyCalibrator(cal, probs[sel]);
      const res = evaluateCandidate({ market, modelProbability: p, marketProbability: mkt[sel], marketBooks: 10, calienteMxOdds: proxyOdds }, rules);
      if (!res.recommended) continue;
      candidates.push({
        fixtureId: `${r.date}|${r.home}|${r.away}`,
        matchdayKey: matchdayKey({ competitionSlug: slug, kickoff: `${r.date}T12:00:00Z` }),
        r, sel, market, p, raw: probs[sel], odds: proxyOdds, ev: res.ev, marketGap: res.marketGap
      });
    }
  }
  const { kept } = capPerMatchday(candidates, { maxBetsPerMatchday: rules.maxBetsPerMatchday });

  let staked = 0, profit = 0, won = 0, clvN = 0, clvSum = 0, clvPos = 0;
  const byMarket = {};
  const log = [];
  for (const c of kept.sort((a, b) => a.r.date.localeCompare(b.r.date))) {
    const result = settleSelection(c.sel, c.r.hg, c.r.ag);
    const pnl = profitPerUnit(result, c.odds);
    staked += 1; profit += pnl; if (result === 'won') won++;
    const closeP = c.r.close?.[c.sel] ?? (c.sel.startsWith('dc_') && c.r.close?.home != null
      ? { dc_1x: c.r.close.home + c.r.close.draw, dc_12: c.r.close.home + c.r.close.away, dc_x2: c.r.close.draw + c.r.close.away }[c.sel] : null);
    let clv = null;
    if (closeP) { clv = c.odds * closeP - 1; clvN++; clvSum += clv; if (clv > 0) clvPos++; }
    const bm = (byMarket[c.market] ||= { bets: 0, won: 0, profit: 0 });
    bm.bets++; bm.profit += pnl; if (result === 'won') bm.won++;
    log.push({ date: c.r.date, home: c.r.home, away: c.r.away, score: `${c.r.hg}-${c.r.ag}`, selection: c.sel, rawPct: +(c.raw * 100).toFixed(1), calibratedPct: +(c.p * 100).toFixed(1), odds: c.odds, evPct: +(c.ev * 100).toFixed(1), clvPct: clv != null ? +(clv * 100).toFixed(1) : null, result, profitUnits: +pnl.toFixed(2) });
  }
  for (const v of Object.values(byMarket)) {
    v.hitRatePct = v.bets ? +((100 * v.won) / v.bets).toFixed(1) : null;
    v.yieldPct = v.bets ? +((100 * v.profit) / v.bets).toFixed(2) : null;
    v.profit = +v.profit.toFixed(2);
  }
  return {
    proxy: 'Cuota media de apertura del mercado (no existe histórico público de Caliente MX)',
    rules,
    trainSeasons, testSeasons,
    evaluatedSelections: evaluated,
    candidates: candidates.length,
    bets: kept.length,
    won,
    hitRatePct: kept.length ? +((100 * won) / kept.length).toFixed(1) : null,
    profitUnits: +profit.toFixed(2),
    yieldPct: staked ? +((100 * profit) / staked).toFixed(2) : null,
    avgClvPct: clvN ? +((100 * clvSum) / clvN).toFixed(2) : null,
    clvPositivePct: clvN ? +((100 * clvPos) / clvN).toFixed(1) : null,
    byMarket,
    calibrators: Object.fromEntries(Object.entries(cals).map(([k, v]) => [k, { method: v.method, n: v.n }])),
    recentBets: log.slice(-40).reverse()
  };
}
