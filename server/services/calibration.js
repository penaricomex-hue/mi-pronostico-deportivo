/**
 * Servicio de calibración por competición y mercado.
 *
 * Datos de entrenamiento = semilla del backtest walk-forward (fuera de muestra,
 * data/calibration-seed.json) + predicciones reales ya resueltas
 * (tabla model_predictions). Se reajusta al arrancar y después de cada
 * liquidación (es decir, tras cada jornada).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ACTIVE_SLUGS, ACTIVE_SLUGS_SQL } from '../competitions.js';
import {
  CALIBRATION_GROUPS, mapKey, emptyBins, mergeBins, addObservation, fitCalibration,
  applyCalibration, calibrateVector, rangeStats, calibrationMessage, totalSamples
} from '../model/calibration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SEED_FILE = path.resolve(__dirname, '..', '..', 'data', 'calibration-seed.json');

export function loadSeed(file = SEED_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { maps: {} };
  }
}

export function createCalibrationService({ pool = null, method = 'auto', logger = console, seed = null } = {}) {
  const seedData = seed || loadSeed();
  const state = new Map(); // key -> { map, bins, liveSamples }
  let lastFit = null;

  function seedBins(key) {
    const b = seedData.maps?.[key];
    return b ? mergeBins(b) : emptyBins();
  }

  async function liveBins() {
    const out = new Map();
    if (!pool) return out;
    try {
      const { rows } = await pool.query(
        `SELECT competition_slug, market, model_probability, outcome
           FROM model_predictions
          WHERE outcome IS NOT NULL AND ${ACTIVE_SLUGS_SQL}
            AND market IN ('1x2', 'over_under', 'btts')`
      );
      for (const r of rows) {
        const key = mapKey(r.competition_slug, r.market);
        if (!out.has(key)) out.set(key, emptyBins());
        addObservation(out.get(key), Number(r.model_probability), Number(r.outcome) === 1);
      }
      try {
        const manual = await pool.query(
          `SELECT competition_slug, market, model_probability, outcome
             FROM manual_outcomes
            WHERE market IN ('1x2', 'over_under', 'btts')`
        );
        for (const r of manual.rows) {
          const key = mapKey(r.competition_slug, r.market);
          if (!out.has(key)) out.set(key, emptyBins());
          addObservation(out.get(key), Number(r.model_probability), Number(r.outcome) === 1);
        }
      } catch (err) {
        logger.warn(`[calibration] Apuestas manuales no disponibles: ${err.message}`);
      }
    } catch (err) {
      logger.warn(`[calibration] No se pudieron leer predicciones resueltas: ${err.message}`);
    }
    return out;
  }

  async function refit() {
    const live = await liveBins();
    for (const slug of ACTIVE_SLUGS) {
      for (const group of CALIBRATION_GROUPS) {
        const key = mapKey(slug, group);
        const liveB = live.get(key) || emptyBins();
        const bins = mergeBins(seedBins(key), liveB);
        const map = fitCalibration(bins, { method });
        state.set(key, { map, bins, liveSamples: totalSamples(liveB) });
        if (pool) {
          pool.query(
            `INSERT INTO calibration_maps (key, method, samples, live_samples, payload, fitted_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, now())
             ON CONFLICT (key) DO UPDATE SET method = EXCLUDED.method, samples = EXCLUDED.samples,
               live_samples = EXCLUDED.live_samples, payload = EXCLUDED.payload, fitted_at = now()`,
            [key, map.method, map.samples, totalSamples(liveB), JSON.stringify(map)]
          ).catch(err => logger.warn(`[calibration] No se pudo guardar ${key}: ${err.message}`));
        }
      }
    }
    lastFit = new Date().toISOString();
    return summary();
  }

  function entry(slug, group) {
    const key = mapKey(slug, group);
    if (!state.has(key)) {
      // Sin refit aún: semilla sola
      const bins = seedBins(key);
      state.set(key, { map: fitCalibration(bins, { method }), bins, liveSamples: 0 });
    }
    return state.get(key);
  }

  /** Calibra un vector de un mercado (1x2 | over_under | btts) y renormaliza. */
  function calibrate(slug, group, probs) {
    return calibrateVector(entry(slug, group).map, probs);
  }

  function calibrateOne(slug, group, p) {
    return applyCalibration(entry(slug, group).map, p);
  }

  function explain(slug, group, raw, calibrated) {
    const e = entry(slug, group);
    const stats = rangeStats(e.bins, raw);
    return { message: calibrationMessage(raw, calibrated, stats), range: stats, method: e.map.method, samples: e.map.samples };
  }

  /** Tabla de calibración por rangos (para el panel). */
  function table(slug, group, bands = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8]]) {
    const e = entry(slug, group);
    return bands.map(([lo, hi]) => {
      let n = 0, wins = 0, pSum = 0;
      for (let i = Math.round(lo * 100); i < Math.round(hi * 100); i++) {
        n += e.bins.n[i]; wins += e.bins.wins[i]; pSum += e.bins.n[i] * ((i + 0.5) / 100);
      }
      return { range: `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`, samples: n, predicted: n ? pSum / n : null, actual: n ? wins / n : null };
    });
  }

  function summary() {
    const maps = {};
    for (const slug of ACTIVE_SLUGS) for (const group of CALIBRATION_GROUPS) {
      const key = mapKey(slug, group);
      const e = entry(slug, group);
      maps[key] = { method: e.map.method, samples: e.map.samples, liveSamples: e.liveSamples, fittedAt: e.map.fittedAt };
    }
    return { lastFit, seedGeneratedAt: seedData.generatedAt || null, maps };
  }

  return { refit, calibrate, calibrateOne, explain, table, summary };
}
