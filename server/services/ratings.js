/**
 * Modelos Dixon-Coles por liga, ajustados con historial real y cacheados.
 * Los parámetros (ξ, pesos de mezcla, valueEnabled) salen del backtest.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fitDixonColes } from '../model/dixonColes.js';
import { SUPPORTED_MODEL_LEAGUES, seasonCode } from '../providers/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARAMS_FILE = path.resolve(__dirname, '..', '..', 'data', 'model-params.json');

export function loadModelParams() {
  try {
    return JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8'));
  } catch {
    return { leagues: {} };
  }
}

const DEFAULT_LEAGUE_PARAMS = { xi: 0.0019, valueEnabled: false };

/**
 * Partidos de Champions de la temporada en curso desde football-data.org,
 * normalizados al formato del historial y con nombres canónicos.
 */
export async function currentClFromFootballData({ footballData, teams, logger = console }) {
  if (!footballData?.configured || !footballData.getCompetitionMatches) return [];
  try {
    const startYear = 2000 + Number(seasonCode().slice(0, 2));
    const list = await footballData.getCompetitionMatches('CL', { season: startYear, status: 'FINISHED' });
    const canon = n => teams?.resolve(n, 'CL')?.canonical || n;
    return list
      .map(m => {
        const reg = m.score?.regularTime || m.score?.fullTime; // 90 min si hubo prórroga
        return {
          season: seasonCode(),
          date: String(m.utcDate || '').slice(0, 10),
          home: canon(m.homeTeam?.name),
          away: canon(m.awayTeam?.name),
          hg: Number(reg?.home),
          ag: Number(reg?.away),
          open: null, max: null, close: null
        };
      })
      .filter(m => m.date && m.home && m.away && Number.isFinite(m.hg) && Number.isFinite(m.ag));
  } catch (err) {
    logger.warn(`[ratings] Champions en curso (football-data.org) no disponible: ${err.message}`);
    return [];
  }
}

export function createRatingsService({ history, footballData = null, teams = null, logger = console, refreshHours = 6 }) {
  const params = loadModelParams();
  const cache = new Map(); // liga -> { fittedAt, model, promise }

  function leagueParams(league) {
    return { ...DEFAULT_LEAGUE_PARAMS, ...(params.leagues?.[league] || {}) };
  }

  async function getRatings(league) {
    if (!SUPPORTED_MODEL_LEAGUES.includes(league)) return null;
    const entry = cache.get(league);
    const fresh = entry?.model && Date.now() - entry.fittedAt < refreshHours * 3600000;
    if (fresh) return entry.model;
    if (entry?.promise) return entry.promise;

    const promise = (async () => {
      const extra = league === 'CL' ? await currentClFromFootballData({ footballData, teams, logger }) : [];
      const matches = await history.getHistory(league, { extra });
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
