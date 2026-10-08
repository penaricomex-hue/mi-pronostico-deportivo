import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/lib/store.js';
import { createTeamRegistry } from '../server/lib/teams.js';
import { createOddsProvider } from '../server/providers/oddsApi.js';
import { createFootballDataProvider } from '../server/providers/footballData.js';
import { createBigBallsProvider } from '../server/providers/bigBalls.js';
import { createHistoryProvider } from '../server/providers/history.js';
import { createRatingsService } from '../server/services/ratings.js';
import { createAnalysisService } from '../server/services/analysis.js';
import { collectValuePicks, buildParlays } from '../server/services/picks.js';

const quiet = { log() {}, warn() {}, error() {} };
const kickoff = new Date(Date.now() + 26 * 3600000).toISOString();

function book(key, h, d, a, o, u) {
  return {
    key, title: key,
    markets: [
      { key: 'h2h', outcomes: [{ name: 'Real Madrid', price: h }, { name: 'Draw', price: d }, { name: 'Getafe', price: a }] },
      { key: 'totals', outcomes: [{ name: 'Over', price: o, point: 2.5 }, { name: 'Under', price: u, point: 2.5 }] }
    ]
  };
}

const oddsEvents = [{
  id: 'evt1', sport_key: 'soccer_spain_la_liga', commence_time: kickoff, home_team: 'Real Madrid', away_team: 'Getafe',
  bookmakers: [book('a', 1.30, 5.6, 11, 1.8, 2.05), book('b', 1.32, 5.4, 10, 1.85, 2.0), book('c', 1.29, 5.8, 12, 1.83, 2.02), book('d', 1.31, 5.5, 10.5, 1.82, 2.04)]
}];

let oddsCalls = 0;
async function fakeFetch(url) {
  const u = String(url);
  if (u.includes('the-odds-api.com')) {
    oddsCalls++;
    return new Response(JSON.stringify(oddsEvents), { status: 200, headers: { 'x-requests-remaining': '480', 'x-requests-used': '20', 'x-requests-last': '2' } });
  }
  throw new Error(`red no disponible en tests: ${u}`);
}

function build() {
  const store = createStore({ logger: quiet });
  const teams = createTeamRegistry();
  const footballData = createFootballDataProvider({ token: '', baseUrl: 'https://api.football-data.org/v4', store, logger: quiet, fetchImpl: fakeFetch });
  const odds = createOddsProvider({ apiKey: 'test', baseUrl: 'https://api.the-odds-api.com/v4', store, logger: quiet, fetchImpl: fakeFetch, dailyCreditBudget: 100 });
  const bigBalls = createBigBallsProvider({ apiKey: '', store, teams, logger: quiet, fetchImpl: fakeFetch });
  const history = createHistoryProvider({ store, logger: quiet, fetchImpl: fakeFetch });
  const ratings = createRatingsService({ history, logger: quiet });
  const bankroll = { currency: 'MXN', flatStake: 100, bankroll: 5000, kellyFraction: 0.25, maxStakePct: 0.02 };
  const analysis = createAnalysisService({ footballData, odds, bigBalls, ratings, teams, store, bankroll, logger: quiet });
  return { analysis, odds };
}

test('flujo completo: calendario desde The Odds API, modelo con historial real y mercado', async () => {
  const { analysis } = build();
  const date = kickoff.slice(0, 10);
  const { analyses, warnings } = await analysis.analyzeRange({ fromDate: date, days: 2, competition: 'PD', tzOffset: 0 });
  assert.ok(Array.isArray(warnings));
  assert.equal(analyses.length, 1);
  const a = analyses[0];
  assert.equal(a.canonical.home, 'Real Madrid');
  assert.equal(a.canonical.away, 'Getafe');
  assert.equal(a.modelAvailable, true);
  assert.equal(a.odds.available, true);
  assert.equal(a.odds.bookmakers, 4);
  assert.ok(a.xg.home > a.xg.away, 'Real Madrid favorito según el modelo');
  const f = a.probabilities.final;
  assert.ok(Math.abs(f.home + f.draw + f.away - 1) < 1e-9);
  assert.ok(a.probabilities.market.home > 0.7);
  assert.equal(a.selections.length, 5);
  for (const s of a.selections) {
    assert.ok(s.bestOdds > 1);
    assert.ok(Number.isFinite(s.ev));
  }
  // LaLiga no está validada en el backtest: nunca debe marcar valor
  assert.equal(a.league.valueEnabled, false);
  assert.equal(a.selections.some(s => s.isValue), false);
  const picks = collectValuePicks(analyses, { includeUnvalidated: true });
  assert.equal(picks.validated.length, 0);
  assert.ok(Array.isArray(buildParlays(picks.unvalidated, { maxLegs: 2 })));
});

test('las cuotas se cachean y se registra la cuota restante', async () => {
  const { analysis, odds } = build();
  const before = oddsCalls;
  const date = kickoff.slice(0, 10);
  await analysis.analyzeRange({ fromDate: date, days: 1, competition: 'PD', tzOffset: 0 });
  await analysis.analyzeRange({ fromDate: date, days: 1, competition: 'PD', tzOffset: 0 });
  assert.equal(oddsCalls - before, 1, 'segunda consulta sale de caché');
  const q = await odds.quotaStatus();
  assert.equal(q.remaining, 480);
});
