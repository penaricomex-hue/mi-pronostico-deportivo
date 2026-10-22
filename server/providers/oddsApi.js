/**
 * Cliente de The Odds API con control de créditos persistente.
 *
 * Cada llamada a /odds cuesta (nº de mercados × nº de regiones) créditos.
 * La fuente de verdad es la cabecera x-requests-remaining, que se guarda en el
 * almacén persistente para que el control sobreviva a reinicios.
 */
import { fetchJson } from '../lib/http.js';
import { ACTIVE_COMPETITIONS, ACTIVE_CODES } from '../competitions.js';
import { isSupportedAhLine } from '../model/markets.js';

/** v10: solo LaLiga y Champions. Las demás ligas no consumen créditos. */
export const ODDS_SPORT_BY_COMPETITION = Object.fromEntries(ACTIVE_CODES.map(c => [c, ACTIVE_COMPETITIONS[c].oddsSport]));

const QUOTA_KEY = 'quota:odds-api';

function today() {
  // El presupuesto diario es del usuario (México), no del reloj UTC del servidor.
  const tz = process.env.QUOTA_TIMEZONE || 'America/Mexico_City';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function createOddsProvider({
  apiKey, baseUrl, regions = 'eu', cacheMinutes = 20, reserveCredits = 40, dailyCreditBudget = 30,
  markets = 'h2h,totals,spreads', extraMarkets = 'btts,double_chance', extrasCacheMinutes = 720, extrasHours = 30, extrasDailyBudget = 10,
  closingReserveCredits = 6, store, logger = console, fetchImpl = fetch
}) {
  const costPerCall = markets.split(',').length * regions.split(',').length;
  const extrasList = String(extraMarkets || '').split(',').map(x => x.trim()).filter(Boolean);
  const costPerExtrasCall = extrasList.length * regions.split(',').length;

  async function getQuota() {
    const q = (await store.get(QUOTA_KEY)) || {};
    if (q.day !== today()) { q.day = today(); q.dayUsed = 0; q.extrasDayUsed = 0; }
    return q;
  }

  async function saveQuota(q) {
    await store.set(QUOTA_KEY, q, 40 * 86400);
  }

  /**
   * `closing`: la captura de cierre (base del CLV) puede usar la parte del
   * presupuesto diario reservada para ella; el resto de llamadas no.
   */
  async function quotaStatus({ closing = false } = {}) {
    const q = await getQuota();
    const remaining = Number.isFinite(q.remaining) ? q.remaining : null;
    const dayLimit = closing ? dailyCreditBudget : Math.max(costPerCall, dailyCreditBudget - closingReserveCredits);
    let blockedReason = null;
    if (remaining != null && remaining - costPerCall < reserveCredits) blockedReason = `Quedan ${remaining} créditos (reserva ${reserveCredits}).`;
    else if ((q.dayUsed || 0) + costPerCall > dayLimit) blockedReason = closing
      ? `Presupuesto diario agotado (${q.dayUsed}/${dailyCreditBudget}).`
      : `Presupuesto diario para análisis agotado (${q.dayUsed}/${dayLimit}; ${closingReserveCredits} créditos reservados para cuotas de cierre).`;
    return {
      remaining,
      used: Number.isFinite(q.used) ? q.used : null,
      todayUsed: q.dayUsed || 0,
      extrasTodayUsed: q.extrasDayUsed || 0,
      extrasDailyBudget,
      markets,
      extraMarkets: extrasList,
      dailyBudget: dailyCreditBudget,
      closingReserve: closingReserveCredits,
      reserve: reserveCredits,
      costPerCall,
      updatedAt: q.updatedAt || null,
      blocked: Boolean(blockedReason),
      blockedReason
    };
  }

  async function recordCall(headers, { extras = false } = {}) {
    const q = await getQuota();
    const remaining = Number(headers.get('x-requests-remaining'));
    const used = Number(headers.get('x-requests-used'));
    const last = Number(headers.get('x-requests-last'));
    if (Number.isFinite(remaining)) q.remaining = remaining;
    if (Number.isFinite(used)) q.used = used;
    const spent = Number.isFinite(last) ? last : (extras ? costPerExtrasCall : costPerCall);
    q.dayUsed = (q.dayUsed || 0) + spent;
    if (extras) q.extrasDayUsed = (q.extrasDayUsed || 0) + spent;
    q.updatedAt = new Date().toISOString();
    await saveQuota(q);
  }

  /**
   * Eventos con cuotas normalizadas de una competición.
   * @returns {Promise<{events: Array, fromCache: boolean, blockedReason?: string}>}
   */
  async function getEvents(competition, { maxAgeMinutes = null, closing = false } = {}) {
    if (!apiKey) return { events: [], fromCache: false, blockedReason: 'ODDS_API_KEY no configurada' };
    const sport = ODDS_SPORT_BY_COMPETITION[competition];
    if (!sport) return { events: [], fromCache: false, blockedReason: 'Competición desactivada (v10 solo LaLiga y Champions)' };

    const key = `odds:${sport}:${regions}:${markets}`;
    const cached = await store.get(key);
    const fresh = cached && (!maxAgeMinutes || (cached.capturedAt && Date.now() - new Date(cached.capturedAt).getTime() <= maxAgeMinutes * 60000));
    if (fresh) return { events: cached.events, capturedAt: cached.capturedAt, fromCache: true };

    const quota = await quotaStatus({ closing });
    if (quota.blocked) {
      // Sin presupuesto: mejor una captura algo más antigua que ninguna
      if (cached) return { events: cached.events, capturedAt: cached.capturedAt, fromCache: true, stale: true };
      logger.warn(`[odds-api] Llamada bloqueada para proteger créditos: ${quota.blockedReason}`);
      return { events: [], fromCache: false, blockedReason: quota.blockedReason };
    }

    const url = `${baseUrl}/sports/${sport}/odds?regions=${encodeURIComponent(regions)}&markets=${markets}&oddsFormat=decimal&apiKey=${encodeURIComponent(apiKey)}`;
    try {
      const { data, headers } = await fetchJson(url, { fetchImpl });
      await recordCall(headers);
      const events = (Array.isArray(data) ? data : []).map(normalizeOddsEvent);
      const capturedAt = new Date().toISOString();
      await store.set(key, { events, capturedAt }, cacheMinutes * 60);
      return { events, capturedAt, fromCache: false };
    } catch (err) {
      if (err.headers) await recordCall(err.headers).catch(() => {});
      logger.warn(`[odds-api] ${competition}: ${err.status || ''} ${err.message}`);
      if (cached) return { events: cached.events, capturedAt: cached.capturedAt, fromCache: true, blockedReason: `Error de The Odds API: ${err.message}` };
      return { events: [], fromCache: false, blockedReason: `Error de The Odds API: ${err.message}` };
    }
  }

  /**
   * Mercados adicionales (ambos anotan, doble oportunidad) de UN evento.
   * The Odds API solo los sirve por evento; se piden únicamente para partidos
   * que empiezan en las próximas `extrasHours` horas y se cachean varias horas.
   */
  async function getEventExtras(competition, event) {
    if (!apiKey || !extrasList.length || !event?.id) return null;
    const sport = ODDS_SPORT_BY_COMPETITION[competition];
    if (!sport) return null;
    const startsIn = new Date(event.kickoff).getTime() - Date.now();
    if (!(startsIn > 0) || startsIn > extrasHours * 3600000) return null;

    const key = `odds-extras:${sport}:${event.id}:${regions}:${extrasList.join(',')}`;
    const cached = await store.get(key);
    if (cached) return cached;

    const q = await getQuota();
    const remaining = Number.isFinite(q.remaining) ? q.remaining : null;
    // Presupuesto propio para que los mercados por evento nunca dejen sin cuotas principales
    if ((remaining != null && remaining - costPerExtrasCall < reserveCredits)
      || (q.extrasDayUsed || 0) + costPerExtrasCall > extrasDailyBudget
      || (q.dayUsed || 0) + costPerExtrasCall > dailyCreditBudget - closingReserveCredits) return null;

    const url = `${baseUrl}/sports/${sport}/events/${encodeURIComponent(event.id)}/odds?regions=${encodeURIComponent(regions)}&markets=${extrasList.join(',')}&oddsFormat=decimal&apiKey=${encodeURIComponent(apiKey)}`;
    try {
      const { data, headers } = await fetchJson(url, { fetchImpl });
      await recordCall(headers, { extras: true });
      const normalized = normalizeOddsEvent(data || {});
      const value = { books: normalized.books, capturedAt: new Date().toISOString() };
      await store.set(key, value, extrasCacheMinutes * 60);
      return value;
    } catch (err) {
      if (err.headers) await recordCall(err.headers, { extras: true }).catch(() => {});
      logger.warn(`[odds-api] extras ${competition} ${event.id}: ${err.status || ''} ${err.message}`);
      return null;
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

  return { configured: Boolean(apiKey), getEvents, getEventExtras, getScores, quotaStatus, costPerCall, costPerExtrasCall, markets, extraMarkets: extrasList };
}

/** Une los precios de mercados adicionales a los libros de un evento. */
export function mergeBooks(books, extraBooks) {
  if (!extraBooks?.length) return books;
  const byName = new Map(books.map(b => [b.bookmaker, { ...b, prices: { ...b.prices }, ah: { ...(b.ah || {}) } }]));
  for (const x of extraBooks) {
    const cur = byName.get(x.bookmaker) || { bookmaker: x.bookmaker, key: x.key, prices: {}, ah: {} };
    cur.prices = { ...cur.prices, ...x.prices };
    byName.set(x.bookmaker, cur);
  }
  return [...byName.values()];
}

/**
 * Convierte un evento de The Odds API a:
 * { id, home, away, kickoff, books: [{ bookmaker, key, lastUpdate,
 *     prices: { home, draw, away, over25, under25, btts_yes, btts_no, dc_1x, dc_x2, dc_12 },
 *     ah: { [líneaLocal]: { home, away } } }] }
 * Los nombres de outcome h2h coinciden exactamente con home_team/away_team del evento.
 */
export function normalizeOddsEvent(e) {
  const books = [];
  const lc = v => String(v || '').toLowerCase();
  for (const b of e.bookmakers || []) {
    const prices = {};
    const ah = {};
    for (const m of b.markets || []) {
      if (m.key === 'spreads') {
        for (const o of m.outcomes || []) {
          const point = Number(o.point);
          if (!Number.isFinite(point)) continue;
          const isHome = o.name === e.home_team;
          const isAway = o.name === e.away_team;
          if (!isHome && !isAway) continue;
          const homeLine = isHome ? point : -point;
          if (!isSupportedAhLine(homeLine)) continue;
          const k = String(homeLine);
          ah[k] = ah[k] || {};
          ah[k][isHome ? 'home' : 'away'] = Number(o.price);
        }
        continue;
      }
      if (m.key === 'btts') {
        for (const o of m.outcomes || []) {
          if (/^(yes|si|sí)$/i.test(o.name)) prices.btts_yes = Number(o.price);
          if (/^no$/i.test(o.name)) prices.btts_no = Number(o.price);
        }
        continue;
      }
      if (m.key === 'double_chance') {
        const h = lc(e.home_team), a = lc(e.away_team);
        for (const o of m.outcomes || []) {
          const n = lc(o.name);
          const hasH = n.includes(h) || /^1x$|^home\s*\/\s*draw$/.test(n);
          const hasA = n.includes(a) || /^x2$|^draw\s*\/\s*away$/.test(n);
          const hasD = n.includes('draw');
          if (/^12$|^home\s*\/\s*away$/.test(n) || (n.includes(h) && n.includes(a))) prices.dc_12 = Number(o.price);
          else if (hasH && hasD) prices.dc_1x = Number(o.price);
          else if (hasA && hasD) prices.dc_x2 = Number(o.price);
        }
        continue;
      }
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
    for (const k of Object.keys(ah)) if (!(ah[k].home > 1 && ah[k].away > 1)) delete ah[k];
    if (Object.keys(prices).length || Object.keys(ah).length) {
      books.push({ bookmaker: b.title || b.key, key: b.key || null, lastUpdate: b.last_update || null, prices, ah });
    }
  }
  return { id: e.id, home: e.home_team, away: e.away_team, kickoff: e.commence_time, books };
}
