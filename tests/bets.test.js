import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSelectionResult, settleParlay, legacySelection, computeProfit } from '../server/services/bets.js';
import { localDayRange } from '../server/services/analysis.js';

test('liquidación de selecciones', () => {
  assert.equal(evaluateSelectionResult('home', 2, 1), 'won');
  assert.equal(evaluateSelectionResult('draw', 1, 1), 'won');
  assert.equal(evaluateSelectionResult('away', 1, 1), 'lost');
  assert.equal(evaluateSelectionResult('over25', 2, 1), 'won');
  assert.equal(evaluateSelectionResult('under25', 2, 1), 'lost');
  assert.equal(evaluateSelectionResult('home', NaN, 1), null);
});

test('combinadas', () => {
  assert.equal(settleParlay([{ status: 'won', odds: 2 }, { status: 'lost', odds: 2 }]).status, 'lost');
  assert.equal(settleParlay([{ status: 'won', odds: 2 }, { status: 'pending', odds: 2 }]).status, 'pending');
  const w = settleParlay([{ status: 'won', odds: 2 }, { status: 'void', odds: 3 }, { status: 'won', odds: 1.5 }]);
  assert.equal(w.status, 'won');
  assert.equal(w.odds, 3, 'una pata anulada se elimina de la cuota');
  assert.equal(settleParlay([{ status: 'void', odds: 2 }, { status: 'void', odds: 2 }]).status, 'void');
});

test('compatibilidad con apuestas antiguas y beneficio', () => {
  assert.equal(legacySelection('totals', 'over'), 'over25');
  assert.equal(legacySelection('h2h', 'draw'), 'draw');
  assert.equal(computeProfit('won', 100, 2.5), 150);
  assert.equal(computeProfit('lost', 100, 2.5), -100);
  assert.equal(computeProfit('void', 100, 2.5), 0);
});

test('el día local respeta la zona horaria del usuario (México, UTC−6)', () => {
  const r = localDayRange('2026-10-10', 360);
  assert.equal(new Date(r.start).toISOString(), '2026-10-10T06:00:00.000Z');
  assert.equal(r.end - r.start, 86400000);
});
