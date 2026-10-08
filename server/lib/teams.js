/**
 * Resolución de nombres de equipos con tabla de alias explícita.
 *
 * Sustituye a namesMatch(), que daba falsos positivos como
 * "AC Milan" = "Inter Milan" o "Paris Saint-Germain" = "Paris FC".
 *
 * Orden de resolución:
 *   1. Alias exacto (normalizado) dentro de la liga.
 *   2. Alias exacto en cualquier liga, solo si es único.
 *   3. Coincidencia aproximada dentro de la liga, solo si hay un ganador claro.
 * Los partidos se emparejan por local + visitante + hora, nunca por equipo suelto.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEAMS_FILE = path.resolve(__dirname, '..', '..', 'data', 'teams.json');

const STOPWORDS = new Set([
  'fc', 'cf', 'afc', 'sc', 'ac', 'as', 'ss', 'ssc', 'us', 'uc', 'cd', 'ud', 'rc', 'rcd', 'ca', 'sv', 'vfl', 'vfb', 'tsg',
  'club', 'calcio', 'de', 'del', 'la', 'the', 'and', 'sad', 'football', 'futbol', 'balompie', 'cfc', 'bc', 'osc', 'hsc'
]);

export function normalizeTeamName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function teamTokens(value) {
  return normalizeTeamName(value)
    .split(' ')
    .filter(t => t && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function tokenSimilar(a, b) {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

/** Similitud tipo Jaccard entre conjuntos de tokens (0..1). */
export function tokenSimilarity(a, b) {
  const A = teamTokens(a);
  const B = teamTokens(b);
  if (!A.length || !B.length) return 0;
  let inter = 0;
  const used = new Set();
  for (const x of A) {
    const j = B.findIndex((y, idx) => !used.has(idx) && tokenSimilar(x, y));
    if (j >= 0) { inter++; used.add(j); }
  }
  return inter / (A.length + B.length - inter);
}

export function createTeamRegistry(raw = null) {
  const data = raw || JSON.parse(fs.readFileSync(TEAMS_FILE, 'utf8'));
  const byLeague = new Map();      // liga -> Map(alias normalizado -> canónico)
  const global = new Map();        // alias normalizado -> Set("LIGA|canónico")
  const canonicalByLeague = new Map();

  for (const [league, teams] of Object.entries(data)) {
    if (league.startsWith('_')) continue;
    const idx = new Map();
    const list = [];
    for (const [canonical, aliases] of Object.entries(teams)) {
      list.push({ canonical, names: [canonical, ...aliases] });
      for (const n of [canonical, ...aliases]) {
        const key = normalizeTeamName(n);
        idx.set(key, canonical);
        if (!global.has(key)) global.set(key, new Set());
        global.get(key).add(`${league}|${canonical}`);
      }
    }
    byLeague.set(league, idx);
    canonicalByLeague.set(league, list);
  }

  const unresolved = new Set();

  /**
   * @returns {{canonical:string, league:string, method:'alias'|'global'|'fuzzy'}|null}
   */
  function resolve(name, league = null) {
    const key = normalizeTeamName(name);
    if (!key) return null;

    if (league && byLeague.has(league)) {
      const hit = byLeague.get(league).get(key);
      if (hit) return { canonical: hit, league, method: 'alias' };
    }

    const g = global.get(key);
    if (g && g.size === 1) {
      const [lg, canonical] = [...g][0].split('|');
      return { canonical, league: lg, method: 'global' };
    }

    const leagues = league && canonicalByLeague.has(league) ? [league] : [];
    let best = null, second = 0;
    for (const lg of leagues) {
      for (const team of canonicalByLeague.get(lg)) {
        const score = Math.max(...team.names.map(n => tokenSimilarity(name, n)));
        if (!best || score > best.score) {
          if (best) second = Math.max(second, best.score);
          best = { canonical: team.canonical, league: lg, score };
        } else {
          second = Math.max(second, score);
        }
      }
    }
    if (best && best.score >= 0.5 && best.score - second >= 0.2) {
      return { canonical: best.canonical, league: best.league, method: 'fuzzy' };
    }

    const tag = `${league || '?'}|${name}`;
    if (!unresolved.has(tag)) {
      unresolved.add(tag);
      console.warn(`[teams] Nombre sin resolver: "${name}" (${league || 'sin liga'}). Añádelo a data/teams.json.`);
    }
    return null;
  }

  /** ¿Son el mismo equipo? Estricto: alias si es posible; si no, similitud alta. */
  function sameTeam(a, b, league = null) {
    if (!a || !b) return false;
    const ra = resolve(a, league);
    const rb = resolve(b, league);
    if (ra && rb) return ra.canonical === rb.canonical && ra.league === rb.league;
    if (ra || rb) {
      // Uno resuelto y el otro no: comparar el no resuelto contra los alias del resuelto.
      const known = ra || rb;
      const other = ra ? b : a;
      const team = canonicalByLeague.get(known.league)?.find(t => t.canonical === known.canonical);
      return Boolean(team && team.names.some(n => normalizeTeamName(n) === normalizeTeamName(other) || tokenSimilarity(n, other) >= 0.75));
    }
    // Ninguno está en el registro (p. ej. rivales de Champions de otras ligas)
    return normalizeTeamName(a) === normalizeTeamName(b) || tokenSimilarity(a, b) >= 0.67;
  }

  /**
   * Busca el evento que corresponde al partido (local + visitante + hora).
   * @param {{home:string, away:string, kickoff?:string}} fixture
   * @param {Array<{home:string, away:string, kickoff?:string}>} events
   */
  function matchEvent(fixture, events, league = null, { maxHoursDiff = 3 } = {}) {
    const t0 = fixture.kickoff ? new Date(fixture.kickoff).getTime() : null;
    const timeOk = (e) => {
      if (!t0 || !e.kickoff) return true;
      return Math.abs(new Date(e.kickoff).getTime() - t0) <= maxHoursDiff * 3600000;
    };
    const direct = events.filter(e => timeOk(e) && sameTeam(fixture.home, e.home, league) && sameTeam(fixture.away, e.away, league));
    if (direct.length === 1) return { event: direct[0], reversed: false };
    if (direct.length > 1) return null; // ambiguo: mejor no emparejar
    const rev = events.filter(e => timeOk(e) && sameTeam(fixture.home, e.away, league) && sameTeam(fixture.away, e.home, league));
    if (rev.length === 1) return { event: rev[0], reversed: true };
    return null;
  }

  return { resolve, sameTeam, matchEvent, unresolved: () => [...unresolved] };
}
