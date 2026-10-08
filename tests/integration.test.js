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
import { createCalibrationService } from '../server/services/calibration.js';
import { collectValuePicks, buildParlays } from '../server/services/picks.js';

const quiet = { log() {}, warn() {}, error() {} };
const kickoff = new Date(Date.now() + 26 * 3600000).toISOString();

function book(key, h, d, a, o, u, ah = null) {
  const markets = [
    { key: 'h2h', outcomes: [{ name: 'Real Madrid', price: h }, { name: 'Draw', price: d }, { name: 'Getafe', price: a }] },
    { key: 'totals', outcomes: [{ name: 'Over', price: o, point: 2.5 }, { name: 'Under', price: u, point: 2.5 }] }
  ];
  if (ah) markets.push({ key: 'spreads', outcomes: [{ name: 'Real Madrid', price: ah[0], point: -1.5 }, { name: 'Getafe', price: ah[1], point: 1.5 }] });
  return { key, title: key, markets };
}

const oddsEvents = [{
  id: 'evt1', sport_key: 'soccer_spain_la_liga', commence_time: kickoff, home_team: 'Real Madrid', away_team: 'Getafe',
  bookmakers: [
    book('a', 1.30, 5.6, 11, 1.8, 2.05, [2.0, 1.85]), book('b', 1.32, 5.4, 10, 1.85, 2.0, [2.05, 1.8]),
    book('c', 1.29, 5.8, 12, 1.83, 2.02, [1.98, 1.87]), book('d', 1.31, 5.5, 10.5, 1.82, 2.04, [2.02, 1.83])
  ]
}];

const extras = {
  id: 'evt1', home_team: 'Real Madrid', away_team: 'Getafe', commence_time: kickoff,
  bookmakers: ['a', 'b', 'c', 'd'].map((k, i) => ({
    key: k, title: k,
    markets: [
      { key: 'btts', outcomes: [{ name: 'Yes', price: 2.1 + i * 0.02 }, { name: 'No', price: 1.7 }] },
      { key: 'double_chance', outcomes: [{ name: 'Real Madrid or Draw', price: 1.06 }, { name: 'Getafe or Draw', price: 3.6 }, { name: 'Real Madrid or Getafe', price: 1.18 }] }
    ]
  }))
};

let oddsCalls = 0;
async function fakeFetch(url) {
  const u = String(url);
  if (u.includes('the-odds-api.com')) {
    oddsCalls++;
    const body = u.includes('/events/') ? extras : oddsEvents;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'x-requests-remaining': '480', 'x-requests-used': '20', 'x-requests-last': '2' } });
  }
  throw new Error(`red no disponible en tests: ${u}`);
}

function build({ executionBookmaker = '' } = {}) {
  const store = createStore({ logger: quiet });
  const teams = createTeamRegistry();
  const footballData = createFootballDataProvider({ token: '', baseUrl: 'https://api.football-data.org/v4', store, logger: quiet, fetchImpl: fakeFetch });
  const odds = createOddsProvider({ apiKey: 'test', baseUrl: 'https://api.the-odds-api.com/v4', store, logger: quiet, fetchImpl: fakeFetch, dailyCreditBudget: 100, extrasDailyBudget: 50 });
  const bigBalls = createBigBallsProvider({ apiKey: '', store, teams, logger: quiet, fetchImpl: fakeFetch });
  const history = createHistoryProvider({ store, logger: quiet, fetchImpl: fakeFetch });
  const ratings = createRatingsService({ history, teams, logger: quiet });
  const calibration = createCalibrationService({ logger: quiet });
  const bankroll = { currency: 'MXN', flatStake: 100, bankroll: 5000, kellyFraction: 0.25, maxStakePct: 0.02 };
  const analysis = createAnalysisService({ footballData, odds, bigBalls, ratings, teams, store, bankroll, calibration, executionBookmaker, logger: quiet });
  return { analysis, odds };
}

test('flujo completo LaLiga: modelo calibrado, mercado sin margen, cuota de ejecución y motor de valor', async () => {
  const { analysis } = build();
  const date = kickoff.slice(0, 10);
  const { analyses } = await analysis.analyzeRange({ fromDate: date, days: 2, competition: 'PD', tzOffset: 0 });
  assert.equal(analyses.length, 1);
  const a = analyses[0];
  assert.equal(a.competitionSlug, 'la_liga');
  assert.equal(a.canonical.home, 'Real Madrid');
  assert.equal(a.modelAvailable, true);
  assert.equal(a.odds.available, true);
  assert.equal(a.odds.bookmakers, 4);
  assert.ok(a.xg.home > a.xg.away, 'Real Madrid favorito según el modelo');
  const c = a.probabilities.calibrated;
  assert.ok(Math.abs(c.home + c.draw + c.away - 1) < 1e-9);
  assert.ok(Math.abs(c.dc_1x - (c.home + c.draw)) < 1e-9);
  assert.ok(a.probabilities.market.home > 0.7);

  const markets = new Set(a.selections.map(s => s.market));
  for (const m of ['1x2', 'double_chance', 'over_under', 'btts', 'asian_handicap']) assert.ok(markets.has(m), `falta ${m}`);
  const ah = a.selections.find(s => s.selection === 'ah_home');
  assert.equal(ah.line, -1.5);
  for (const s of a.selections) {
    assert.ok(s.executionOdds > 1);
    assert.ok(Number.isFinite(s.ev));
    assert.ok(typeof s.reason === 'string');
    // EV = p_decisión (mezcla modelo + mercado) · cuota_ejecución − 1 (sin push en líneas .5)
    if (!s.pushProbability) {
      assert.ok(Math.abs(s.ev - (s.probability * s.executionOdds - 1)) < 1e-9);
      assert.ok(Math.abs(s.evModel - (s.calibratedProbability * s.executionOdds - 1)) < 1e-9);
      // La mezcla queda entre el modelo calibrado y el mercado (dos vías) o muy cerca (1X2)
      if (s.blendedProbability != null && ['over_under', 'btts', 'asian_handicap'].includes(s.market)) {
        const lo = Math.min(s.calibratedProbability, s.marketProbability) - 1e-9;
        const hi = Math.max(s.calibratedProbability, s.marketProbability) + 1e-9;
        assert.ok(s.blendedProbability >= lo && s.blendedProbability <= hi, `${s.selection} fuera del rango modelo–mercado`);
      }
    }
    // Nunca se recomienda fuera del rango 1.50–4.00
    if (s.recommended) assert.ok(s.executionOdds >= 1.5 && s.executionOdds <= 4);
  }
  // Cuota 1.30 del local: fuera del rango de validación
  const home = a.selections.find(s => s.selection === 'home');
  assert.equal(home.recommended, false);
  const btts = a.selections.find(s => s.selection === 'btts_yes');
  assert.ok(btts.calibration?.message?.startsWith('El modelo dijo'));

  const picks = collectValuePicks(analyses, { includeNearMisses: true });
  assert.ok(Array.isArray(picks.recommended));
  assert.ok(Array.isArray(buildParlays(picks.recommended, { maxLegs: 2 })));
});

test('casa de ejecución fija: sin cuota de esa casa no hay recomendación', async () => {
  const { analysis } = build({ executionBookmaker: 'casa-inexistente' });
  const { analyses } = await analysis.analyzeRange({ fromDate: kickoff.slice(0, 10), days: 2, competition: 'PD', tzOffset: 0 });
  for (const s of analyses[0].selections) {
    assert.equal(s.recommended, false);
    assert.equal(s.reason, 'No hay cuota de la casa de ejecución');
  }
});

test('competiciones desactivadas se rechazan', async () => {
  const { analysis } = build();
  const r = await analysis.getFixtures({ date: kickoff.slice(0, 10), competition: 'PL' });
  assert.equal(r.fixtures.length, 0);
  await assert.rejects(() => analysis.analyzeFixture({ id: 'x', competitionCode: 'SA', home: 'A', away: 'B', kickoff }), /desactivada/);
});

test('las cuotas se cachean y se registra la cuota restante', async () => {
  const { analysis, odds } = build();
  const before = oddsCalls;
  const date = kickoff.slice(0, 10);
  await analysis.analyzeRange({ fromDate: date, days: 1, competition: 'PD', tzOffset: 0 });
  await analysis.analyzeRange({ fromDate: date, days: 1, competition: 'PD', tzOffset: 0 });
  assert.equal(oddsCalls - before, 2, 'una llamada principal + una de mercados adicionales; la segunda vuelta sale de caché');
  const q = await odds.quotaStatus();
  assert.equal(q.remaining, 480);
});
