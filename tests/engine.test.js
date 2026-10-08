import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBet, evaluateCandidate, capPerMatchday, matchdayKey, DEFAULT_ENGINE_RULES } from '../server/model/valueEngine.js';
import {
  marketConsensus, modelFixedProbabilities, asianHandicapFromMatrix, settleSelection, profitPerUnit,
  swapSelection, marketOf, ahSelection
} from '../server/model/markets.js';
import { scoreMatrix } from '../server/model/poisson.js';
import { fitCalibrator, applyCalibrator, explainCalibration, fitIsotonic } from '../server/model/calibration.js';
import { competitionSlug, isActiveCompetition, ACTIVE_CODES } from '../server/competitions.js';
import { computePerformance } from '../server/services/signals.js';
import { evaluateEngine } from '../server/services/analysis.js';

test('evaluateBet sigue la lógica especificada', () => {
  const ok = evaluateBet({ modelProbability: 0.55, marketProbability: 0.50, calienteMxOdds: 2.0 });
  assert.ok(Math.abs(ok.ev - 0.10) < 1e-9);
  assert.ok(Math.abs(ok.marketGap - 0.05) < 1e-9);
  assert.equal(ok.recommended, true);
  assert.equal(ok.reason, 'Apuesta con valor');

  assert.equal(evaluateBet({ modelProbability: 0.55, marketProbability: 0.5, calienteMxOdds: 0 }).reason, 'No hay cuota de Caliente MX');
  assert.equal(evaluateBet({ modelProbability: 0.50, marketProbability: 0.5, calienteMxOdds: 2.05 }).reason, 'EV insuficiente');
  assert.equal(evaluateBet({ modelProbability: 0.70, marketProbability: 0.5, calienteMxOdds: 2.0 }).reason, 'El modelo se desvía demasiado del mercado');
});

test('valor frente al mercado pero NO jugable si Caliente paga menos', () => {
  // Modelo 55 %, mercado 52 %: la cuota media 1.95 tendría EV 7.25 %, pero Caliente paga 1.88 → EV 3.4 %
  const r = evaluateCandidate({ market: '1x2', modelProbability: 0.55, marketProbability: 0.52, marketBooks: 5, calienteMxOdds: 1.88 });
  assert.equal(r.recommended, false);
  assert.equal(r.reason, 'EV insuficiente');
});

test('reglas de validación: rango de cuotas, casas mínimas y mercado habilitado', () => {
  const base = { market: '1x2', modelProbability: 0.75, marketProbability: 0.72, marketBooks: 5 };
  assert.match(evaluateCandidate({ ...base, calienteMxOdds: 1.45 }).reason, /EV insuficiente|menor a 1.50/);
  assert.match(evaluateCandidate({ ...base, modelProbability: 0.3, marketProbability: 0.25, calienteMxOdds: 4.5 }).reason, /mayor a 4.00/);
  assert.match(evaluateCandidate({ ...base, marketBooks: 2, calienteMxOdds: 1.6 }).reason, /menos de 3 casas/);
  assert.equal(evaluateCandidate({ ...base, market: 'corners', calienteMxOdds: 1.6 }).reason, 'Mercado no habilitado');
  assert.equal(evaluateCandidate({ ...base, calienteMxOdds: null }).reason, 'No hay cuota de Caliente MX');
});

test('máximo 3 apuestas por jornada y una por partido', () => {
  const c = (id, ev, md = 'la_liga:J9') => ({ fixtureId: id, ev, matchdayKey: md });
  const { kept, dropped } = capPerMatchday([c('a', 0.2), c('a', 0.3), c('b', 0.1), c('c', 0.06), c('d', 0.09), c('e', 0.2, 'champions_league:J3')]);
  assert.deepEqual(kept.map(k => `${k.fixtureId}:${k.ev}`), ['a:0.3', 'e:0.2', 'b:0.1', 'd:0.09']);
  assert.equal(dropped.length, 2);
  const already = capPerMatchday([c('x', 0.2)], { alreadyTaken: { 'la_liga:J9': 3 } });
  assert.equal(already.kept.length, 0);
  assert.equal(matchdayKey({ competitionSlug: 'la_liga', matchday: 9, stage: 'REGULAR_SEASON' }), 'la_liga:J9');
});

test('competition_slug: misma regla que el UPDATE SQL', () => {
  assert.equal(competitionSlug('LaLiga EA Sports'), 'la_liga');
  assert.equal(competitionSlug('Primera Division (La Liga)'), 'la_liga');
  assert.equal(competitionSlug('UEFA Champions League'), 'champions_league');
  assert.equal(competitionSlug('Premier League'), 'excluded');
  assert.equal(competitionSlug('Europa League'), 'excluded');
  assert.deepEqual(ACTIVE_CODES, ['PD', 'CL']);
  assert.equal(isActiveCompetition('PL'), false);
});

test('mercados: doble oportunidad, BTTS y hándicap asiático desde la matriz', () => {
  const m = scoreMatrix(1.6, 1.1, -0.05);
  const p = modelFixedProbabilities(m);
  assert.ok(Math.abs(p.dc_1x - (p.home + p.draw)) < 1e-12);
  assert.ok(Math.abs(p.btts_yes + p.btts_no - 1) < 1e-12);
  // AH local −0.5 = gana local
  const ah = asianHandicapFromMatrix(m, 'home', -0.5);
  assert.ok(Math.abs(ah.probability - p.home) < 1e-9);
  assert.ok(Math.abs(ah.stakeAtRisk - 1) < 1e-9);
  // AH 0 (empate devuelve) = local / (local + visitante)
  const ah0 = asianHandicapFromMatrix(m, 'home', 0);
  assert.ok(Math.abs(ah0.probability - p.home / (p.home + p.away)) < 1e-9);
  assert.ok(Math.abs(ah0.stakeAtRisk - (1 - p.draw)) < 1e-9);
});

test('liquidación de todos los mercados, incluido hándicap de cuarto', () => {
  assert.equal(settleSelection('dc_x2', 1, 1), 'won');
  assert.equal(settleSelection('btts_yes', 2, 0), 'lost');
  assert.equal(settleSelection(ahSelection('home', -1), 2, 1), 'void');
  assert.equal(settleSelection(ahSelection('home', -0.75), 2, 1), 'half_won');
  assert.equal(settleSelection(ahSelection('away', 0.25), 1, 1), 'half_won');
  assert.equal(settleSelection(ahSelection('away', 0.25), 2, 1), 'lost');
  assert.equal(settleSelection(ahSelection('home', 0.5), 1, 1), 'won');
  assert.equal(settleSelection(ahSelection('home', -0.25), 1, 1), 'half_lost');
  assert.equal(profitPerUnit('half_won', 2), 0.5);
  assert.equal(swapSelection('dc_1x'), 'dc_x2');
  assert.equal(swapSelection(ahSelection('home', -0.5)), 'ah_away@-0.5');
  assert.equal(marketOf('ah_away@+1.5'), 'asian_handicap');
});

test('mercado sin margen excluye a Caliente MX del consenso', () => {
  const books = [
    { bookmaker: 'a', prices: { home: 2.0, draw: 3.4, away: 3.8 } },
    { bookmaker: 'b', prices: { home: 2.05, draw: 3.3, away: 3.7 } },
    { bookmaker: 'caliente_mx', prices: { home: 3.0, draw: 3.0, away: 3.0 } }
  ];
  const { probs, books: counts } = marketConsensus(books);
  assert.equal(counts.home, 2);
  assert.ok(Math.abs(probs.home + probs.draw + probs.away - 1) < 1e-9);
  assert.ok(probs.home > 0.45 && probs.home < 0.5);
  assert.ok(Math.abs(probs.dc_1x - (probs.home + probs.draw)) < 1e-12);
});

test('calibración: isotónica monótona y texto explicativo', () => {
  // Modelo sobreconfiado: dice 68 %, gana 61 %
  const samples = [];
  for (let i = 0; i < 400; i++) samples.push({ p: 0.68, y: i % 100 < 61 });
  for (let i = 0; i < 400; i++) samples.push({ p: 0.35, y: i % 100 < 35 });
  const cal = fitCalibrator('la_liga_1x2', samples);
  assert.equal(cal.method, 'isotonic');
  assert.ok(Math.abs(applyCalibrator(cal, 0.68) - 0.61) < 0.01);
  const e = explainCalibration(cal, 0.68);
  assert.match(e.text, /El modelo dijo 68%, pero en ese rango \(60–70%\) ha ganado 61% históricamente/);
  assert.match(e.text, /probabilidad calibrada: 61%/);

  const blocks = fitIsotonic([{ p: 0.1, y: 1 }, { p: 0.2, y: 0 }, { p: 0.3, y: 1 }]);
  for (let i = 1; i < blocks.length; i++) assert.ok(blocks[i].y >= blocks[i - 1].y);

  assert.equal(fitCalibrator('x', samples.slice(0, 20)).method, 'identity');
  assert.equal(fitCalibrator('x', samples.slice(0, 120)).method, 'platt');
});

test('evaluateEngine usa la cuota de Caliente MX, no la mejor del mercado', () => {
  const matrix = scoreMatrix(1.9, 0.9, -0.05);
  const p = modelFixedProbabilities(matrix);
  const books = ['a', 'b', 'c', 'd'].map(k => ({ bookmaker: k, prices: { home: 1.0 / (p.home - 0.03) * 0.97, draw: 4.2, away: 5.5 } }));
  books.push({ bookmaker: 'best', prices: { home: 2.4, draw: 4.0, away: 5.0 } });
  const caliente = { home: { current: { odds: 1.55, capturedAt: '2026-10-08T12:00:00Z', source: 'manual' } } };
  const out = evaluateEngine({ matrix, competitionSlug: 'la_liga', books, caliente });
  const home = out.find(e => e.selection === 'home');
  assert.equal(home.caliente.odds, 1.55);
  assert.ok(Math.abs(home.ev - (p.home * 1.55 - 1)) < 1e-9);
  assert.equal(home.bestOtherOdds, 2.4);
  const draw = out.find(e => e.selection === 'draw');
  assert.equal(draw.reason, 'No hay cuota de Caliente MX');
  assert.ok(draw.minCalienteOdds >= DEFAULT_ENGINE_RULES.minOdds);
});

test('Performance Lab: ROI, yield, CLV y calibración por rangos', () => {
  const s = (o) => ({ competitionSlug: 'la_liga', competition: 'LaLiga EA Sports', market: '1x2', marketLabel: '1X2', stake: 100, ev: 0.06, modelProbability: 0.62, modelProbabilityRaw: 0.66, calienteOdds: 1.8, marketAvgOdds: 1.75, ...o });
  const perf = computePerformance([
    s({ status: 'won', profit: 80, clv: 0.03 }),
    s({ status: 'lost', profit: -100, clv: -0.01 }),
    s({ status: 'won', profit: 80, clv: 0.02, market: 'over_under', marketLabel: 'Más/Menos 2.5' }),
    s({ status: 'pending', profit: null, clv: null, competitionSlug: 'champions_league', competition: 'UEFA Champions League' })
  ], { days: 30, bankroll: 5000 });
  assert.equal(perf.totals.signals, 4);
  assert.equal(perf.totals.settled, 3);
  assert.equal(perf.totals.profit, 60);
  assert.equal(perf.totals.yieldPct, 20);
  assert.equal(perf.totals.roiPct, 1.2);
  assert.equal(perf.totals.clvPositivePct, 66.7);
  assert.equal(perf.calibration.find(c => c.range === '60–70%').signals, 3);
  assert.equal(perf.byCompetition.length, 2);
  assert.ok(perf.calienteVsMarket.avgPremiumPct > 0);
  assert.match(perf.keyQuestion.verdict, /Muestra insuficiente/);
});
