/**
 * Fuente única de verdad de las competiciones activas.
 *
 * MK Bets se especializa en dos torneos: LaLiga EA Sports y la UEFA Champions
 * League. Las demás ligas quedan DESACTIVADAS (no se ingieren, no se modelan,
 * no se recomiendan ni entran en el panel), pero su histórico no se borra:
 * los archivos data/history/*.json y las filas antiguas de la base de datos se
 * conservan con competition_slug = 'excluded'.
 */

export const ACTIVE_COMPETITIONS = {
  PD: {
    code: 'PD',
    slug: 'la_liga',
    name: 'LaLiga EA Sports',
    shortName: 'LaLiga',
    oddsSport: 'soccer_spain_la_liga',
    historyWithOdds: true
  },
  CL: {
    code: 'CL',
    slug: 'champions_league',
    name: 'UEFA Champions League',
    shortName: 'Champions',
    oddsSport: 'soccer_uefa_champs_league',
    historyWithOdds: false
  }
};

/** Competiciones desactivadas: se conservan solo como referencia histórica. */
export const EXCLUDED_COMPETITIONS = {
  PL: 'Premier League',
  SA: 'Serie A',
  BL1: 'Bundesliga',
  FL1: 'Ligue 1',
  EL: 'Europa League'
};

export const ACTIVE_CODES = Object.keys(ACTIVE_COMPETITIONS);
export const ACTIVE_SLUGS = ACTIVE_CODES.map(c => ACTIVE_COMPETITIONS[c].slug);

/** Filtro SQL obligatorio en partidos, predicciones, backtesting y panel. */
export const ACTIVE_SLUG_SQL = `competition_slug IN ('la_liga', 'champions_league')`;

export function isActiveCompetition(code) {
  return ACTIVE_CODES.includes(String(code || '').toUpperCase());
}

export function slugForCode(code) {
  return ACTIVE_COMPETITIONS[String(code || '').toUpperCase()]?.slug || 'excluded';
}

export function codeForSlug(slug) {
  return ACTIVE_CODES.find(c => ACTIVE_COMPETITIONS[c].slug === slug) || null;
}

/**
 * Misma regla que el UPDATE de la migración:
 *   ILIKE '%la liga%' OR ILIKE '%laliga%' -> la_liga
 *   ILIKE '%champions%'                   -> champions_league
 *   resto                                 -> excluded
 */
export function competitionSlug(leagueName) {
  const n = String(leagueName || '').toLowerCase();
  if (n.includes('la liga') || n.includes('laliga') || n === 'pd' || n.includes('primera division')) return 'la_liga';
  if (n.includes('champions') || n === 'cl') return 'champions_league';
  return 'excluded';
}

export const COMPETITION_NAMES = Object.fromEntries(ACTIVE_CODES.map(c => [c, ACTIVE_COMPETITIONS[c].name]));
