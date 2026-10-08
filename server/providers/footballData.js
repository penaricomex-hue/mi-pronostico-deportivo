/**
 * Cliente de football-data.org (calendario, escudos y resultados).
 *
 * Plan gratuito: 10 llamadas/minuto, sin tope mensual, 12 competiciones
 * (no incluye Europa League). Se usa un limitador con cola y se respetan
 * las cabeceras X-Requests-Available-Minute y X-RequestCounter-Reset.
 */
import { fetchJson, HttpError } from '../lib/http.js';
import { createRateLimiter } from '../lib/rateLimiter.js';

import { ACTIVE_CODES } from '../competitions.js';

/** Solo LaLiga y Champions: el resto de competiciones ya no se ingiere. */
export const FOOTBALL_DATA_COMPETITIONS = ACTIVE_CODES;

export function createFootballDataProvider({ token, baseUrl, requestsPerMinute = 10, store, logger = console, fetchImpl = fetch }) {
  const limiter = createRateLimiter({ limit: requestsPerMinute, windowMs: 60000 });
  const stats = { calls: 0, errors: 0, rateLimited: 0, lastAvailable: null, lastError: null };

  async function request(path, { ttlSeconds = 1800, retries = 2 } = {}) {
    if (!token) throw new HttpError('FOOTBALL_DATA_TOKEN no configurado', { status: 503 });
    const key = `fd:${path}`;
    const cached = await store.get(key);
    if (cached) return cached;

    for (let attempt = 0; ; attempt++) {
      try {
        const { data, headers } = await limiter.schedule(() => {
          stats.calls++;
          return fetchJson(`${baseUrl}${path}`, { headers: { 'X-Auth-Token': token }, fetchImpl });
        });
        const available = Number(headers.get('x-requests-available-minute'));
        if (Number.isFinite(available)) { stats.lastAvailable = available; limiter.syncAvailable(available); }
        await store.set(key, data, ttlSeconds);
        return data;
      } catch (err) {
        if (err.status === 429 && attempt < retries) {
          stats.rateLimited++;
          const reset = Number(err.headers?.get?.('x-requestcounter-reset')) || Number(err.headers?.get?.('retry-after')) || 60;
          logger.warn(`[football-data] 429: esperando ${reset}s antes de reintentar ${path}`);
          limiter.pause(reset * 1000);
          continue;
        }
        stats.errors++;
        stats.lastError = `${err.status || ''} ${err.message}`.trim();
        throw err;
      }
    }
  }

  /** Partidos de un rango (máx. 10 días por petición en la API). */
  async function getMatches({ dateFrom, dateTo, competition = null, ttlSeconds = 3 * 3600 }) {
    const comps = competition ? [competition] : FOOTBALL_DATA_COMPETITIONS;
    const path = `/matches?dateFrom=${dateFrom}&dateTo=${dateTo}&competitions=${comps.join(',')}`;
    const data = await request(path, { ttlSeconds });
    return Array.isArray(data?.matches) ? data.matches : [];
  }

  /** Todos los partidos de una competición y temporada (año de inicio). */
  async function getCompetitionMatches(competition, season, { ttlSeconds = 12 * 3600 } = {}) {
    const data = await request(`/competitions/${encodeURIComponent(competition)}/matches?season=${Number(season)}`, { ttlSeconds });
    return Array.isArray(data?.matches) ? data.matches : [];
  }

  async function getMatch(id, { ttlSeconds = 1800 } = {}) {
    const data = await request(`/matches/${encodeURIComponent(id)}`, { ttlSeconds });
    return data?.match || data || null;
  }

  return {
    configured: Boolean(token),
    getMatches,
    getMatch,
    getCompetitionMatches,
    stats: () => ({ ...stats, limiter: limiter.stats() })
  };
}

/** Normaliza un partido de football-data.org al formato interno. */
export function normalizeFdMatch(m) {
  return {
    id: `fd-${m.id}`,
    providerId: m.id,
    source: 'football-data',
    competitionCode: m.competition?.code || null,
    competition: m.competition?.name || m.competition?.code || null,
    kickoff: m.utcDate || null,
    matchday: Number.isFinite(m.matchday) ? m.matchday : null,
    stage: m.stage || null,
    status: m.status || 'SCHEDULED',
    home: m.homeTeam?.name || m.homeTeam?.shortName || null,
    away: m.awayTeam?.name || m.awayTeam?.shortName || null,
    homeCrest: m.homeTeam?.crest || null,
    awayCrest: m.awayTeam?.crest || null,
    score: m.score?.fullTime && Number.isFinite(m.score.fullTime.home)
      ? { home: m.score.fullTime.home, away: m.score.fullTime.away }
      : null
  };
}
