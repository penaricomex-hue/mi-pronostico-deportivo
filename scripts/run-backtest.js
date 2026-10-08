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
import { runLeagueBacktest, generateRecords } from '../server/backtest/walkForward.js';
import { runEngineBacktest, calibrationSamples } from '../server/backtest/engineBacktest.js';
import { ACTIVE_COMPETITIONS } from '../server/competitions.js';
import { MODEL_VERSION } from '../server/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');

// Solo LaLiga y Champions: el resto de ligas está desactivado.
const leagues = (process.argv.slice(2).length ? process.argv.slice(2) : SUPPORTED_MODEL_LEAGUES).filter(l => SUPPORTED_MODEL_LEAGUES.includes(l));
const seed = { generatedAt: new Date().toISOString(), note: 'Predicciones walk-forward fuera de muestra: [probabilidad cruda, acierto]', samples: {} };

const report = { modelVersion: MODEL_VERSION, generatedAt: new Date().toISOString(), leagues: {} };
const paramsFile = path.join(DATA_DIR, 'model-params.json');
const params = fs.existsSync(paramsFile) ? JSON.parse(fs.readFileSync(paramsFile, 'utf8')) : { leagues: {} };
params.modelVersion = MODEL_VERSION;
params.generatedAt = report.generatedAt;

for (const league of leagues) {
  const t0 = Date.now();
  const matches = loadBundledHistory(league);
  const seasons = [...new Set(matches.map(m => m.season))].sort();
  const comp = ACTIVE_COMPETITIONS[league];
  const minSeasons = comp.historyWithOdds ? 4 : 3;
  if (seasons.length < minSeasons) {
    console.warn(`${league}: se necesitan al menos ${minSeasons} temporadas (hay ${seasons.length}).`);
    continue;
  }
  // La primera temporada solo sirve de historial inicial.
  // Con cuotas: entrenamiento = las dos siguientes, prueba = el resto.
  // Sin cuotas (Champions): entrenamiento = la segunda, prueba = el resto.
  const trainSeasons = comp.historyWithOdds ? seasons.slice(1, 3) : seasons.slice(1, 2);
  const testSeasons = comp.historyWithOdds ? seasons.slice(3) : seasons.slice(2);

  const res = runLeagueBacktest(matches, { trainSeasons, testSeasons, xiGrid: comp.historyWithOdds ? undefined : [0.0008, 0.0012, 0.0019] });
  const records = generateRecords(matches, { evalFrom: trainSeasons[0], xi: res.xi });
  res.engine = comp.historyWithOdds ? runEngineBacktest(records, { slug: comp.slug, trainSeasons, testSeasons }) : null;
  for (const [k, arr] of Object.entries(calibrationSamples(records, comp.slug))) {
    seed.samples[k] = arr.map(x => [Number(x.p.toFixed(4)), x.y ? 1 : 0]);
  }
  if (!comp.historyWithOdds) {
    // Sin cuotas históricas no se fijan pesos de mezcla: se usa 0.5 por defecto.
    res.weights = { w1x2: 0.5, wOU: 0.5 };
  }
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
  if (res.engine) {
    const e = res.engine;
    console.log(`  Motor (proxy Caliente): señales=${e.bets} acierto=${e.hitRatePct}% yield=${e.yieldPct}% CLV=${e.avgClvPct}% CLV+=${e.clvPositivePct}% por mercado=${JSON.stringify(e.byMarket)}`);
  }
}

// Ligas desactivadas: se eliminan de los parámetros activos (sus históricos siguen en data/history)
for (const k of Object.keys(params.leagues)) if (!SUPPORTED_MODEL_LEAGUES.includes(k)) delete params.leagues[k];
fs.writeFileSync(path.join(DATA_DIR, 'backtest-report.json'), JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(DATA_DIR, 'calibration-seed.json'), JSON.stringify(seed));
console.log(`Semilla de calibración: ${Object.entries(seed.samples).map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
fs.writeFileSync(paramsFile, JSON.stringify(params, null, 2));
console.log('Informe guardado en data/backtest-report.json y parámetros en data/model-params.json');
