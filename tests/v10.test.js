import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBet, createValueBettingEngine, minimumOddsFor } from '../server/model/valueEngine.js';
import { settleSelection, profitMultiplier, asianHandicapFromMatrix, expandProbabilities } from '../server/model/markets.js';
import { scoreMatrix } from '../server/model/poisson.js';
import { emptyBins, addObservation, fitCalibration, applyCalibration, fitIsotonic, rangeStats, calibrationMessage } from '../server/model/calibration.js';
import { slugFromLeagueName, jornadaKey, ACTIVE_SLUGS, isActiveCompetition } from '../server/competitions.js';
import { parseOpenfootballCl } from '../server/providers/history.js';
import { buildMarketBook, executionPrice } from '../server/model/marketBook.js';

test('evaluateBet sigue la especificación', () => {
  const ok = evaluateBet({ modelProbability: 0.55, marketProbability: 0.5, executionOdds: 2.0 });
  assert.ok(Math.abs(ok.ev - 0.10) < 1e-9);
  assert.ok(Math.abs(ok.marketGap - 0.05) < 1e-9);
  assert.equal(ok.recommended, true);
  assert.equal(ok.reason, 'Apuesta con valor');
  assert.equal(evaluateBet({ modelProbability: 0.5, marketProbability: 0.5, executionOdds: 2.0 }).reason, 'EV insuficiente');
  assert.equal(evaluateBet({ modelProbability: 0.7, marketProbability: 0.5, executionOdds: 2.0 }).reason, 'El modelo se desvía demasiado del mercado');
  assert.equal(evaluateBet({ modelProbability: 0.7, marketProbability: 0.65, executionOdds: null }).reason, 'No hay cuota de la casa de ejecución');
});

test('motor: rango de cuotas, casas mínimas y máximo 3 por jornada', () => {
  const e = createValueBettingEngine();
  const base = { selection: 'over25', modelProbability: 0.5, marketProbability: 0.45, bookmakerCount: 5 };
  assert.equal(e.evaluate({ ...base, executionOdds: 2.2 }).recommended, true);
  const high = e.evaluate({ ...base, modelProbability: 0.3, marketProbability: 0.25, executionOdds: 4.5 });
  assert.equal(high.recommended, false);
  assert.match(high.reason, /rango/);
  assert.match(e.evaluate({ ...base, executionOdds: 2.2, bookmakerCount: 2 }).reason, /casas/);
  const cands = [0.2, 0.15, 0.12, 0.08].map((ev, i) => ({ id: i, jornadaKey: 'la_liga:2026-10-06', recommended: true, ev }));
  const capped = e.capPerJornada(cands, new Map([['la_liga:2026-10-06', 1]]));
  assert.equal(capped.filter(c => c.recommended).length, 2, 'ya había 1 señal: solo entran 2 más');
  assert.match(capped.find(c => c.id === 3).reason, /Límite/);
  assert.ok(Math.abs(minimumOddsFor(0.5) - 2.1) < 1e-9);
});

test('mercados: liquidación de hándicap asiático, BTTS y doble oportunidad', () => {
  assert.equal(settleSelection('ah_home', -0.5, 1, 0), 'won');
  assert.equal(settleSelection('ah_home', -1, 1, 0), 'void');
  assert.equal(settleSelection('ah_away', -1, 1, 0), 'void');
  assert.equal(settleSelection('ah_home', -0.25, 0, 0), 'half_lost');
  assert.equal(settleSelection('ah_away', 1.5, 0, 2), 'won');
  assert.equal(settleSelection('btts_yes', null, 1, 1), 'won');
  assert.equal(settleSelection('btts_no', null, 2, 0), 'won');
  assert.equal(settleSelection('dc_x2', null, 1, 1), 'won');
  assert.equal(settleSelection('dc_12', null, 1, 1), 'lost');
  assert.equal(profitMultiplier('half_won', 2), 0.5);
  const m = scoreMatrix(1.6, 1.0, -0.05);
  const r = asianHandicapFromMatrix(m, -1);
  assert.ok(Math.abs(r.win + r.push + r.lose - 1) < 1e-9 && r.push > 0);
  const p = expandProbabilities({ home: 0.5, draw: 0.3, away: 0.2, over25: 0.55, btts: 0.5 });
  assert.ok(Math.abs(p.dc_12 - 0.7) < 1e-9 && Math.abs(p.under25 - 0.45) < 1e-9 && p.btts_no === 0.5);
});

test('calibración isotónica corrige un modelo sobreconfiado', () => {
  const bins = emptyBins();
  // El modelo dice 68% pero en ese rango gana 61%
  for (let i = 0; i < 1000; i++) addObservation(bins, 0.68, i < 610);
  for (let i = 0; i < 1000; i++) addObservation(bins, 0.45, i < 430);
  const map = fitCalibration(bins);
  assert.equal(map.method, 'isotonic');
  assert.ok(Math.abs(applyCalibration(map, 0.68) - 0.61) < 0.01);
  const blocks = fitIsotonic(bins);
  for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i].rate >= blocks[i - 1].rate, 'monótona');
  const stats = rangeStats(bins, 0.68);
  assert.equal(stats.range, '60–70%');
  assert.match(calibrationMessage(0.68, applyCalibration(map, 0.68), stats), /El modelo dijo 68%, pero en ese rango ha ganado 61% históricamente.*probabilidad calibrada: 61%/);
  const few = emptyBins();
  addObservation(few, 0.6, true);
  assert.equal(fitCalibration(few).method, 'identity');
});

test('competition_slug: misma lógica que la migración', () => {
  assert.equal(slugFromLeagueName('LaLiga EA Sports'), 'la_liga');
  assert.equal(slugFromLeagueName('La Liga'), 'la_liga');
  assert.equal(slugFromLeagueName('UEFA Champions League'), 'champions_league');
  assert.equal(slugFromLeagueName('Premier League'), 'excluded');
  assert.deepEqual(ACTIVE_SLUGS, ['la_liga', 'champions_league']);
  assert.equal(isActiveCompetition('PL'), false);
  // Jornada martes→lunes: viernes y lunes de LaLiga comparten jornada
  assert.equal(jornadaKey('la_liga', '2026-10-09T19:00:00Z'), jornadaKey('la_liga', '2026-10-12T19:00:00Z'));
  assert.notEqual(jornadaKey('la_liga', '2026-10-12T19:00:00Z'), jornadaKey('la_liga', '2026-10-13T19:00:00Z'));
});

test('parser de openfootball: usa el marcador a 90 minutos', () => {
  const txt = [
    '= UEFA Champions League 2024/25', '', '▪ Finals, Round of 16', '  Tue Mar 11 2025',
    '    21:00  Liverpool FC (ENG)      v Paris Saint-Germain FC (FRA)  1-4 pen. 0-1 a.e.t. (0-1, 0-1)',
    '  Wed Sep 18 2024',
    '    18:45  Bologna FC 1909 (ITA)   v FK Shakhtar Donetsk (UKR)  0-0',
    '           AC Sparta Praha (CZE)   v FC Red Bull Salzburg (AUT)  3-0 (2-0)'
  ].join('\n');
  const rows = parseOpenfootballCl(txt, '2425');
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].home, rows[0].away, rows[0].hg, rows[0].ag], ['Liverpool FC', 'Paris Saint-Germain FC', 0, 1]);
  assert.equal(rows[2].date, '2024-09-18');
  assert.equal(rows[2].hg, 3);
});

test('libro de mercado: consenso sin margen y cuota de ejecución no atípica', () => {
  const books = [
    { bookmaker: 'A', prices: { over25: 1.9, under25: 1.95 } },
    { bookmaker: 'B', prices: { over25: 1.92, under25: 1.93 } },
    { bookmaker: 'C', prices: { over25: 2.6, under25: 1.5 } }
  ];
  const mb = buildMarketBook(books);
  assert.ok(Math.abs(mb.fair.over25 + mb.fair.under25 - 1) < 1e-9);
  assert.equal(mb.prices.over25.bookmaker, 'B', '2.60 es atípica y se descarta');
  const fixed = executionPrice([{ bookmaker: 'Pinnacle', odds: 2.0 }, { bookmaker: 'X', odds: 2.1 }], { executionBookmaker: 'pinnacle' });
  assert.equal(fixed.odds, 2.0);
});

test('presupuesto de The Odds API: reserva diaria solo para cuotas de cierre', async () => {
  const { createStore } = await import('../server/lib/store.js');
  const { createOddsProvider } = await import('../server/providers/oddsApi.js');
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response('[]', { status: 200, headers: { 'x-requests-remaining': '400', 'x-requests-last': '3' } }); };
  const odds = createOddsProvider({ apiKey: 'k', baseUrl: 'https://x', store: createStore({ logger: { log() {}, warn() {} } }), logger: { log() {}, warn() {} },
    fetchImpl, dailyCreditBudget: 9, closingReserveCredits: 3, reserveCredits: 0, cacheMinutes: 0 });
  const wait = () => new Promise(r => setTimeout(r, 15));
  await odds.getEvents('PD', { maxAgeMinutes: 0.0001 });
  await odds.getEvents('CL', { maxAgeMinutes: 0.0001 });
  await wait();
  assert.equal(calls, 2, '6 créditos usados de los 6 disponibles para análisis');
  await odds.getEvents('CL', { maxAgeMinutes: 0.0001 });
  assert.equal(calls, 2, 'el análisis no puede tocar la reserva de cierre');
  await wait();
  await odds.getEvents('PD', { maxAgeMinutes: 0.0001, closing: true });
  assert.equal(calls, 3, 'la captura de cierre sí puede');
});

test('una sola señal por partido (como en el backtest)', () => {
  const e = createValueBettingEngine();
  const mk = (id, fixtureId, ev) => ({ id, fixtureId, jornadaKey: 'la_liga:2026-10-06', recommended: true, ev });
  const out = e.capPerJornada([mk(1, 'A', 0.2), mk(2, 'A', 0.1), mk(3, 'B', 0.08)]);
  assert.deepEqual(out.filter(c => c.recommended).map(c => c.id), [1, 3]);
  assert.equal(out.find(c => c.id === 2).reason, 'Ya hay una señal en este partido');
  const prev = e.capPerJornada([mk(4, 'C', 0.3)], new Map(), { takenMatches: new Set(['C']) });
  assert.equal(prev[0].recommended, false, 'el partido ya tenía una señal registrada');
});

test('nombres nuevos de Champions 2026-27 se resuelven', async () => {
  const { createTeamRegistry } = await import('../server/lib/teams.js');
  const t = createTeamRegistry();
  for (const [n, c] of [['PAE AEK', 'AEK Athens FC'], ['Fenerbahce', 'Fenerbahçe SK'], ['LASK Linz', 'LASK'], ['Viking FK', 'Viking FK'], ['Sabah FK', 'Sabah FK']]) {
    assert.equal(t.resolve(n, 'CL')?.canonical, c);
  }
});

test('día sin partidos en football-data.org no consulta The Odds API', async () => {
  const { createAnalysisService } = await import('../server/services/analysis.js');
  let oddsCalls = 0;
  const analysis = createAnalysisService({
    footballData: { configured: true, getMatches: async () => [] },
    odds: { getEvents: async () => { oddsCalls++; return { events: [] }; } },
    ratings: {}, teams: {}, store: {}, bankroll: {}, calibration: {}, logger: { log() {}, warn() {}, error() {} }
  });
  const r = await analysis.getFixtures({ date: '2026-10-08' });
  assert.equal(r.fixtures.length, 0);
  assert.equal(oddsCalls, 0);
});

test('cuota de cierre: sin partidos próximos no vuelve a consultar la base en cada ciclo', async () => {
  const { createSignalsService } = await import('../server/services/signals.js');
  let calls = 0;
  const ingest = { upcomingMatches: async () => { calls++; return []; } };
  const s = createSignalsService({ pool: { query: async () => ({ rows: [] }) }, ingest, logger: { log() {}, warn() {} } });
  for (let i = 0; i < 5; i++) assert.equal((await s.captureClosing()).skipped, true);
  assert.equal(calls, 1, 'una sola consulta por hora para conocer los próximos inicios');
});
