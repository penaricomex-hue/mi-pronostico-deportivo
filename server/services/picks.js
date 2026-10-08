/**
 * Selecciones recomendadas por el ValueBettingEngine y combinadas construidas
 * solo con ellas. La cuota usada siempre es la de ejecución (la que se puede tomar).
 */
import { kellyStake } from '../model/market.js';

function pickRow(a, s) {
  return {
    fixtureId: a.id,
    matchId: a.matchId ?? null,
    competitionCode: a.competitionCode,
    competitionSlug: a.competitionSlug,
    competition: a.competition,
    jornadaKey: s.jornadaKey,
    kickoff: a.kickoff,
    home: a.home,
    away: a.away,
    homeCrest: a.homeCrest,
    awayCrest: a.awayCrest,
    selection: s.selection,
    market: s.market,
    line: s.line ?? 0,
    label: s.label,
    probability: s.probability,
    modelProbability: s.modelProbability,
    calibratedProbability: s.calibratedProbability,
    blendedProbability: s.blendedProbability ?? null,
    blend: s.blend || null,
    marketProbability: s.marketProbability,
    pushProbability: s.pushProbability ?? null,
    fairOdds: s.fairOdds,
    executionOdds: s.executionOdds,
    executionBookmaker: s.executionBookmaker,
    avgMarketOdds: s.avgMarketOdds,
    minimumOdds: s.minimumOdds,
    bookmakerCount: s.bookmakerCount,
    ev: s.ev,
    evModel: s.evModel ?? null,
    marketGap: s.marketGap,
    recommended: Boolean(s.recommended),
    alreadySignaled: Boolean(s.alreadySignaled),
    reason: s.reason,
    blockers: s.blockers || [],
    calibration: s.calibration || null,
    suggestedStake: s.suggestedStake,
    flatStake: s.flatStake,
    oddsCapturedAt: a.odds?.capturedAt || null,
    dataQuality: a.dataQuality
  };
}

/**
 * @returns {{ recommended: Array, nearMisses: Array }}
 *   nearMisses: EV positivo pero bloqueadas por alguna regla (para transparencia).
 */
export function collectValuePicks(analyses, { includeNearMisses = false } = {}) {
  const recommended = [];
  const nearMisses = [];
  for (const a of analyses) {
    for (const s of a.selections || []) {
      if (s.recommended) recommended.push(pickRow(a, s));
      else if (includeNearMisses && s.ev != null && s.ev > 0) nearMisses.push(pickRow(a, s));
    }
  }
  const byEv = (x, y) => y.ev - x.ev;
  return { recommended: recommended.sort(byEv), nearMisses: nearMisses.sort(byEv).slice(0, 30) };
}

function combinations(arr, k, start = 0, acc = [], out = []) {
  if (acc.length === k) { out.push([...acc]); return out; }
  for (let i = start; i < arr.length; i++) {
    acc.push(arr[i]);
    combinations(arr, k, i + 1, acc, out);
    acc.pop();
  }
  return out;
}

/**
 * Combinadas de 2..maxLegs patas, una por partido, ordenadas por EV combinado.
 * Supone independencia entre partidos (se indica en la respuesta).
 */
export function buildParlays(picks, { maxLegs = 3, limit = 5, bankroll } = {}) {
  const perMatch = new Map();
  for (const p of picks) {
    const prev = perMatch.get(p.fixtureId);
    if (!prev || p.ev > prev.ev) perMatch.set(p.fixtureId, p);
  }
  const pool = [...perMatch.values()].sort((a, b) => b.ev - a.ev).slice(0, 8);

  const parlays = [];
  for (let k = 2; k <= Math.min(maxLegs, pool.length); k++) {
    for (const legs of combinations(pool, k)) {
      const odds = legs.reduce((s, l) => s * l.executionOdds, 1);
      const probability = legs.reduce((s, l) => s * l.probability, 1);
      const ev = probability * odds - 1;
      if (!(ev > 0)) continue;
      parlays.push({
        id: legs.map(l => `${l.fixtureId}:${l.selection}`).join('|'),
        legs,
        combinedOdds: Number(odds.toFixed(2)),
        combinedProbability: probability,
        ev,
        validated: legs.every(l => l.recommended),
        suggestedStake: bankroll
          ? kellyStake({ probability, odds, bankroll: bankroll.bankroll, fraction: bankroll.kellyFraction / 2, maxPct: bankroll.maxStakePct / 2 })
          : 0
      });
    }
  }
  return parlays.sort((a, b) => b.ev - a.ev).slice(0, limit);
}
