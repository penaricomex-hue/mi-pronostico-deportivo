import test from 'node:test';
import assert from 'node:assert/strict';
import { devig, kellyStake, isOutlierPrice, consensus, priceSummary, expectedValue } from '../server/model/market.js';

test('devig quita el margen y suma 1', () => {
  const r = devig([1.9, 3.5, 4.2]);
  assert.ok(Math.abs(r.probs.reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(r.overround > 0);
});

test('EV = p·cuota − 1', () => {
  assert.ok(Math.abs(expectedValue(0.5, 2.2) - 0.1) < 1e-12);
  assert.equal(expectedValue(0.5, 1), null);
});

test('Kelly fraccional con tope y cero sin ventaja', () => {
  assert.equal(kellyStake({ probability: 0.4, odds: 2.0, bankroll: 5000 }), 0);
  const s = kellyStake({ probability: 0.55, odds: 2.0, bankroll: 5000, fraction: 0.25, maxPct: 0.02 });
  assert.equal(s, 100, 'Kelly completo 10% → ¼ = 2.5% → tope 2% = 100');
  assert.equal(kellyStake({ probability: 0.52, odds: 2.0, bankroll: 5000, fraction: 0.25, maxPct: 0.05 }), 50);
});

test('cuotas atípicas', () => {
  assert.equal(isOutlierPrice(2.5, 2.1), true);
  assert.equal(isOutlierPrice(2.2, 2.1, 2.15), false);
  assert.equal(isOutlierPrice(2.4, 2.2, 2.15), true);
});

test('consenso de mercado y resumen de precios', () => {
  const books = [
    { bookmaker: 'a', prices: { h: 2.0, d: 3.4, a: 3.8 } },
    { bookmaker: 'b', prices: { h: 2.1, d: 3.3, a: 3.6 } },
    { bookmaker: 'c', prices: { h: 0, d: 3.3, a: 3.6 } }
  ];
  const c = consensus(books, ['h', 'd', 'a']);
  assert.equal(c.bookmakers, 2);
  assert.ok(Math.abs(c.probs.h + c.probs.d + c.probs.a - 1) < 1e-12);
  const ps = priceSummary([{ bookmaker: 'a', odds: 2.0 }, { bookmaker: 'b', odds: 2.1 }, { bookmaker: 'c', odds: 1.95 }]);
  assert.equal(ps.best, 2.1);
  assert.equal(ps.bestBookmaker, 'b');
  assert.equal(ps.secondBest, 2.0);
  assert.equal(ps.reference, 2.0);
  assert.equal(ps.count, 3);
});
