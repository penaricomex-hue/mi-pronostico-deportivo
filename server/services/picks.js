/**
 * Apuestas de valor y combinadas construidas solo con selecciones que pasan
 * las reglas del pipeline. Las cuotas atípicas nunca entran en una combinada.
 */
import { kellyStake } from '../model/market.js';

function pickRow(a, s, { unvalidated = false } = {}) {
  return {
    fixtureId: a.id,
    competitionCode: a.competitionCode,
    competition: a.competition,
    kickoff: a.kickoff,
    home: a.home,
    away: a.away,
    homeCrest: a.homeCrest,
    awayCrest: a.awayCrest,
    selection: s.selection,
    market: s.market,
    label: s.label,
    probability: s.probability,
    fairOdds: s.fairOdds,
    bestOdds: s.bestOdds,
    bestBookmaker: s.bestBookmaker,
    referenceOdds: s.referenceOdds,
    bookmakerCount: s.bookmakerCount,
    ev: s.ev,
    suggestedStake: s.suggestedStake,
    flatStake: s.flatStake,
    validated: !unvalidated,
    reasons: s.reasons,
    dataQuality: a.dataQuality
  };
}

export function collectValuePicks(analyses, { includeUnvalidated = false } = {}) {
  const validated = [];
  const unvalidated = [];
  for (const a of analyses) {
    for (const s of a.selections || []) {
      if (s.isValue) validated.push(pickRow(a, s));
      else if (includeUnvalidated && s.passesRules) unvalidated.push(pickRow(a, s, { unvalidated: true }));
    }
  }
  const byEv = (x, y) => y.ev - x.ev;
  return { validated: validated.sort(byEv), unvalidated: unvalidated.sort(byEv) };
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
  // Una selección por partido: la de mayor EV
  const perMatch = new Map();
  for (const p of picks) {
    const prev = perMatch.get(p.fixtureId);
    if (!prev || p.ev > prev.ev) perMatch.set(p.fixtureId, p);
  }
  const pool = [...perMatch.values()].sort((a, b) => b.ev - a.ev).slice(0, 8);

  const parlays = [];
  for (let k = 2; k <= Math.min(maxLegs, pool.length); k++) {
    for (const legs of combinations(pool, k)) {
      const odds = legs.reduce((s, l) => s * l.bestOdds, 1);
      const probability = legs.reduce((s, l) => s * l.probability, 1);
      const ev = probability * odds - 1;
      if (!(ev > 0)) continue;
      parlays.push({
        id: legs.map(l => `${l.fixtureId}:${l.selection}`).join('|'),
        legs,
        combinedOdds: Number(odds.toFixed(2)),
        combinedProbability: probability,
        ev,
        validated: legs.every(l => l.validated),
        suggestedStake: bankroll
          ? kellyStake({ probability, odds, bankroll: bankroll.bankroll, fraction: bankroll.kellyFraction / 2, maxPct: bankroll.maxStakePct / 2 })
          : 0
      });
    }
  }
  return parlays.sort((a, b) => b.ev - a.ev).slice(0, limit);
}
