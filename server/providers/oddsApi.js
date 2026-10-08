/**
 * Cliente de The Odds API con control de créditos persistente.
 *
 * Cada llamada a /odds cuesta (nº de mercados × nº de regiones) créditos.
 * La fuente de verdad es la cabecera x-requests-remaining, que se guarda en el
 * almacén persistente para que el control sobreviva a reinicios.
 */
import { fetchJson } from '../lib/http.js';
import { ACTIVE_COMPETITIONS } from '../competitions.js';
import { ahSelection } from '../model/markets.js';

/** Solo LaLiga y Champions. Las demás ligas ya no consumen créditos. */
export const ODDS_SPORT_BY_COMPETITION = Object.fromEntries(
  Object.values(ACTIVE_COMPETITIONS).map(c => [c.code, c.oddsSport])
);

/** Clave de casa normalizada (Caliente MX siempre como caliente_mx). */
export function bookmakerKey(b) {
  const k = String(b?.key || b?.title || b || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return /caliente/.test(k) ? 'caliente_mx' : k;
}

const QUOTA_KEY = 'quota:odds-api';

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function createOddsProvider({ apiKey, baseUrl, regions = 'eu', markets = 'h2h,totals,spreads', eventMarkets = '', cacheMinutes = 20, reserveCredits = 40, dailyCreditBudget = 30, store, logger = console, fetchImpl = fetch }) {

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

  /**
   * Mercados adicionales de un evento (btts, double_chance). Se piden uno a uno
   * en /events/{id}/odds, así que solo se usan si ODDS_EVENT_MARKETS está
   * configurado y hay créditos.
   */
  async function getEventMarkets(competition, eventId) {
    if (!apiKey || !eventMarkets || !eventId) return null;
    const sport = ODDS_SPORT_BY_COMPETITION[competition];
    if (!sport) return null;
    const key = `odds-event:${sport}:${eventId}:${eventMarkets}:${regions}`;
    const cached = await store.get(key);
    if (cached) return cached;
    const cost = eventMarkets.split(',').length * regions.split(',').length;
    const quota = await quotaStatus();
    if (quota.remaining != null && quota.remaining - cost < reserveCredits) return null;
    if (quota.todayUsed + cost > dailyCreditBudget) return null;
    try {
      const url = `${baseUrl}/sports/${sport}/events/${encodeURIComponent(eventId)}/odds?regions=${encodeURIComponent(regions)}&markets=${encodeURIComponent(eventMarkets)}&oddsFormat=decimal&apiKey=${encodeURIComponent(apiKey)}`;
      const { data, headers } = await fetchJson(url, { fetchImpl });
      await recordCall(headers);
      const ev = normalizeOddsEvent(data || {});
      await store.set(key, ev, cacheMinutes * 60);
      return ev;
    } catch (err) {
      if (err.headers) await recordCall(err.headers).catch(() => {});
      logger.warn(`[odds-api] evento ${eventId}: ${err.message}`);
      return null;
    }
  }

  return { configured: Boolean(apiKey), getEvents, getEventMarkets, getScores, quotaStatus, costPerCall, eventMarketsEnabled: Boolean(eventMarkets) };
}

/**
 * Convierte un evento de The Odds API a:
 * { id, home, away, kickoff, books: [{ bookmaker, title, prices: { home, draw, away, over25, under25,
 *   btts_yes, btts_no, dc_1x, dc_12, dc_x2, 'ah_home@-0.5', 'ah_away@+0.5', ... } }] }
 * Los nombres de outcome h2h/spreads coinciden exactamente con home_team/away_team del evento.
 */
export function normalizeOddsEvent(e) {
  const books = [];
  const H = e.home_team, A = e.away_team;
  for (const b of e.bookmakers || []) {
    const prices = {};
    for (const m of b.markets || []) {
      const outs = m.outcomes || [];
      if (m.key === 'h2h' || m.key === 'h2h_3_way') {
        for (const o of outs) {
          if (o.name === H) prices.home = Number(o.price);
          else if (o.name === A) prices.away = Number(o.price);
          else if (/^(draw|tie|empate)$/i.test(o.name)) prices.draw = Number(o.price);
        }
      } else if (m.key === 'totals') {
        for (const o of outs) {
          if (Number(o.point) !== 2.5) continue;
          if (/^over$/i.test(o.name)) prices.over25 = Number(o.price);
          if (/^under$/i.test(o.name)) prices.under25 = Number(o.price);
        }
      } else if (m.key === 'spreads') {
        for (const o of outs) {
          const line = Number(o.point);
          if (!Number.isFinite(line)) continue;
          if (o.name === H) prices[ahSelection('home', line)] = Number(o.price);
          else if (o.name === A) prices[ahSelection('away', line)] = Number(o.price);
        }
      } else if (m.key === 'btts') {
        for (const o of outs) {
          if (/^yes$/i.test(o.name)) prices.btts_yes = Number(o.price);
          if (/^no$/i.test(o.name)) prices.btts_no = Number(o.price);
        }
      } else if (m.key === 'double_chance') {
        for (const o of outs) {
          const n = String(o.name);
          const hasH = n.includes(H), hasA = n.includes(A), hasD = /draw/i.test(n);
          if (hasH && hasD) prices.dc_1x = Number(o.price);
          else if (hasH && hasA) prices.dc_12 = Number(o.price);
          else if (hasA && hasD) prices.dc_x2 = Number(o.price);
        }
      }
    }
    if (Object.keys(prices).length) books.push({ bookmaker: bookmakerKey(b), title: b.title || b.key, lastUpdate: b.last_update || null, prices });
  }
  return { id: e.id, home: H, away: A, kickoff: e.commence_time, books };
}
