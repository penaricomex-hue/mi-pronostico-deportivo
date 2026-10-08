/**
 * Fuente única de verdad de las competiciones de MK Bets.
 *
 * Desde v10 la app se especializa en dos torneos:
 *   - LaLiga EA Sports (España, primera división)  -> competition_slug 'la_liga'
 *   - UEFA Champions League                         -> competition_slug 'champions_league'
 *
 * El resto de ligas queda DESACTIVADO, no borrado: su historial sigue en
 * data/history/ y en la base de datos (marcado como competition_slug = 'excluded'),
 * pero no entra en ingesta, modelos, backtest, recomendaciones ni panel.
 */

export const ACTIVE_COMPETITIONS = {
  PD: {
    code: 'PD',
    slug: 'la_liga',
    name: 'LaLiga EA Sports',
    shortName: 'LaLiga',
    oddsSport: 'soccer_spain_la_liga',
    footballData: 'PD',
    historySource: 'football-data.co.uk',
    // La jornada de LaLiga va de viernes a lunes.
    hasHistoricalOdds: true
  },
  CL: {
    code: 'CL',
    slug: 'champions_league',
    name: 'UEFA Champions League',
    shortName: 'Champions',
    oddsSport: 'soccer_uefa_champs_league',
    footballData: 'CL',
    historySource: 'openfootball',
    hasHistoricalOdds: false
  }
};

/** Competiciones desactivadas (se conserva su histórico, no se usan). */
export const DISABLED_COMPETITIONS = {
  PL: 'Premier League',
  SA: 'Serie A',
  BL1: 'Bundesliga',
  FL1: 'Ligue 1',
  EL: 'Europa League'
};

export const ACTIVE_CODES = Object.keys(ACTIVE_COMPETITIONS);
export const ACTIVE_SLUGS = ACTIVE_CODES.map(c => ACTIVE_COMPETITIONS[c].slug);

/** Fragmento SQL reutilizable. Todas las consultas de partidos, señales y panel lo usan. */
export const ACTIVE_SLUGS_SQL = `competition_slug IN ('la_liga', 'champions_league')`;

export const COMPETITION_NAMES = Object.fromEntries(ACTIVE_CODES.map(c => [c, ACTIVE_COMPETITIONS[c].name]));

export function isActiveCompetition(code) {
  return Boolean(code && ACTIVE_COMPETITIONS[String(code).toUpperCase()]);
}

export function slugForCode(code) {
  return ACTIVE_COMPETITIONS[String(code || '').toUpperCase()]?.slug || 'excluded';
}

export function codeForSlug(slug) {
  return ACTIVE_CODES.find(c => ACTIVE_COMPETITIONS[c].slug === slug) || null;
}

/**
 * Misma lógica que el UPDATE de la migración:
 *   ILIKE '%la liga%' OR ILIKE '%laliga%' -> la_liga
 *   ILIKE '%champions%'                   -> champions_league
 *   resto                                 -> excluded
 * Acepta también los códigos internos (PD, CL).
 */
export function slugFromLeagueName(name) {
  const s = String(name || '').toLowerCase();
  if (s === 'pd') return 'la_liga';
  if (s === 'cl') return 'champions_league';
  if (s.includes('la liga') || s.includes('laliga') || s.includes('primera division') || s.includes('primera división')) return 'la_liga';
  if (s.includes('champions')) return 'champions_league';
  return 'excluded';
}

/**
 * Clave de jornada. Una "jornada" es la ventana martes→lunes que contiene el
 * partido: cubre LaLiga (vie–lun) y la Champions (mar–mié/jue) sin solaparse.
 */
export function jornadaKey(slug, kickoff) {
  const d = new Date(kickoff);
  if (Number.isNaN(d.getTime())) return `${slug}:sin-fecha`;
  // Hora de Madrid aproximada (UTC+1/+2) para no partir partidos nocturnos.
  const local = new Date(d.getTime() + 2 * 3600000);
  const dow = local.getUTCDay(); // 0 dom … 2 mar
  const back = (dow - 2 + 7) % 7;
  const tuesday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - back));
  return `${slug}:${tuesday.toISOString().slice(0, 10)}`;
}
