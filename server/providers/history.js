/**
 * Historial real de partidos y cuotas (football-data.co.uk).
 *
 * - Las temporadas cerradas vienen incluidas en data/history/<LIGA>.json
 *   (generadas con `npm run fetch-history`).
 * - La temporada en curso se descarga en vivo del CSV público (sin API key)
 *   y se cachea 12 horas.
 *
 * Formato normalizado de cada partido:
 *   { date, time, home, away, hg, ag,
 *     open:  { h, d, a, o25, u25 }   // cuota media de mercado antes del partido
 *     max:   { h, d, a, o25, u25 }   // mejor cuota disponible antes del partido
 *     close: { h, d, a, o25, u25 } } // cuota media de cierre
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseCsv } from '../lib/csv.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const HISTORY_DIR = path.resolve(__dirname, '..', '..', 'data', 'history');

/** Código de liga interno (football-data.org) -> código de división en football-data.co.uk */
export const COUK_DIVISION = {
  PL: 'E0',
  PD: 'SP1',
  SA: 'I1',
  BL1: 'D1',
  FL1: 'F1'
};

/**
 * Ligas con modelo propio. Solo LaLiga (PD) y Champions (CL): el resto de
 * divisiones de COUK_DIVISION se conserva para `npm run fetch-history`, pero
 * queda desactivado en producción y backtest.
 */
export const SUPPORTED_MODEL_LEAGUES = ['PD', 'CL'];

/** Ligas cuyo historial sale de football-data.org (sin cuotas). */
export const FD_HISTORY_LEAGUES = ['CL'];

/**
 * Partido terminado de football-data.org -> formato de historial.
 * En eliminatorias se usa el marcador de los 90 minutos (regularTime) para
 * no contaminar el modelo con prórrogas.
 */
export function normalizeFdHistoryMatch(m) {
  if (!m || m.status !== 'FINISHED') return null;
  const sc = m.score || {};
  const reg = sc.duration && sc.duration !== 'REGULAR' && sc.regularTime && Number.isFinite(sc.regularTime.home) ? sc.regularTime : sc.fullTime;
  if (!reg || !Number.isFinite(reg.home) || !Number.isFinite(reg.away)) return null;
  const date = String(m.utcDate || '').slice(0, 10);
  if (!date) return null;
  return {
    season: seasonCode(m.utcDate),
    date,
    time: String(m.utcDate).slice(11, 16) || null,
    home: m.homeTeam?.name,
    away: m.awayTeam?.name,
    hg: reg.home,
    ag: reg.away,
    stage: m.stage || null,
    open: null,
    max: null,
    close: null
  };
}

/** '2627' para la temporada 2026-27. La temporada europea arranca en julio. */
export function seasonCode(date = new Date()) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const startYear = d.getUTCMonth() >= 6 ? y : y - 1;
  const a = String(startYear % 100).padStart(2, '0');
  const b = String((startYear + 1) % 100).padStart(2, '0');
  return `${a}${b}`;
}

export function csvUrl(league, season) {
  const div = COUK_DIVISION[league];
  if (!div) throw new Error(`Liga sin historial: ${league}`);
  return `https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 1 ? n : null;
}

function pick(row, ...keys) {
  for (const k of keys) {
    const v = num(row[k]);
    if (v) return v;
  }
  return null;
}

/** dd/mm/yy o dd/mm/yyyy -> yyyy-mm-dd */
export function parseCoukDate(value) {
  const m = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

export function normalizeCsvRows(rows, season) {
  const out = [];
  for (const r of rows) {
    const home = r.HomeTeam || r.Home;
    const away = r.AwayTeam || r.Away;
    const hg = Number(r.FTHG ?? r.HG);
    const ag = Number(r.FTAG ?? r.AG);
    const date = parseCoukDate(r.Date);
    if (!home || !away || !date || r.FTHG === '' || !Number.isFinite(hg) || !Number.isFinite(ag)) continue;

    out.push({
      season,
      date,
      time: r.Time || null,
      home,
      away,
      hg,
      ag,
      open: {
        h: pick(r, 'AvgH', 'BbAvH', 'B365H'),
        d: pick(r, 'AvgD', 'BbAvD', 'B365D'),
        a: pick(r, 'AvgA', 'BbAvA', 'B365A'),
        o25: pick(r, 'Avg>2.5', 'BbAv>2.5', 'B365>2.5'),
        u25: pick(r, 'Avg<2.5', 'BbAv<2.5', 'B365<2.5')
      },
      max: {
        h: pick(r, 'MaxH', 'BbMxH'),
        d: pick(r, 'MaxD', 'BbMxD'),
        a: pick(r, 'MaxA', 'BbMxA'),
        o25: pick(r, 'Max>2.5', 'BbMx>2.5'),
        u25: pick(r, 'Max<2.5', 'BbMx<2.5')
      },
      close: {
        h: pick(r, 'AvgCH', 'PSCH', 'B365CH'),
        d: pick(r, 'AvgCD', 'PSCD', 'B365CD'),
        a: pick(r, 'AvgCA', 'PSCA', 'B365CA'),
        o25: pick(r, 'AvgC>2.5', 'PC>2.5', 'B365C>2.5'),
        u25: pick(r, 'AvgC<2.5', 'PC<2.5', 'B365C<2.5')
      }
    });
  }
  return out;
}

export function sortMatches(list) {
  return [...list].sort((x, y) =>
    x.date === y.date ? String(x.time || '').localeCompare(String(y.time || '')) : x.date.localeCompare(y.date)
  );
}

export function dedupeMatches(list) {
  const seen = new Map();
  for (const m of list) seen.set(`${m.date}|${m.home}|${m.away}`, m);
  return sortMatches([...seen.values()]);
}

export function loadBundledHistory(league) {
  const file = path.join(HISTORY_DIR, `${league}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed?.matches) ? parsed.matches : [];
  } catch (err) {
    console.error(`[history] No se pudo leer ${file}: ${err.message}`);
    return [];
  }
}

export async function downloadSeason(league, season, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const res = await fetchImpl(csvUrl(league, season), { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`football-data.co.uk HTTP ${res.status} (${league} ${season})`);
  const text = await res.text();
  return normalizeCsvRows(parseCsv(text), season);
}

/**
 * Historial completo (incluido + temporada actual en vivo) con caché.
 * @param {object} deps { store, logger }
 */
export function createHistoryProvider({ store, footballData = null, logger = console, fetchImpl = fetch, liveTtlSeconds = 12 * 3600 } = {}) {
  const bundled = new Map();

  function getBundled(league) {
    if (!bundled.has(league)) bundled.set(league, loadBundledHistory(league));
    return bundled.get(league);
  }

  /** Temporada en curso de la Champions vía football-data.org. */
  async function getLiveFdSeason(league) {
    if (!footballData?.configured) return [];
    const now = new Date();
    const startYear = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    const key = `history:live-fd:${league}:${startYear}`;
    const cached = store ? await store.get(key) : null;
    if (cached) return cached;
    try {
      const raw = await footballData.getCompetitionMatches(league, startYear, { ttlSeconds: liveTtlSeconds });
      const rows = raw.map(normalizeFdHistoryMatch).filter(Boolean);
      if (store && rows.length) await store.set(key, rows, liveTtlSeconds);
      return rows;
    } catch (err) {
      logger.warn(`[history] Temporada en curso no disponible para ${league}: ${err.message}`);
      return [];
    }
  }

  async function getLiveSeason(league) {
    if (FD_HISTORY_LEAGUES.includes(league)) return getLiveFdSeason(league);
    const season = seasonCode();
    const key = `history:live:${league}:${season}`;
    const cached = store ? await store.get(key) : null;
    if (cached) return cached;
    try {
      const rows = await downloadSeason(league, season, { fetchImpl });
      if (store) await store.set(key, rows, liveTtlSeconds);
      return rows;
    } catch (err) {
      logger.warn(`[history] Temporada en curso no disponible para ${league}: ${err.message}`);
      return [];
    }
  }

  async function getHistory(league, { includeLive = true } = {}) {
    if (!SUPPORTED_MODEL_LEAGUES.includes(league)) return [];
    const base = getBundled(league);
    if (!includeLive) return base;
    const live = await getLiveSeason(league);
    return dedupeMatches([...base, ...live]);
  }

  return { getHistory, getBundled };
}
