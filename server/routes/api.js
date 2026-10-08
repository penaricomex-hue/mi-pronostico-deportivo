import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MODEL_VERSION, MODEL_NAME } from '../version.js';
import { publicConfig } from '../config.js';
import { ALL_COMPETITIONS, COMPETITION_NAMES } from '../services/analysis.js';
import { ACTIVE_COMPETITIONS, EXCLUDED_COMPETITIONS } from '../competitions.js';
import { collectValuePicks, buildParlays } from '../services/picks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_FILE = path.resolve(__dirname, '..', '..', 'data', 'backtest-report.json');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseCommon(req) {
  const comp = String(req.query.competition || '').trim().toUpperCase();
  if (comp && !ALL_COMPETITIONS.includes(comp)) {
    const err = new Error('Competición desactivada: MK Bets solo cubre LaLiga EA Sports (PD) y UEFA Champions League (CL).');
    err.status = 400;
    throw err;
  }
  const competition = comp || null;
  const tzRaw = Number(req.query.tz);
  const tzOffset = Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 840 ? tzRaw : 0;
  const dateRaw = String(req.query.date || '').trim();
  const date = DATE_RE.test(dateRaw) ? dateRaw : new Date(Date.now() - tzOffset * 60000).toISOString().slice(0, 10);
  return { competition, tzOffset, date };
}

/** Envuelve handlers async y transforma errores en JSON con estado correcto. */
const wrap = fn => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status === 500) console.error(`[api] ${req.method} ${req.path}: ${err.stack || err.message}`);
    res.status(status).json({ ok: false, error: err.message });
  }
};

let reportCache = null;
function loadReport() {
  if (!reportCache) {
    try { reportCache = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')); } catch { reportCache = null; }
  }
  return reportCache;
}

function requireService(svc, name) {
  if (!svc) {
    const err = new Error(`${name} no disponible: configura DATABASE_URL.`);
    err.status = 503;
    throw err;
  }
  return svc;
}

export function createApiRouter({ analysis, bets, ratings, footballData, odds, store, teams, bankroll, signals = null, caliente = null, calibration = null, engineRules = null }) {
  const r = express.Router();

  r.get('/status', wrap(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      modelVersion: MODEL_VERSION,
      modelName: MODEL_NAME,
      config: publicConfig(),
      persistentStore: store.persistent,
      competitions: COMPETITION_NAMES,
      activeCompetitions: ACTIVE_COMPETITIONS,
      excludedCompetitions: EXCLUDED_COMPETITIONS,
      engineRules,
      calibration: calibration ? calibration.summary().map(c => ({ key: c.key, method: c.method, n: c.n, liveSamples: c.liveSamples })) : [],
      model: ratings.summary(),
      providers: {
        footballData: footballData.stats(),
        oddsApi: await odds.quotaStatus()
      },
      unresolvedTeams: teams.unresolved()
    });
  }));

  r.get('/fixtures', wrap(async (req, res) => {
    const { competition, tzOffset, date } = parseCommon(req);
    const { fixtures, warnings } = await analysis.getFixtures({ date, competition, tzOffset });
    res.json({ ok: true, date, competition, count: fixtures.length, fixtures, warnings });
  }));

  r.get('/analyze', wrap(async (req, res) => {
    const { competition, tzOffset, date } = parseCommon(req);
    const id = String(req.query.id || '').trim() || null;
    const home = String(req.query.home || '').trim();
    const away = String(req.query.away || '').trim();
    if (!id && (!home || !away)) return res.status(400).json({ ok: false, error: 'Indica id o home y away.' });
    const fixture = await analysis.findFixture({ id, date, competition, tzOffset, home, away });
    if (!fixture) return res.status(404).json({ ok: false, error: 'No se encontró el partido en esa fecha.' });
    const result = await analysis.analyzeFixture(fixture);
    res.json({ ok: true, modelVersion: MODEL_VERSION, analysis: result });
  }));

  r.get('/value-bets', wrap(async (req, res) => {
    const { competition, tzOffset, date } = parseCommon(req);
    const days = Math.min(5, Math.max(1, Number(req.query.days) || 3));
    const includeUnvalidated = req.query.includeUnvalidated === 'true';
    const { analyses, warnings } = await analysis.analyzeRange({ fromDate: date, days, competition, tzOffset });
    const picks = collectValuePicks(analyses, { includeUnvalidated });
    res.json({
      ok: true,
      modelVersion: MODEL_VERSION,
      analyzed: analyses.length,
      withOdds: analyses.filter(a => a.odds.available).length,
      picks: picks.validated,
      unvalidatedPicks: picks.unvalidated,
      leagues: ratings.summary().leagues,
      warnings
    });
  }));

  r.get('/parlay', wrap(async (req, res) => {
    const { competition, tzOffset, date } = parseCommon(req);
    const legs = Math.min(4, Math.max(2, Number(req.query.legs) || 3));
    const includeUnvalidated = req.query.includeUnvalidated === 'true';
    const { analyses, warnings } = await analysis.analyzeRange({ fromDate: date, days: 3, competition, tzOffset });
    const picks = collectValuePicks(analyses, { includeUnvalidated });
    const pool = includeUnvalidated ? [...picks.validated, ...picks.unvalidated] : picks.validated;
    res.json({
      ok: true,
      modelVersion: MODEL_VERSION,
      assumption: 'La probabilidad combinada supone independencia entre partidos.',
      parlays: buildParlays(pool, { maxLegs: legs, bankroll }),
      candidates: pool.length,
      warnings
    });
  }));

  r.get('/ratings', wrap(async (req, res) => {
    const { competition } = parseCommon(req);
    if (!competition) return res.status(400).json({ ok: false, error: 'Indica competition.' });
    const model = await ratings.getRatings(competition);
    if (!model) return res.status(404).json({ ok: false, error: 'Sin modelo para esta competición.' });
    const teamsList = Object.entries(model.teams)
      .filter(([, t]) => t.active !== false)
      .map(([name, t]) => ({
        name,
        attack: Number(Math.exp(t.att).toFixed(3)),
        defense: Number(Math.exp(t.def).toFixed(3)),
        matches: t.matches,
        effectiveMatches: t.effectiveMatches
      }))
      .sort((a, b) => (b.attack / b.defense) - (a.attack / a.defense));
    res.json({
      ok: true,
      competition,
      asOf: model.asOf,
      homeAdvantage: Number(model.homeAdvantageFactor.toFixed(3)),
      rho: model.rho,
      matches: model.nMatches,
      teams: teamsList
    });
  }));

  r.get('/backtest', wrap(async (req, res) => {
    const report = loadReport();
    if (!report) return res.status(404).json({ ok: false, error: 'No hay informe. Ejecuta npm run backtest.' });
    const { competition } = parseCommon(req);
    if (competition) {
      const lg = report.leagues[competition];
      if (lg && !ALL_COMPETITIONS.includes(competition)) return res.status(404).json({ ok: false, error: 'Competición desactivada.' });
      if (!lg) return res.status(404).json({ ok: false, error: 'Esta competición no tiene backtest (sin historial con cuotas).' });
      return res.json({ ok: true, modelVersion: report.modelVersion, generatedAt: report.generatedAt, competition, ...lg });
    }
    const leagues = Object.fromEntries(Object.entries(report.leagues).filter(([k]) => ALL_COMPETITIONS.includes(k)).map(([k, v]) => [k, {
      xi: v.xi, weights: v.weights, valueEnabled: v.valueEnabled, trainSeasons: v.trainSeasons, testSeasons: v.testSeasons,
      test: { matches: v.test.matches, metrics: v.test.metrics, verdicts: v.test.verdicts, betting: { ...v.test.betting, recentBets: undefined } }
    }]));
    res.json({ ok: true, modelVersion: report.modelVersion, generatedAt: report.generatedAt, leagues });
  }));

  // Motor de valor: señales con la cuota real de Caliente MX
  r.get('/signals/preview', wrap(async (req, res) => {
    const { competition, tzOffset } = parseCommon(req);
    const days = Math.min(7, Math.max(1, Number(req.query.days) || 4));
    res.json({ ok: true, modelVersion: MODEL_VERSION, rules: engineRules, ...(await requireService(signals, 'Señales').preview({ days, tzOffset, competition })) });
  }));
  r.get('/signals', wrap(async (req, res) => {
    res.json({ ok: true, signals: await requireService(signals, 'Señales').list({ days: Number(req.query.days) || 30 }) });
  }));
  r.post('/signals/generate', wrap(async (req, res) => {
    const { tzOffset } = parseCommon(req);
    res.json({ ok: true, ...(await requireService(signals, 'Señales').generate({ tzOffset, dryRun: req.query.dryRun === 'true' })) });
  }));
  r.post('/signals/settle', wrap(async (_req, res) => {
    const svc = requireService(signals, 'Señales');
    const settled = await svc.settle();
    const clv = await svc.computeClv();
    res.json({ ok: true, ...settled, clvUpdated: clv });
  }));
  r.get('/performance', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, ...(await requireService(signals, 'Rendimiento').performance({ days: Number(req.query.days) || 30 })) });
  }));

  // Caliente MX: captura de cuotas (manual o feed)
  r.post('/caliente/odds', wrap(async (req, res) => {
    res.status(201).json({ ok: true, ...(await requireService(caliente, 'Caliente MX').saveManual(req.body)) });
  }));
  r.post('/caliente/sync', wrap(async (_req, res) => {
    res.json({ ok: true, ...(await requireService(caliente, 'Caliente MX').syncFeed()) });
  }));

  // Calibración por competición y mercado
  r.get('/calibration', wrap(async (_req, res) => {
    res.json({ ok: true, models: requireService(calibration, 'Calibración').summary() });
  }));
  r.post('/calibration/refit', wrap(async (_req, res) => {
    res.json({ ok: true, ...(await requireService(calibration, 'Calibración').refit()) });
  }));

  // Apuestas simuladas
  r.get('/bets', wrap(async (req, res) => {
    res.json({ ok: true, bets: await bets.list({ period: String(req.query.period || '') }) });
  }));
  r.get('/bets/summary', wrap(async (req, res) => {
    res.json({ ok: true, ...(await bets.summary({ period: String(req.query.period || 'month') })) });
  }));
  r.post('/bets', wrap(async (req, res) => {
    res.status(201).json({ ok: true, bet: await bets.create(req.body) });
  }));
  r.post('/bets/auto-settle', wrap(async (_req, res) => {
    res.json({ ok: true, ...(await bets.autoSettle()) });
  }));
  r.post('/bets/:id/settle', wrap(async (req, res) => {
    res.json({ ok: true, bet: await bets.settleManual(req.params.id, req.body?.result) });
  }));
  r.delete('/bets/:id', wrap(async (req, res) => {
    res.json(await bets.remove(req.params.id));
  }));

  r.use((_req, res) => res.status(404).json({ ok: false, error: 'Ruta no encontrada.' }));
  return r;
}
