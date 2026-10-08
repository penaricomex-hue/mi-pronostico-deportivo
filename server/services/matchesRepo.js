/**
 * Tabla `matches`: cada partido de LaLiga o Champions que la app analiza se
 * guarda con su competition_slug. Todas las consultas filtran
 *   WHERE competition_slug IN ('la_liga', 'champions_league')
 */
import { competitionSlug, ACTIVE_SLUG_SQL } from '../competitions.js';

export function createMatchesRepo({ pool, logger = console }) {
  async function upsertFixture(f) {
    if (!pool || !f?.id || !f.home || !f.away || !f.kickoff) return null;
    const leagueName = f.competition || f.competitionCode || '';
    const slug = competitionSlug(f.competitionCode === 'PD' ? 'LaLiga' : f.competitionCode === 'CL' ? 'Champions League' : leagueName);
    try {
      const { rows } = await pool.query(
        `INSERT INTO matches (external_id, league_name, competition_code, competition_slug, match_date, kickoff_utc, matchday, stage, home, away, status, home_goals, away_goals)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (external_id) DO UPDATE SET
           kickoff_utc = EXCLUDED.kickoff_utc, status = EXCLUDED.status, matchday = COALESCE(EXCLUDED.matchday, matches.matchday),
           stage = COALESCE(EXCLUDED.stage, matches.stage),
           home_goals = COALESCE(EXCLUDED.home_goals, matches.home_goals), away_goals = COALESCE(EXCLUDED.away_goals, matches.away_goals),
           updated_at = now()
         RETURNING *`,
        [
          f.id, leagueName, f.competitionCode || null, slug, String(f.kickoff).slice(0, 10), f.kickoff,
          Number.isFinite(f.matchday) ? f.matchday : null, f.stage || null, f.home, f.away, f.status || 'SCHEDULED',
          f.score?.home ?? null, f.score?.away ?? null
        ]
      );
      return rows[0];
    } catch (err) {
      logger.warn(`[matches] upsert ${f.id}: ${err.message}`);
      return null;
    }
  }

  async function setOddsEvent(matchId, eventId) {
    if (!pool || !matchId || !eventId) return;
    await pool.query('UPDATE matches SET odds_event_id = $1 WHERE id = $2 AND odds_event_id IS DISTINCT FROM $1', [eventId, matchId]).catch(() => {});
  }

  async function setResult(matchId, { homeGoals, awayGoals, status = 'FINISHED' }) {
    if (!pool) return;
    await pool.query(
      'UPDATE matches SET home_goals = $1, away_goals = $2, status = $3, updated_at = now() WHERE id = $4',
      [homeGoals, awayGoals, status, matchId]
    );
  }

  async function getByExternalId(externalId) {
    if (!pool) return null;
    const { rows } = await pool.query(`SELECT * FROM matches WHERE external_id = $1 AND ${ACTIVE_SLUG_SQL}`, [externalId]);
    return rows[0] || null;
  }

  async function getById(id) {
    if (!pool) return null;
    const { rows } = await pool.query(`SELECT * FROM matches WHERE id = $1 AND ${ACTIVE_SLUG_SQL}`, [Number(id)]);
    return rows[0] || null;
  }

  /** Partidos activos que empiezan en la ventana indicada (para cuotas de cierre). */
  async function startingBetween(fromMs, toMs) {
    if (!pool) return [];
    const { rows } = await pool.query(
      `SELECT * FROM matches WHERE ${ACTIVE_SLUG_SQL} AND kickoff_utc BETWEEN $1 AND $2 ORDER BY kickoff_utc`,
      [new Date(fromMs), new Date(toMs)]
    );
    return rows;
  }

  /** Partidos activos ya jugados sin resultado guardado. */
  async function awaitingResult() {
    if (!pool) return [];
    const { rows } = await pool.query(
      `SELECT * FROM matches WHERE ${ACTIVE_SLUG_SQL} AND home_goals IS NULL
         AND kickoff_utc < now() - interval '2 hours 15 minutes' AND kickoff_utc > now() - interval '21 days'
       ORDER BY kickoff_utc LIMIT 60`
    );
    return rows;
  }

  return { upsertFixture, setOddsEvent, setResult, getByExternalId, getById, startingBetween, awaitingResult };
}
