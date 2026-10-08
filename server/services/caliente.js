/**
 * Caliente MX: casa de ejecución principal.
 *
 * Ningún agregador público (The Odds API, OpticOdds) publica las cuotas de
 * Caliente MX, así que hay dos vías de entrada, ambas con hora exacta de captura:
 *
 *   1. Manual: POST /api/caliente/odds desde la app (copias la cuota que ves en
 *      Caliente en el momento de la señal).
 *   2. Feed: CALIENTE_FEED_URL devuelve un JSON con este formato (p. ej. tu
 *      propio capturador o un proveedor de pago que sí cubra Caliente):
 *        [{ "home": "Real Madrid", "away": "Getafe", "kickoff": "2026-10-18T19:00:00Z",
 *           "competition": "PD", "selection": "home", "odds": 1.45,
 *           "capturedAt": "2026-10-17T12:00:00Z" }, ...]
 */
import { marketOf, swapSelection } from '../model/markets.js';
import { fetchJson } from '../lib/http.js';
import { isActiveCompetition } from '../competitions.js';
import { CALIENTE } from './oddsStore.js';

export function validateCalienteEntry(e) {
  const odds = Number(e?.odds);
  const selection = String(e?.selection || '').trim();
  if (!marketOf(selection)) return 'Selección no válida para los mercados habilitados.';
  if (!(odds > 1 && odds < 1000)) return 'La cuota debe ser mayor que 1.';
  return null;
}

export function createCalienteService({ pool, oddsStore, matchesRepo, analysis, teams, feedUrl = '', feedToken = '', logger = console, fetchImpl = fetch }) {
  function requireDb() {
    if (!pool) {
      const err = new Error('Para guardar cuotas de Caliente MX se necesita PostgreSQL (DATABASE_URL).');
      err.status = 503;
      throw err;
    }
  }

  /**
   * Guarda cuotas manuales de Caliente para un partido.
   * @param {{fixtureId:string, entries: Array<{selection:string, odds:number}>, capturedAt?:string}} body
   */
  async function saveManual(body) {
    requireDb();
    const fixtureId = String(body?.fixtureId || '');
    let match = await matchesRepo.getByExternalId(fixtureId);
    if (!match && body?.date) {
      const fixture = await analysis.findFixture({ id: fixtureId, date: body.date, competition: body.competition, tzOffset: Number(body.tz) || 0 });
      if (fixture) match = await matchesRepo.upsertFixture(fixture);
    }
    if (!match) { const err = new Error('Partido no encontrado (solo LaLiga y Champions).'); err.status = 404; throw err; }

    const entries = Array.isArray(body?.entries) ? body.entries : [body];
    const prices = {};
    for (const e of entries) {
      const problem = validateCalienteEntry(e);
      if (problem) { const err = new Error(`${e?.selection || '?'}: ${problem}`); err.status = 400; throw err; }
      prices[e.selection] = Number(e.odds);
    }
    const capturedAt = body?.capturedAt ? new Date(body.capturedAt) : new Date();
    if (match.kickoff_utc && capturedAt > new Date(match.kickoff_utc)) {
      const err = new Error('No se aceptan cuotas capturadas después del inicio del partido.');
      err.status = 400;
      throw err;
    }
    const res = await oddsStore.recordBooks(match.id, [{ bookmaker: CALIENTE, prices }], { source: 'manual', capturedAt });
    return { matchId: match.id, saved: res.inserted, odds: await oddsStore.calienteOdds(match.id) };
  }

  /** Sincroniza el feed opcional de Caliente. */
  async function syncFeed() {
    if (!feedUrl || !pool) return { synced: 0, skipped: 'Sin CALIENTE_FEED_URL' };
    const headers = feedToken ? { Authorization: `Bearer ${feedToken}` } : {};
    const { data } = await fetchJson(feedUrl, { headers, fetchImpl });
    const list = Array.isArray(data) ? data : Array.isArray(data?.odds) ? data.odds : [];
    const groups = new Map();
    for (const e of list) {
      const comp = String(e.competition || '').toUpperCase();
      if (!isActiveCompetition(comp) || validateCalienteEntry(e)) continue;
      const k = `${comp}|${e.home}|${e.away}|${e.kickoff}`;
      if (!groups.has(k)) groups.set(k, { comp, home: e.home, away: e.away, kickoff: e.kickoff, capturedAt: e.capturedAt, prices: {} });
      groups.get(k).prices[e.selection] = Number(e.odds);
    }
    let synced = 0;
    for (const g of groups.values()) {
      const date = String(g.kickoff).slice(0, 10);
      const { fixtures } = await analysis.getFixtures({ date, competition: g.comp, tzOffset: 0 });
      const hit = teams.matchEvent({ home: g.home, away: g.away, kickoff: g.kickoff }, fixtures, g.comp);
      if (!hit) continue;
      const match = await matchesRepo.upsertFixture(hit.event);
      if (!match) continue;
      let prices = g.prices;
      if (hit.reversed) {
        prices = Object.fromEntries(Object.entries(g.prices).map(([s, o]) => [swapSelection(s), o]));
      }
      const r = await oddsStore.recordBooks(match.id, [{ bookmaker: CALIENTE, prices }], { source: 'feed', capturedAt: g.capturedAt ? new Date(g.capturedAt) : new Date() });
      synced += r.inserted;
    }
    logger.log(`[caliente] feed: ${synced} cuotas nuevas`);
    return { synced };
  }

  return { saveManual, syncFeed, feedConfigured: Boolean(feedUrl) };
}
