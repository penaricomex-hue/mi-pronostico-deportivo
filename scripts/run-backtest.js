#!/usr/bin/env node
/**
 * Backtest walk-forward v10 (solo LaLiga y Champions). Genera:
 *   data/backtest-report.json    métricas completas (servido por /api/backtest)
 *   data/model-params.json       ξ por competición (usado en producción)
 *   data/calibration-seed.json   observaciones fuera de muestra para la calibración
 *
 * Uso: npm run backtest          (PD y CL)
 *      node scripts/run-backtest.js PD
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBundledHistory, SUPPORTED_MODEL_LEAGUES } from '../server/providers/history.js';
import { runLeagueBacktest } from '../server/backtest/walkForward.js';
import { MODEL_VERSION } from '../server/version.js';
import { ACTIVE_COMPETITIONS } from '../server/competitions.js';
import { mapKey } from '../server/model/calibration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const leagues = process.argv.slice(2).length ? process.argv.slice(2).map(s => s.toUpperCase()) : SUPPORTED_MODEL_LEAGUES;

const generatedAt = new Date().toISOString();
const reportFile = path.join(DATA_DIR, 'backtest-report.json');
const paramsFile = path.join(DATA_DIR, 'model-params.json');
const seedFile = path.join(DATA_DIR, 'calibration-seed.json');

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const report = { modelVersion: MODEL_VERSION, generatedAt, leagues: {} };
const prevReport = readJson(reportFile, { leagues: {} });
for (const [k, v] of Object.entries(prevReport.leagues || {})) if (ACTIVE_COMPETITIONS[k] && !leagues.includes(k)) report.leagues[k] = v;
const params = { modelVersion: MODEL_VERSION, generatedAt, leagues: {} };
const prevParams = readJson(paramsFile, { leagues: {} });
for (const k of Object.keys(ACTIVE_COMPETITIONS)) if (prevParams.leagues?.[k] && !leagues.includes(k)) params.leagues[k] = prevParams.leagues[k];
const seed = readJson(seedFile, { maps: {} });
seed.modelVersion = MODEL_VERSION;
seed.generatedAt = generatedAt;
seed.note = 'Cubetas de 1 punto: n = predicciones fuera de muestra, wins = aciertos. Probabilidad ORIGINAL del modelo.';

for (const league of leagues) {
  const comp = ACTIVE_COMPETITIONS[league];
  if (!comp) { console.warn(`${league}: competición desactivada en v10, se omite.`); continue; }
  const t0 = Date.now();
  const matches = loadBundledHistory(league);
  const seasons = [...new Set(matches.map(m => m.season))].sort();
  if (seasons.length < 3) { console.warn(`${league}: se necesitan al menos 3 temporadas (hay ${seasons.length}).`); continue; }

  // La primera temporada solo es historial inicial. Champions tiene menos partidos
  // por temporada: entrena con 1 y prueba con el resto.
  const trainSeasons = league === 'CL' ? seasons.slice(1, 2) : seasons.slice(1, 3);
  const testSeasons = league === 'CL' ? seasons.slice(2) : seasons.slice(3);

  const { report: res, seed: bins } = runLeagueBacktest(matches, {
    slug: comp.slug, trainSeasons, testSeasons, hasOdds: comp.hasHistoricalOdds,
    xiGrid: league === 'CL' ? [0.0008, 0.0012, 0.0019, 0.003] : [0.0012, 0.0019, 0.003, 0.005]
  });
  report.leagues[league] = { competition: comp.name, ...res };
  params.leagues[league] = {
    xi: res.xi,
    slug: comp.slug,
    testBets: res.betting?.bets ?? null,
    testYieldPct: res.betting?.yieldPct ?? null,
    testClvPct: res.betting?.avgClvPct ?? null
  };
  for (const [g, b] of Object.entries(bins)) seed.maps[mapKey(comp.slug, g)] = b;

  const t = res.test;
  const b = res.betting;
  console.log(
    `${league} (${((Date.now() - t0) / 1000).toFixed(1)}s) ξ=${res.xi} | prueba n=${t.matches} ` +
    `Brier modelo=${t.metrics.model.brier} calibrado=${t.metrics.calibrated.brier} mercado=${t.metrics.market.brier} | ` +
    `LogLoss modelo=${t.metrics.model.logLoss} calibrado=${t.metrics.calibrated.logLoss} mercado=${t.metrics.market.logLoss}` +
    (b ? ` | señales=${b.bets} yield=${b.yieldPct}% CLV=${b.avgClvPct}% CLV+=${b.clvPositivePct}%` : ' | sin cuotas históricas')
  );
}

fs.writeFileSync(reportFile, JSON.stringify(report, null, 1));
fs.writeFileSync(paramsFile, JSON.stringify(params, null, 2));
fs.writeFileSync(seedFile, JSON.stringify(seed));
console.log('Guardado: data/backtest-report.json, data/model-params.json y data/calibration-seed.json');
