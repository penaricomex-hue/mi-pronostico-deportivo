#!/usr/bin/env node
/**
 * Ejecuta el backtest walk-forward con datos reales y genera:
 *   data/backtest-report.json  (métricas completas, servido por /api/backtest)
 *   data/model-params.json     (ξ, pesos de mezcla y valueEnabled por liga, usados en producción)
 *
 * Uso: npm run backtest            (todas las ligas)
 *      node scripts/run-backtest.js PD PL
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBundledHistory, SUPPORTED_MODEL_LEAGUES } from '../server/providers/history.js';
import { runLeagueBacktest } from '../server/backtest/walkForward.js';
import { MODEL_VERSION } from '../server/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

const leagues = process.argv.slice(2).length ? process.argv.slice(2) : SUPPORTED_MODEL_LEAGUES;

const report = { modelVersion: MODEL_VERSION, generatedAt: new Date().toISOString(), leagues: {} };
const paramsFile = path.join(DATA_DIR, 'model-params.json');
const params = fs.existsSync(paramsFile) ? JSON.parse(fs.readFileSync(paramsFile, 'utf8')) : { leagues: {} };
params.modelVersion = MODEL_VERSION;
params.generatedAt = report.generatedAt;

for (const league of leagues) {
  const t0 = Date.now();
  const matches = loadBundledHistory(league);
  const seasons = [...new Set(matches.map(m => m.season))].sort();
  if (seasons.length < 4) {
    console.warn(`${league}: se necesitan al menos 4 temporadas (hay ${seasons.length}).`);
    continue;
  }
  // La primera temporada solo sirve de historial inicial.
  // Entrenamiento: las dos siguientes. Prueba: el resto (incluida la temporada en curso).
  const trainSeasons = seasons.slice(1, 3);
  const testSeasons = seasons.slice(3);

  const res = runLeagueBacktest(matches, { trainSeasons, testSeasons });
  report.leagues[league] = res;
  params.leagues[league] = {
    xi: res.xi,
    w1x2: res.weights.w1x2,
    wOU: res.weights.wOU,
    valueEnabled: res.valueEnabled,
    testClvPct: res.test.betting.avgClvPct,
    testRoiPct: res.test.betting.roiPct,
    testBets: res.test.betting.bets
  };

  const t = res.test;
  console.log(
    `${league} (${((Date.now() - t0) / 1000).toFixed(1)}s) ξ=${res.xi} w1x2=${res.weights.w1x2} wOU=${res.weights.wOU} | ` +
    `prueba n=${t.matches} Brier modelo=${t.metrics.model.brier} mezcla=${t.metrics.blended.brier} mercado=${t.metrics.market.brier} | ` +
    `LogLoss modelo=${t.metrics.model.logLoss} mezcla=${t.metrics.blended.logLoss} mercado=${t.metrics.market.logLoss} | ` +
    `apuestas=${t.betting.bets} ROI=${t.betting.roiPct}% CLV=${t.betting.avgClvPct}% valor=${res.valueEnabled}`
  );
}

fs.writeFileSync(path.join(DATA_DIR, 'backtest-report.json'), JSON.stringify(report, null, 1));
fs.writeFileSync(paramsFile, JSON.stringify(params, null, 2));
console.log('Informe guardado en data/backtest-report.json y parámetros en data/model-params.json');
