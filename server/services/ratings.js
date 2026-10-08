/**
 * Modelos Dixon-Coles por liga, ajustados con historial real y cacheados.
 * Los parámetros (ξ, pesos de mezcla, valueEnabled) salen del backtest.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fitDixonColes } from '../model/dixonColes.js';
import { SUPPORTED_MODEL_LEAGUES } from '../providers/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARAMS_FILE = path.resolve(__dirname, '..', '..', 'data', 'model-params.json');

export function loadModelParams() {
  try {
    return JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8'));
  } catch {
    return { leagues: {} };
  }
}

const DEFAULT_LEAGUE_PARAMS = { xi: 0.0019, w1x2: 0.5, wOU: 0.5, valueEnabled: false };
// Champions: pocos partidos por equipo y temporada → decaimiento más lento.
const COMPETITION_DEFAULTS = { CL: { xi: 0.0012 } };

export function createRatingsService({ history, logger = console, refreshHours = 6 }) {
  const params = loadModelParams();
  const cache = new Map(); // liga -> { fittedAt, model, promise }

  function leagueParams(league) {
    return { ...DEFAULT_LEAGUE_PARAMS, ...(COMPETITION_DEFAULTS[league] || {}), ...(params.leagues?.[league] || {}) };
  }

  async function getRatings(league) {
    if (!SUPPORTED_MODEL_LEAGUES.includes(league)) return null;
    const entry = cache.get(league);
    const fresh = entry?.model && Date.now() - entry.fittedAt < refreshHours * 3600000;
    if (fresh) return entry.model;
    if (entry?.promise) return entry.promise;

    const promise = (async () => {
      const matches = await history.getHistory(league);
      const p = leagueParams(league);
      const today = new Date(Date.now() + 86400000).toISOString().slice(0, 10); // incluye partidos de hoy
      const model = fitDixonColes(matches, { asOf: today, xi: p.xi, warmStart: entry?.model?.ok ? entry.model : null });
      if (!model.ok) logger.warn(`[ratings] ${league}: ${model.reason} (${model.nMatches} partidos)`);
      cache.set(league, { fittedAt: Date.now(), model: model.ok ? model : null });
      return model.ok ? model : null;
    })().catch(err => {
      logger.error(`[ratings] ${league}: ${err.message}`);
      cache.delete(league);
      return null;
    });

    cache.set(league, { ...(entry || {}), promise });
    return promise;
  }

  function summary() {
    return {
      modelVersion: params.modelVersion || null,
      generatedAt: params.generatedAt || null,
      leagues: Object.fromEntries(SUPPORTED_MODEL_LEAGUES.map(l => [l, leagueParams(l)]))
    };
  }

  return { getRatings, leagueParams, summary };
}
