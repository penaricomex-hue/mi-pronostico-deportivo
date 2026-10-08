import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreMatrix, matchProbabilities, poissonPmf } from '../server/model/poisson.js';
import { fitDixonColes, expectedGoals } from '../server/model/dixonColes.js';
import { blendProbabilities, evaluateSelections, predictMatch } from '../server/model/predict.js';
import { brier1x2, rps1x2, outcomeOf } from '../server/model/metrics.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function samplePoisson(lambda, rand) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

test('poissonPmf suma 1', () => {
  let s = 0;
  for (let k = 0; k < 40; k++) s += poissonPmf(k, 1.7);
  assert.ok(Math.abs(s - 1) < 1e-9);
});

test('la matriz de marcadores está normalizada y es simétrica con λ = μ', () => {
  const m = scoreMatrix(1.3, 1.3, -0.08);
  const total = m.flat().reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
  const p = matchProbabilities(1.3, 1.3, -0.08);
  assert.ok(Math.abs(p.home - p.away) < 1e-9);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-9);
  assert.ok(Math.abs(p.over25 + p.under25 - 1) < 1e-9);
});

test('rho negativo aumenta la probabilidad de empate', () => {
  assert.ok(matchProbabilities(1.2, 1.1, -0.1).draw > matchProbabilities(1.2, 1.1, 0).draw);
});

test('Dixon-Coles recupera el orden de fuerza y la ventaja local de datos sintéticos', () => {
  const rand = rng(42);
  const truth = { A: 0.45, B: 0.25, C: 0.05, D: -0.05, E: -0.25, F: -0.45 };
  const teams = Object.keys(truth);
  const matches = [];
  const start = new Date('2023-08-01T12:00:00Z').getTime();
  let day = 0;
  for (let round = 0; round < 8; round++) {
    for (const h of teams) for (const a of teams) {
      if (h === a) continue;
      const lambda = Math.exp(0.15 + 0.25 + truth[h] - truth[a] * 0.8);
      const mu = Math.exp(0.15 + truth[a] - truth[h] * 0.8);
      const date = new Date(start + day * 86400000).toISOString().slice(0, 10);
      matches.push({ date, home: h, away: a, hg: samplePoisson(lambda, rand), ag: samplePoisson(mu, rand) });
      day += 1;
    }
  }
  const asOf = new Date(start + (day + 1) * 86400000).toISOString().slice(0, 10);
  const model = fitDixonColes(matches, { asOf, xi: 0.0005 });
  assert.equal(model.ok, true);
  const strength = t => model.teams[t].att - model.teams[t].def;
  assert.ok(strength('A') > strength('C') && strength('C') > strength('F'), 'orden de fuerza');
  assert.ok(Math.exp(model.homeAdvantage) > 1.1 && Math.exp(model.homeAdvantage) < 1.5, 'ventaja local ~1.28');
  const xg = expectedGoals(model, 'A', 'F');
  assert.ok(xg.lambda > xg.mu);
});

test('el ajuste no usa partidos posteriores a asOf (sin fuga de información)', () => {
  const base = [];
  for (let i = 0; i < 60; i++) base.push({ date: `2024-01-${String((i % 28) + 1).padStart(2, '0')}`, home: `T${i % 6}`, away: `T${(i + 1) % 6}`, hg: i % 3, ag: (i + 1) % 2 });
  const future = [{ date: '2024-03-01', home: 'T0', away: 'T1', hg: 9, ag: 0 }];
  const a = fitDixonColes(base, { asOf: '2024-02-15' });
  const b = fitDixonColes([...base, ...future], { asOf: '2024-02-15' });
  assert.deepEqual(a.teams.T0, b.teams.T0);
});

test('la mezcla respeta los pesos y normaliza', () => {
  const model = { home: 0.5, draw: 0.3, away: 0.2, over25: 0.6, under25: 0.4 };
  const market = { home: 0.4, draw: 0.3, away: 0.3, over25: 0.5, under25: 0.5 };
  assert.equal(blendProbabilities(model, market, { w1x2: 0, wOU: 0 }).final.home, 0.4);
  const half = blendProbabilities(model, market, { w1x2: 0.5, wOU: 1 }).final;
  assert.ok(Math.abs(half.home - 0.45) < 1e-12);
  assert.equal(half.over25, 0.6);
  const onlyModel = blendProbabilities(model, null, { w1x2: 0 }).final;
  assert.equal(onlyModel.home, 0.5, 'sin mercado se usa el modelo');
});

test('evaluateSelections aplica todas las reglas de valor', () => {
  const pred = predictMatch({ ratings: null, home: 'X', away: 'Y', market: { home: 0.5, draw: 0.28, away: 0.22, over25: 0.5, under25: 0.5 }, params: { w1x2: 0, wOU: 0 } });
  pred.modelAvailable = true; // simular liga con modelo
  const prices = {
    home: { best: 2.2, reference: 2.1, secondBest: 2.15, count: 6, bestBookmaker: 'A' },   // EV +10%
    draw: { best: 4.6, reference: 3.6, secondBest: 3.7, count: 6 },                          // atípica
    away: { best: 6.0, reference: 5.8, secondBest: 5.9, count: 6 },                          // cuota alta
    over25: { best: 2.1, reference: 2.05, secondBest: 2.08, count: 2 }                       // pocas casas
  };
  const off = evaluateSelections(pred, prices, { valueEnabled: false });
  const home = off.find(s => s.selection === 'home');
  assert.equal(home.passesRules, true);
  assert.equal(home.isValue, false, 'liga no validada nunca marca valor');
  const on = evaluateSelections(pred, prices, { valueEnabled: true });
  assert.equal(on.find(s => s.selection === 'home').isValue, true);
  assert.ok(on.find(s => s.selection === 'draw').reasons.includes('Cuota atípica'));
  assert.ok(on.find(s => s.selection === 'away').reasons.includes('Cuota demasiado alta'));
  assert.ok(on.find(s => s.selection === 'over25').reasons.some(r => r.startsWith('Menos de 3')));
});

test('métricas: Brier y RPS de una predicción perfecta valen 0', () => {
  assert.equal(outcomeOf(2, 1), 'home');
  assert.equal(brier1x2({ home: 1, draw: 0, away: 0 }, 'home'), 0);
  assert.equal(rps1x2({ home: 0, draw: 0, away: 1 }, 'away'), 0);
  assert.ok(brier1x2({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, 'draw') > 0.6);
});
