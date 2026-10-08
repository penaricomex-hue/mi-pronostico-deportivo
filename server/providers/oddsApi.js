/**
 * Cliente de The Odds API con control de créditos persistente.
 *
 * Cada llamada a /odds cuesta (nº de mercados × nº de regiones) créditos.
 * La fuente de verdad es la cabecera x-requests-remaining, que se guarda en el
 * almacén persistente para que el control sobreviva a reinicios.
 */
import { fetchJson } from '../lib/http.js';

export const ODDS_SPORT_BY_COMPETITION = {
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  BL1: 'soccer_germany_bundesliga',
  SA: 'soccer_italy_serie_a',
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
  EL: 'soccer_uefa_europa_league'
};

const QUOTA_KEY = 'quota:odds-api';

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function createOddsProvider({ apiKey, baseUrl, regions = 'eu', cacheMinutes = 20, reserveCredits = 40, dailyCreditBudget = 30, store, logger = console, fetchImpl = fetch }) {
  const markets = 'h2h,totals';
  const costPerCall = markets.split(',').length * regions.split(',').length;

  async function getQuota() {
    const q = (await store.get(QUOTA_KEY)) || {};
    if (q.day !== today()) { q.day = today(); q.dayUsed = 0; }
    return q;
  }

  async function saveQuota(q) {
    await store.set(QUOTA_KEY, q, 40 * 86400);
  }

  async function quotaStatus() {
    const q = await getQuota();
    const remaining = Number.isFinite(q.remaining) ? q.remaining : null;
    let blockedReason = null;
    if (remaining != null && remaining - costPerCall < reserveCredits) blockedReason = `Quedan ${remaining} créditos (reserva ${reserveCredits}).`;
    else if ((q.dayUsed || 0) + costPerCall > dailyCreditBudget) blockedReason = `Presupuesto diario agotado (${q.dayUsed}/${dailyCreditBudget}).`;
    return {
      remaining,
      used: Number.isFinite(q.used) ? q.used : null,
      todayUsed: q.dayUsed || 0,
      dailyBudget: dailyCreditBudget,
      reserve: reserveCredits,
      costPerCall,
      updatedAt: q.updatedAt || null,
      blocked: Boolean(blockedReason),
      blockedReason
    };
  }

  async function recordCall(headers) {
    const q = await getQuota();
    const remaining = Number(headers.get('x-requests-remaining'));
    const used = Number(headers.get('x-requests-used'));
    const last = Number(headers.get('x-requests-last'));
    if (Number.isFinite(remaining)) q.remaining = remaining;
    if (Number.isFinite(used)) q.used = used;
    q.dayUsed = (q.dayUsed || 0) + (Number.isFinite(last) ? last : costPerCall);
    q.updatedAt = new Date().toISOString();
    await saveQuota(q);
  }

  /**
   * Eventos con cuotas normalizadas de una competición.
   * @returns {Promise<{events: Array, fromCache: boolean, blockedReason?: string}>}
   */
  async function getEvents(competition) {
    if (!apiKey) return { events: [], fromCache: false, blockedReason: 'ODDS_API_KEY no configurada' };
    const sport = ODDS_SPORT_BY_COMPETITION[competition];
    if (!sport) return { events: [], fromCache: false, blockedReason: 'Competición sin cuotas' };

    const key = `odds:${sport}:${regions}`;
    const cached = await store.get(key);
    if (cached) return { events: cached, fromCache: true };

    const quota = await quotaStatus();
    if (quota.blocked) {
      logger.warn(`[odds-api] Llamada bloqueada para proteger créditos: ${quota.blockedReason}`);
      return { events: [], fromCache: false, blockedReason: quota.blockedReason };
    }

    const url = `${baseUrl}/sports/${sport}/odds?regions=${encodeURIComponent(regions)}&markets=${markets}&oddsFormat=decimal&apiKey=${encodeURIComponent(apiKey)}`;
    try {
      const { data, headers } = await fetchJson(url, { fetchImpl });
      await recordCall(headers);
      const events = (Array.isArray(data) ? data : []).map(normalizeOddsEvent);
      await store.set(key, events, cacheMinutes * 60);
      return { events, fromCache: false };
    } catch (err) {
      if (err.headers) await recordCall(err.headers).catch(() => {});
      logger.warn(`[odds-api] ${competition}: ${err.status || ''} ${err.message}`);
      return { events: [], fromCache: false, blockedReason: `Error de The Odds API: ${err.message}` };
    }
  }

  /** Resultados recientes (para liquidar partidos sin id de football-data). */
  async function getScores(competition, daysFrom = 3) {
    if (!apiKey) return [];
    const sport = ODDS_SPORT_BY_COMPETITION[competition];
    if (!sport) return [];
    const key = `odds-scores:${sport}:${daysFrom}`;
    const cached = await store.get(key);
    if (cached) return cached;
    const quota = await quotaStatus();
    if (quota.blocked) return [];
    try {
      const { data, headers } = await fetchJson(`${baseUrl}/sports/${sport}/scores?daysFrom=${daysFrom}&apiKey=${encodeURIComponent(apiKey)}`, { fetchImpl });
      await recordCall(headers);
      const list = (Array.isArray(data) ? data : []).filter(e => e.completed).map(e => {
        const score = Object.fromEntries((e.scores || []).map(s => [s.name, Number(s.score)]));
        return { id: e.id, home: e.home_team, away: e.away_team, kickoff: e.commence_time, homeGoals: score[e.home_team], awayGoals: score[e.away_team] };
      });
      await store.set(key, list, 3600);
      return list;
    } catch (err) {
      logger.warn(`[odds-api] scores ${competition}: ${err.message}`);
      return [];
    }
  }

  return { configured: Boolean(apiKey), getEvents, getScores, quotaStatus, costPerCall };
}

/**
 * Convierte un evento de The Odds API a:
 * { id, home, away, kickoff, books: [{ bookmaker, prices: { home, draw, away, over25, under25 } }] }
 * Los nombres de outcome h2h coinciden exactamente con home_team/away_team del evento.
 */
export function normalizeOddsEvent(e) {
  const books = [];
  for (const b of e.bookmakers || []) {
    const prices = {};
    for (const m of b.markets || []) {
      if (m.key === 'h2h') {
        for (const o of m.outcomes || []) {
          if (o.name === e.home_team) prices.home = Number(o.price);
          else if (o.name === e.away_team) prices.away = Number(o.price);
          else if (/^(draw|tie|empate)$/i.test(o.name)) prices.draw = Number(o.price);
        }
      } else if (m.key === 'totals') {
        for (const o of m.outcomes || []) {
          if (Number(o.point) !== 2.5) continue;
          if (/^over$/i.test(o.name)) prices.over25 = Number(o.price);
          if (/^under$/i.test(o.name)) prices.under25 = Number(o.price);
        }
      }
    }
    if (Object.keys(prices).length) books.push({ bookmaker: b.title || b.key, prices });
  }
  return { id: e.id, home: e.home_team, away: e.away_team, kickoff: e.commence_time, books };
}
