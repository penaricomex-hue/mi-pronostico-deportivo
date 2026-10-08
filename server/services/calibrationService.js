/**
 * Calibración por competición y mercado.
 *
 * Muestras:
 *   - Semilla: predicciones fuera de muestra del backtest walk-forward
 *     (data/calibration-seed.json, generado por `npm run backtest`).
 *   - En vivo: tabla model_predictions con su resultado real, que se completa
 *     después de cada jornada.
 *
 * Después de cada jornada (job diario) se reajusta cada calibrador y se guarda
 * en calibration_models. Las muestras en vivo pesan el doble que la semilla
 * para que el modelo aprenda primero de sus errores recientes.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fitCalibrator, applyCalibrator, explainCalibration, calibrationKey, CALIBRATION_KEYS } from '../model/calibration.js';
import { CALIBRATION_GROUP } from '../model/markets.js';
import { ACTIVE_SLUG_SQL } from '../competitions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SEED_FILE = path.resolve(__dirname, '..', '..', 'data', 'calibration-seed.json');

export function loadSeed(file = SEED_FILE) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const [k, arr] of Object.entries(raw.samples || {})) out[k] = arr.map(([p, y]) => ({ p, y: Boolean(y) }));
    return { generatedAt: raw.generatedAt || null, samples: out };
  } catch {
    return { generatedAt: null, samples: {} };
  }
}

export function createCalibrationService({ pool, logger = console, seedFile = SEED_FILE }) {
  const seed = loadSeed(seedFile);
  const models = new Map();

  // Calibradores iniciales solo con la semilla (funciona sin base de datos)
  for (const key of CALIBRATION_KEYS) models.set(key, fitCalibrator(key, seed.samples[key] || [], { source: 'backtest' }));

  async function loadFromDb() {
    if (!pool) return;
    try {
      const { rows } = await pool.query('SELECT key, model FROM calibration_models');
      for (const r of rows) models.set(r.key, r.model);
    } catch (err) {
      logger.warn(`[calibration] No se pudieron leer calibradores: ${err.message}`);
    }
  }

  function get(competitionSlug, market) {
    return models.get(calibrationKey(competitionSlug, CALIBRATION_GROUP[market] || market)) || null;
  }

  function calibrate(competitionSlug, market, rawP) {
    return applyCalibrator(get(competitionSlug, market), rawP);
  }

  function explain(competitionSlug, market, rawP) {
    return explainCalibration(get(competitionSlug, market), rawP);
  }

  /** Reajusta todos los calibradores con semilla + resultados reales. */
  async function refit() {
    const live = {};
    if (pool) {
      const { rows } = await pool.query(
        `SELECT competition_slug, market, raw_probability, result FROM model_predictions
          WHERE ${ACTIVE_SLUG_SQL} AND result IN ('won', 'lost')`
      );
      for (const r of rows) {
        const key = calibrationKey(r.competition_slug, CALIBRATION_GROUP[r.market] || r.market);
        (live[key] ||= []).push({ p: Number(r.raw_probability), y: r.result === 'won' });
      }
    }
    const summary = [];
    for (const key of CALIBRATION_KEYS) {
      const liveSamples = live[key] || [];
      const samples = [...(seed.samples[key] || []), ...liveSamples, ...liveSamples];
      const cal = fitCalibrator(key, samples, { source: liveSamples.length ? 'backtest+live' : 'backtest' });
      cal.liveSamples = liveSamples.length;
      cal.seedSamples = (seed.samples[key] || []).length;
      models.set(key, cal);
      summary.push({ key, method: cal.method, n: cal.n, live: liveSamples.length });
      if (pool) {
        await pool.query(
          `INSERT INTO calibration_models (key, method, n, model, fitted_at) VALUES ($1,$2,$3,$4::jsonb, now())
           ON CONFLICT (key) DO UPDATE SET method = EXCLUDED.method, n = EXCLUDED.n, model = EXCLUDED.model, fitted_at = now()`,
          [key, cal.method, cal.n, JSON.stringify(cal)]
        ).catch(err => logger.warn(`[calibration] guardar ${key}: ${err.message}`));
      }
    }
    return { fittedAt: new Date().toISOString(), models: summary };
  }

  function summary() {
    return CALIBRATION_KEYS.map(key => {
      const m = models.get(key);
      return {
        key,
        method: m?.method || 'identity',
        n: m?.n || 0,
        liveSamples: m?.liveSamples ?? 0,
        fittedAt: m?.fittedAt || null,
        bins: (m?.bins || []).filter(b => b.lo >= 0.5 && b.lo < 0.8)
      };
    });
  }

  return { loadFromDb, calibrate, explain, refit, summary, get, seedGeneratedAt: seed.generatedAt };
}
