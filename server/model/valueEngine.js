/**
 * ValueBettingEngine
 *
 * Flujo de decisión (idéntico en producción y backtest):
 *   1. Probabilidad del modelo (Dixon-Coles) → calibrada por competición y mercado.
 *   2. Probabilidad de mercado sin margen, a partir de varias casas (consenso).
 *   3. Cuota REAL de ejecución: la casa configurada en EXECUTION_BOOKMAKER o, si no
 *      hay ninguna configurada, la mejor cuota no atípica disponible.
 *   4. Se recomienda solo si esa cuota deja EV ≥ 5% y el modelo no se separa del
 *      mercado más de 10 puntos.
 *   5. Se registra la cuota exacta de ejecución en el momento de la señal.
 */
import { ENABLED_MARKETS, SELECTION_MARKET } from './markets.js';

export const VALUE_RULES = {
  minEv: 0.05,            // EV mínimo: 5%
  maxMarketGap: 0.10,     // diferencia máxima modelo − mercado: 10 pts
  minOdds: 1.50,          // fase de validación: solo cuotas 1.50–4.00
  maxOdds: 4.00,
  minBookmakers: 3,       // casas mínimas para construir el mercado sin margen
  maxBetsPerJornada: 3,   // máximo de señales por jornada y competición
  enabledMarkets: ENABLED_MARKETS
};

/**
 * Evaluación base de una apuesta (especificación MK Bets).
 * `executionOdds` es la cuota que realmente se puede tomar.
 * `pushProbability` solo aplica al hándicap asiático de línea entera: el EV real
 * es (1 − P(push)) · (p · cuota − 1). Con 0 es exactamente p · cuota − 1.
 */
export function evaluateBet({
  modelProbability,
  marketProbability,
  executionOdds,
  minEv = VALUE_RULES.minEv,
  maxMarketGap = VALUE_RULES.maxMarketGap,
  pushProbability = 0
}) {
  const hasOdds = Number(executionOdds) > 1;
  const ev = hasOdds && Number.isFinite(modelProbability)
    ? (1 - (pushProbability || 0)) * ((modelProbability * executionOdds) - 1)
    : null;
  const marketGap = Number.isFinite(modelProbability) && Number.isFinite(marketProbability)
    ? modelProbability - marketProbability
    : null;

  const isValue = ev != null && ev >= minEv;
  const isReasonable = marketGap != null && marketGap <= maxMarketGap;

  return {
    ev,
    marketGap,
    executionOdds: hasOdds ? Number(executionOdds) : null,
    recommended: isValue && isReasonable && hasOdds,
    reason: !hasOdds
      ? 'No hay cuota de la casa de ejecución'
      : marketGap == null
        ? 'Sin probabilidad de mercado'
        : !isValue
          ? 'EV insuficiente'
          : !isReasonable
            ? 'El modelo se desvía demasiado del mercado'
            : 'Apuesta con valor'
  };
}

/** Cuota mínima que haría falta para llegar al EV mínimo. */
export function minimumOddsFor(probability, minEv = VALUE_RULES.minEv, pushProbability = 0) {
  if (!(probability > 0)) return null;
  // (1 − push)(p·o − 1) ≥ minEv  →  o ≥ (minEv / (1 − push) + 1) / p
  const k = 1 - (pushProbability || 0);
  if (!(k > 0)) return null;
  return (minEv / k + 1) / probability;
}

export function createValueBettingEngine(rules = {}) {
  const r = { ...VALUE_RULES, ...rules };

  /**
   * @param {object} c candidato
   * @param {string} c.selection
   * @param {number} c.modelProbability   probabilidad calibrada
   * @param {number} c.marketProbability  consenso sin margen
   * @param {number|null} c.executionOdds
   * @param {number} c.bookmakerCount
   * @param {number} [c.pushProbability]
   * @param {boolean} [c.modelAvailable]
   */
  function evaluate(c) {
    const base = evaluateBet({
      modelProbability: c.modelProbability,
      marketProbability: c.marketProbability,
      executionOdds: c.executionOdds,
      minEv: r.minEv,
      maxMarketGap: r.maxMarketGap,
      pushProbability: c.pushProbability || 0
    });
    const market = SELECTION_MARKET[c.selection];
    const blockers = [];
    if (c.modelAvailable === false) blockers.push('Sin modelo propio para este partido');
    if (!r.enabledMarkets.includes(market)) blockers.push('Mercado no habilitado');
    if (base.executionOdds != null && (base.executionOdds < r.minOdds || base.executionOdds > r.maxOdds)) {
      blockers.push(`Cuota fuera del rango de validación (${r.minOdds.toFixed(2)}–${r.maxOdds.toFixed(2)})`);
    }
    if ((c.bookmakerCount ?? 0) < r.minBookmakers) blockers.push(`Menos de ${r.minBookmakers} casas en el mercado`);

    const recommended = base.recommended && blockers.length === 0;
    return {
      ...base,
      market,
      recommended,
      // El motivo principal: el de la regla base si falla; si no, el primer bloqueo.
      reason: !base.recommended ? base.reason : blockers[0] || base.reason,
      blockers,
      minimumOdds: minimumOddsFor(c.modelProbability, r.minEv, c.pushProbability || 0)
    };
  }

  /**
   * Limita a `maxBetsPerJornada` por jornada. Las señales ya registradas cuentan
   * primero; las nuevas entran por EV descendente.
   * @param {Array<{jornadaKey:string, ev:number, recommended:boolean}>} candidates
   * @param {Map<string, number>|object} alreadyTaken  señales ya registradas por jornada
   */
  /**
   * Límite por jornada y una sola señal por partido (la de mayor EV), igual que
   * en el backtest: evita apuestas correlacionadas del mismo partido.
   * `matchKey(c)` identifica el partido; `takenMatches` = partidos con señal previa.
   */
  function capPerJornada(candidates, alreadyTaken = new Map(), { matchKey = c => c.fixtureId ?? null, takenMatches = new Set() } = {}) {
    const taken = alreadyTaken instanceof Map ? new Map(alreadyTaken) : new Map(Object.entries(alreadyTaken || {}));
    const matches = new Set(takenMatches);
    const sorted = [...candidates].filter(c => c.recommended).sort((a, b) => (b.alreadySignaled - a.alreadySignaled) || b.ev - a.ev);
    const accepted = new Set();
    const reasons = new Map();
    for (const c of sorted) {
      if (c.alreadySignaled) { accepted.add(c); const k = matchKey(c); if (k != null) matches.add(k); continue; }
      const k = matchKey(c);
      if (k != null && matches.has(k)) { reasons.set(c, 'Ya hay una señal en este partido'); continue; }
      const n = taken.get(c.jornadaKey) || 0;
      if (n >= r.maxBetsPerJornada) { reasons.set(c, `Límite de ${r.maxBetsPerJornada} señales por jornada`); continue; }
      taken.set(c.jornadaKey, n + 1);
      if (k != null) matches.add(k);
      accepted.add(c);
    }
    return candidates.map(c => {
      if (!c.recommended || accepted.has(c)) return c;
      const reason = reasons.get(c) || `Límite de ${r.maxBetsPerJornada} señales por jornada`;
      return { ...c, recommended: false, reason, blockers: [...(c.blockers || []), reason] };
    });
  }

  return { rules: r, evaluate, capPerJornada };
}
