/**
 * ValueBettingEngine
 *
 * La recomendación se basa en la cuota que REALMENTE se puede tomar: la de
 * Caliente MX. Una apuesta puede tener valor frente al mercado promedio y no
 * ser jugable si Caliente paga menos.
 *
 *   1. Probabilidad del modelo (calibrada por competición y mercado).
 *   2. Probabilidad de mercado sin margen (consenso de 3–6+ casas, sin Caliente).
 *   3. EV contra la cuota real de Caliente MX.
 *   4. Recomendación solo si EV ≥ 5 %, el modelo no se aleja > 10 pts del
 *      mercado y la cuota está dentro del rango de validación.
 */
import { MARKETS } from './markets.js';

export const DEFAULT_ENGINE_RULES = {
  minEv: 0.05,                // EV mínimo: 5 %
  maxMarketGap: 0.10,         // diferencia máxima modelo − mercado: 10 pts
  minOdds: 1.50,              // fase de validación: excluir cuotas < 1.50
  maxOdds: 4.00,              // ... y > 4.00
  maxBetsPerMatchday: 3,      // máximo de recomendaciones por jornada
  minMarketBooks: 3,          // casas mínimas para el consenso sin margen
  enabledMarkets: MARKETS     // 1X2, doble oportunidad, O/U 2.5, ambos anotan, hándicap asiático
};

/**
 * Núcleo del motor (lógica especificada).
 * `stakeAtRisk` solo se usa en hándicap asiático con línea entera/cuarto:
 * el EV se mide sobre la parte del stake que no se devuelve. Por defecto 1.
 */
export function evaluateBet({
  modelProbability,
  marketProbability,
  calienteMxOdds,
  minEv = 0.05,
  maxMarketGap = 0.10,
  stakeAtRisk = 1
}) {
  const ev = ((modelProbability * calienteMxOdds) - 1) * stakeAtRisk;
  const marketGap = modelProbability - marketProbability;

  const isValue = ev >= minEv;
  const isReasonable = marketGap <= maxMarketGap;
  const hasOdds = calienteMxOdds > 1;

  return {
    ev,
    marketGap,
    calienteMxOdds,
    recommended: isValue && isReasonable && hasOdds,
    reason: !hasOdds
      ? 'No hay cuota de Caliente MX'
      : !isValue
        ? 'EV insuficiente'
        : !isReasonable
          ? 'El modelo se desvía demasiado del mercado'
          : 'Apuesta con valor'
  };
}

/**
 * Evaluación completa de una selección con las reglas de la fase de validación.
 * @param {object} c
 * @param {string} c.market
 * @param {number|null} c.modelProbability      probabilidad calibrada
 * @param {number|null} c.marketProbability     consenso sin margen
 * @param {number|null} c.marketBooks           casas en el consenso
 * @param {number|null} c.calienteMxOdds        cuota de Caliente MX
 * @param {number} [c.stakeAtRisk]
 */
export function evaluateCandidate(c, rules = DEFAULT_ENGINE_RULES) {
  const r = { ...DEFAULT_ENGINE_RULES, ...rules };
  const odds = Number(c.calienteMxOdds) || 0;
  const blockers = [];

  if (!r.enabledMarkets.includes(c.market)) blockers.push('Mercado no habilitado');
  if (!(odds > 1)) blockers.push('No hay cuota de Caliente MX');
  if (c.modelProbability == null) blockers.push('Sin probabilidad del modelo');
  if (c.marketProbability == null) blockers.push('Sin probabilidad de mercado');
  else if ((c.marketBooks ?? 0) < r.minMarketBooks) blockers.push(`Mercado con menos de ${r.minMarketBooks} casas`);

  if (blockers.length) {
    return { ev: null, marketGap: null, calienteMxOdds: odds || null, recommended: false, reason: blockers[0], blockers };
  }

  const res = evaluateBet({
    modelProbability: c.modelProbability,
    marketProbability: c.marketProbability,
    calienteMxOdds: odds,
    minEv: r.minEv,
    maxMarketGap: r.maxMarketGap,
    stakeAtRisk: c.stakeAtRisk ?? 1
  });

  if (odds < r.minOdds) blockers.push(`Cuota menor a ${r.minOdds.toFixed(2)} (fase de validación)`);
  if (odds > r.maxOdds) blockers.push(`Cuota mayor a ${r.maxOdds.toFixed(2)} (fase de validación)`);
  if (!res.recommended) blockers.unshift(res.reason);

  return {
    ...res,
    recommended: res.recommended && blockers.length === 0,
    reason: blockers.length ? blockers[0] : res.reason,
    blockers
  };
}

/**
 * Aplica el tope de apuestas por jornada: ordena por EV y conserva como máximo
 * `maxBetsPerMatchday` por (competición, jornada), descontando las señales ya
 * emitidas en esa jornada. Una sola selección por partido.
 */
export function capPerMatchday(candidates, { maxBetsPerMatchday = DEFAULT_ENGINE_RULES.maxBetsPerMatchday, alreadyTaken = {} } = {}) {
  const sorted = [...candidates].sort((a, b) => b.ev - a.ev);
  const used = { ...alreadyTaken };
  const perMatch = new Set();
  const kept = [];
  const dropped = [];
  for (const c of sorted) {
    const key = c.matchdayKey;
    if (perMatch.has(c.fixtureId)) { dropped.push({ ...c, droppedReason: 'Ya hay otra señal en este partido' }); continue; }
    if ((used[key] || 0) >= maxBetsPerMatchday) { dropped.push({ ...c, droppedReason: `Tope de ${maxBetsPerMatchday} apuestas por jornada` }); continue; }
    used[key] = (used[key] || 0) + 1;
    perMatch.add(c.fixtureId);
    kept.push(c);
  }
  return { kept, dropped };
}

/** Clave de jornada: competición + jornada oficial, o semana ISO si no la hay. */
export function matchdayKey({ competitionSlug, matchday, stage, kickoff }) {
  if (Number.isFinite(matchday) && matchday > 0) return `${competitionSlug}:${stage && stage !== 'REGULAR_SEASON' ? stage + ':' : ''}J${matchday}`;
  const d = new Date(kickoff || Date.now());
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${competitionSlug}:${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
