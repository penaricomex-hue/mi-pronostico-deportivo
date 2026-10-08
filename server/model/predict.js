/**
 * Pipeline predictivo único. Lo usan exactamente igual producción
 * (/api/analyze, /api/value-bets, /api/parlay) y el backtest walk-forward.
 */
import { expectedGoals } from './dixonColes.js';
import { matchProbabilities } from './poisson.js';
import { expectedValue, isOutlierPrice } from './market.js';

export const SELECTIONS = ['home', 'draw', 'away', 'over25', 'under25'];

export const SELECTION_LABELS = {
  home: 'Gana local',
  draw: 'Empate',
  away: 'Gana visitante',
  over25: 'Más de 2.5 goles',
  under25: 'Menos de 2.5 goles'
};

export const SELECTION_MARKET = {
  home: 'h2h', draw: 'h2h', away: 'h2h', over25: 'totals', under25: 'totals'
};

export const DEFAULT_VALUE_RULES = {
  minEv: 0.02,          // EV mínimo (2%) a la mejor cuota
  minProbability: 0.2,  // evitar cuotas muy largas, donde el modelo es menos fiable
  minBookmakers: 3,
  maxOdds: 5.0
};

function blend(pModel, pMarket, w) {
  if (pMarket == null) return pModel;
  if (pModel == null) return pMarket;
  return w * pModel + (1 - w) * pMarket;
}

function dataQuality(homeSample, awaySample) {
  const n = Math.min(homeSample ?? 0, awaySample ?? 0);
  if (n >= 15) return 'alta';
  if (n >= 7) return 'media';
  return 'baja';
}

/**
 * Mezcla modelo y mercado: p = w·p_modelo + (1 − w)·p_mercado, con w aprendido
 * por liga en el backtest. Es la única implementación de la mezcla.
 */
export function blendProbabilities(model, market, params = {}) {
  const w1x2 = Number.isFinite(params.w1x2) ? params.w1x2 : 0.5;
  const wOU = Number.isFinite(params.wOU) ? params.wOU : 0.5;

  const final = {};
  for (const k of ['home', 'draw', 'away']) final[k] = blend(model?.[k] ?? null, market?.[k] ?? null, w1x2);
  for (const k of ['over25', 'under25']) final[k] = blend(model?.[k] ?? null, market?.[k] ?? null, wOU);

  const s1 = (final.home ?? 0) + (final.draw ?? 0) + (final.away ?? 0);
  if (s1 > 0) for (const k of ['home', 'draw', 'away']) if (final[k] != null) final[k] /= s1;
  const s2 = (final.over25 ?? 0) + (final.under25 ?? 0);
  if (s2 > 0) for (const k of ['over25', 'under25']) if (final[k] != null) final[k] /= s2;

  return { final, w1x2, wOU };
}

/**
 * @param {object} args
 * @param {object|null} args.ratings  modelo Dixon-Coles ajustado (o null si la liga no tiene modelo)
 * @param {string} args.home          nombre canónico local
 * @param {string} args.away          nombre canónico visitante
 * @param {object|null} args.market   probabilidades de mercado sin margen { home, draw, away, over25, under25 }
 * @param {object} args.params        parámetros aprendidos de la liga { w1x2, wOU }
 */
export function predictMatch({ ratings, home, away, market = null, params = {} }) {
  const warnings = [];
  let model = null;
  let xg = null;

  if (ratings?.ok) {
    xg = expectedGoals(ratings, home, away);
    warnings.push(...xg.warnings);
    const p = matchProbabilities(xg.lambda, xg.mu, xg.rho);
    model = {
      home: p.home, draw: p.draw, away: p.away,
      over25: p.over25, under25: p.under25, btts: p.btts,
      mostLikelyScore: p.mostLikelyScore
    };
  } else {
    warnings.push('Esta competición no tiene modelo propio; se muestran probabilidades de mercado.');
  }

  if (!market) warnings.push('Sin cuotas de mercado: no se puede evaluar valor.');

  const { final, w1x2, wOU } = blendProbabilities(model, market, params);

  return {
    modelAvailable: Boolean(model),
    xg: xg ? { home: xg.lambda, away: xg.mu, rho: xg.rho } : null,
    sample: xg ? { home: xg.homeSample, away: xg.awaySample } : null,
    dataQuality: xg ? dataQuality(xg.homeSample, xg.awaySample) : null,
    model,
    market,
    final,
    weights: { w1x2, wOU },
    warnings
  };
}

/**
 * Evalúa cada selección contra los precios disponibles con las MISMAS reglas en
 * producción y backtest.
 *
 * @param {object} prediction resultado de predictMatch
 * @param {object} prices { [selection]: { best, bestBookmaker, secondBest, reference, count } }
 * @param {object} opts { valueEnabled, rules }
 */
export function evaluateSelections(prediction, prices, { valueEnabled = false, rules = DEFAULT_VALUE_RULES } = {}) {
  const r = { ...DEFAULT_VALUE_RULES, ...rules };
  const out = [];
  for (const sel of SELECTIONS) {
    const p = prediction.final[sel];
    const pr = prices?.[sel];
    if (p == null || !pr?.best) continue;

    const ev = expectedValue(p, pr.best);
    const evReference = pr.reference ? expectedValue(p, pr.reference) : null;
    const outlier = isOutlierPrice(pr.best, pr.reference, pr.secondBest);
    const reasons = [];
    if (!prediction.modelAvailable) reasons.push('Sin modelo propio');
    if ((pr.count ?? 0) < r.minBookmakers) reasons.push(`Menos de ${r.minBookmakers} casas`);
    if (outlier) reasons.push('Cuota atípica');
    if (p < r.minProbability) reasons.push('Probabilidad baja');
    if (pr.best > r.maxOdds) reasons.push('Cuota demasiado alta');
    if (!(ev >= r.minEv)) reasons.push('EV insuficiente');

    const passesRules = reasons.length === 0;
    if (passesRules && !valueEnabled) reasons.push('Liga sin ventaja validada en backtest');

    out.push({
      selection: sel,
      market: SELECTION_MARKET[sel],
      label: SELECTION_LABELS[sel],
      probability: p,
      fairOdds: p > 0 ? 1 / p : null,
      bestOdds: pr.best,
      bestBookmaker: pr.bestBookmaker ?? null,
      referenceOdds: pr.reference ?? null,
      bookmakerCount: pr.count ?? null,
      ev,
      evReference,
      outlier,
      passesRules,
      isValue: passesRules && valueEnabled,
      reasons
    });
  }
  return out;
}

export function pickBestValue(selections) {
  return selections
    .filter(s => s.isValue)
    .sort((a, b) => b.ev - a.ev)[0] || null;
}

/** Candidata con mejores números aunque la liga no esté validada (para backtest). */
export function pickBestByRules(selections) {
  return selections
    .filter(s => s.passesRules)
    .sort((a, b) => b.ev - a.ev)[0] || null;
}
