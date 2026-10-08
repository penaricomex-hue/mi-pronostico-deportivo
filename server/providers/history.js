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

/** v10: solo LaLiga (football-data.co.uk) y Champions (openfootball) tienen modelo. */
export const SUPPORTED_MODEL_LEAGUES = ['PD', 'CL'];

/** Ligas con historial de cuotas (football-data.co.uk) que siguen activas. */
export const ACTIVE_COUK_LEAGUES = ['PD'];

// ---------------------------------------------------------------------------
// Champions League: openfootball (texto Football.TXT, dominio público, sin cuotas)
// ---------------------------------------------------------------------------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** '2024-25' para el código '2425'. */
export function openfootballSeason(code) {
  return `20${code.slice(0, 2)}-${code.slice(2)}`;
}

export function openfootballUrl(season) {
  return `https://raw.githubusercontent.com/openfootball/champions-league/master/${openfootballSeason(season)}/cl.txt`;
}

/** Quita el sufijo de país: 'Real Madrid CF (ESP)' -> 'Real Madrid CF'. */
export function stripCountry(name) {
  return String(name || '').replace(/\s*\([A-Z]{3}\)\s*$/, '').trim();
}

/**
 * Parsea un cl.txt de openfootball. Usa el marcador a los 90 minutos: en
 * partidos con prórroga ("1-4 pen. 0-1 a.e.t. (0-1, 0-1)") toma el primer
 * marcador entre paréntesis.
 */
export function parseOpenfootballCl(text, season) {
  const startYear = 2000 + Number(season.slice(0, 2));
  const out = [];
  let date = null;
  let stage = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#') || line.startsWith('=')) continue;
    if (line.startsWith('▪')) { stage = line.replace('▪', '').trim(); continue; }
    const dm = line.match(/^\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*\s+([A-Z][a-z]{2})\w*\s+(\d{1,2})(?:\s+(\d{4}))?\s*$/);
    if (dm) {
      const month = MONTHS[dm[1].toLowerCase()];
      const year = dm[3] ? Number(dm[3]) : (month >= 7 ? startYear : startYear + 1);
      date = `${year}-${String(month).padStart(2, '0')}-${String(dm[2]).padStart(2, '0')}`;
      continue;
    }
    if (!date || !line.includes(' v ')) continue;
    let body = line.trim().replace(/^\d{1,2}[:.]\d{2}\s+/, '');
    const time = (line.trim().match(/^(\d{1,2}[:.]\d{2})\s+/) || [])[1] || null;
    const vIdx = body.indexOf(' v ');
    const home = stripCountry(body.slice(0, vIdx));
    const rest = body.slice(vIdx + 3);
    // El resultado empieza en el primer "d-d" precedido de 2+ espacios
    const sm = rest.match(/^(.*?\S)\s{2,}(\d+-\d+.*)$/) || rest.match(/^(.*?\S)\s+(\d+-\d+.*)$/);
    if (!sm) continue;
    const away = stripCountry(sm[1]);
    const score = sm[2];
    let hg, ag;
    if (/a\.e\.t\.|pen\./.test(score)) {
      const par = score.match(/\((\d+)-(\d+)/);
      if (!par) continue;
      hg = Number(par[1]); ag = Number(par[2]);
    } else {
      const ft = score.match(/^(\d+)-(\d+)/);
      hg = Number(ft[1]); ag = Number(ft[2]);
    }
    if (!home || !away || !Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    out.push({ season, date, time, stage, home, away, hg, ag, open: null, max: null, close: null });
  }
  return out;
}

export async function downloadClSeason(season, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const res = await fetchImpl(openfootballUrl(season), { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`openfootball HTTP ${res.status} (CL ${season})`);
  return parseOpenfootballCl(await res.text(), season);
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
  if (league === 'CL') return openfootballUrl(season);
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
  const norm = v => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // La primera aparición gana (historial incluido > temporada en vivo > fuentes extra)
  for (const m of list) {
    const k = `${m.date}|${norm(m.home)}|${norm(m.away)}`;
    if (!seen.has(k)) seen.set(k, m);
  }
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
  if (league === 'CL') return downloadClSeason(season, { fetchImpl, timeoutMs });
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
export function createHistoryProvider({ store, logger = console, fetchImpl = fetch, liveTtlSeconds = 12 * 3600 } = {}) {
  const bundled = new Map();

  function getBundled(league) {
    if (!bundled.has(league)) bundled.set(league, loadBundledHistory(league));
    return bundled.get(league);
  }

  async function getLiveSeason(league) {
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

  /**
   * @param {string} league PD | CL (las ligas desactivadas devuelven [])
   * @param {object} [opts]
   * @param {Array} [opts.extra] partidos terminados de otra fuente (p. ej. football-data.org)
   */
  async function getHistory(league, { includeLive = true, extra = [] } = {}) {
    if (!SUPPORTED_MODEL_LEAGUES.includes(league)) return [];
    const base = getBundled(league);
    if (!includeLive) return base;
    const live = await getLiveSeason(league);
    return dedupeMatches([...base, ...live, ...extra]);
  }

  return { getHistory, getBundled };
}
