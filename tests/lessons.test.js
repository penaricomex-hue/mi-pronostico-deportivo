import test from 'node:test';
import assert from 'node:assert/strict';
import { criteriaFromBets, outcomeBit, normalizeTags } from '../server/services/lessons.js';
import { renderReport } from '../server/services/reports.js';

test('una apuesta manual ganadora no mueve el umbral hasta tener muestra', () => {
  const few = criteriaFromBets([
    { source: 'manual', market: '1x2', competition_slug: 'la_liga', status: 'won', stake: 100, profit: 80, tags: 'forma' }
  ]);
  assert.equal(few.groups[0].minEvDelta, 0);
  assert.equal(few.groups[0].stance, 'pocos datos');
  assert.equal(outcomeBit('void'), null);
  assert.deepEqual(normalizeTags(['forma', 'nba', 'forma']), ['forma']);
});

test('ocho aciertos con ROI positivo aflojan el EV; una racha mala lo aprieta', () => {
  const good = Array.from({ length: 8 }, () => ({
    source: 'manual', market: 'over_under', competition_slug: 'champions_league',
    status: 'won', stake: 100, profit: 20, tags: 'goles'
  }));
  const up = criteriaFromBets(good);
  assert.equal(up.groups[0].minEvDelta, -0.01);
  assert.equal(up.groups[0].topTag, 'goles');

  const bad = Array.from({ length: 8 }, () => ({
    source: 'manual', market: 'btts', competition_slug: 'la_liga',
    status: 'lost', stake: 100, profit: -100, tags: 'bajas'
  }));
  assert.equal(criteriaFromBets(bad).groups[0].minEvDelta, 0.01);
});

test('el informe es de fútbol y nombra el correo', () => {
  const text = renderReport({
    to: 'penaricomex@gmail.com',
    generatedAt: '2026-10-27T00:00:00.000Z',
    currency: 'MXN',
    signals: { signals: 10, resolved: 4, pending: 6, hitRatePct: 50, roiPct: 3, profit: 30, avgClvPct: 1.2, clvSample: 4 },
    manual: { total: 2, pending: 1, won: 1, lost: 0, hitRatePct: 100, roiPct: 12, profit: 40, currency: 'MXN' },
    learned: 1,
    criteria: { minSample: 8, groups: [] },
    calibration: { maps: {} }
  });
  assert.match(text, /penaricomex@gmail.com/);
  assert.match(text, /LaLiga/);
  assert.match(text, /Champions/);
  assert.doesNotMatch(text, /baloncesto|basketball|NBA/i);
});
