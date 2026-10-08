/**
 * Persistencia de la ingesta: partidos (matches), cuotas por casa
 * (bookmaker_odds) y probabilidad original del modelo (model_predictions).
 *
 * Todo es "best effort": si la base de datos falla, la app sigue respondiendo.
 */
import { slugForCode, COMPETITION_NAMES, isActiveCompetition } from '../competitions.js';
import { oddsRows } from '../model/marketBook.js';

export function createIngestService({ pool = null, logger = console, snapshotMinutes = 180, modelVersion = null } = {}) {
  const matchIds = new Map(); // external_id -> id
  const lastSnapshot = new Map(); // match_id -> ms

  async function upsertMatch(f) {
    if (!pool || !isActiveCompetition(f.competitionCode)) return null;
    if (matchIds.has(f.id) && !f.score) return matchIds.get(f.id);
    const leagueName = COMPETITION_NAMES[f.competitionCode] || f.competition;
    const { rows } = await pool.query(
      `INSERT INTO matches (external_id, odds_event_id, league_name, competition_code, competition_slug, match_date, kickoff_utc, home, away, status, home_goals, away_goals)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (external_id) DO UPDATE SET
         odds_event_id = COALESCE(EXCLUDED.odds_event_id, matches.odds_event_id),
         kickoff_utc = COALESCE(EXCLUDED.kickoff_utc, matches.kickoff_utc),
         match_date = COALESCE(EXCLUDED.match_date, matches.match_date),
         status = COALESCE(EXCLUDED.status, matches.status),
         home_goals = COALESCE(EXCLUDED.home_goals, matches.home_goals),
         away_goals = COALESCE(EXCLUDED.away_goals, matches.away_goals),
         updated_at = now()
       RETURNING id`,
      [
        f.id, f.oddsEventId || null, leagueName, f.competitionCode, slugForCode(f.competitionCode),
        f.kickoff ? String(f.kickoff).slice(0, 10) : null, f.kickoff || null, f.home, f.away, f.status || null,
        f.score?.home ?? null, f.score?.away ?? null
      ]
    );
    const id = rows[0]?.id ?? null;
    if (id) matchIds.set(f.id, id);
    return id;
  }

  /**
   * Guarda una captura de cuotas. Se limita a una cada `snapshotMinutes` por
   * partido (salvo cierre) para no llenar la base de datos gratuita.
   * La primera captura de cada (casa, mercado, selección, línea) queda como apertura.
   */
  async function saveOddsSnapshot(matchId, books, { capturedAt, mainLine = null, isClosing = false } = {}) {
    if (!pool || !matchId || !books?.length) return 0;
    const ts = capturedAt ? new Date(capturedAt) : new Date();
    const last = lastSnapshot.get(matchId);
    if (!isClosing && last && ts.getTime() - last < snapshotMinutes * 60000) return 0;

    const rows = oddsRows(books, mainLine);
    if (!rows.length) return 0;
    const existing = await pool.query(
      'SELECT DISTINCT bookmaker, market, selection, line FROM bookmaker_odds WHERE match_id = $1',
      [matchId]
    );
    const seen = new Set(existing.rows.map(r => `${r.bookmaker}|${r.market}|${r.selection}|${Number(r.line)}`));

    const values = [];
    const params = [];
    for (const r of rows) {
      const isOpening = !seen.has(`${r.bookmaker}|${r.market}|${r.selection}|${Number(r.line)}`);
      const i = params.length;
      params.push(matchId, r.bookmaker, r.market, r.selection, r.line, r.odds, ts, isOpening, isClosing);
      values.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9})`);
    }
    const res = await pool.query(
      `INSERT INTO bookmaker_odds (match_id, bookmaker, market, selection, line, odds, captured_at, is_opening, is_closing)
       VALUES ${values.join(',')}
       ON CONFLICT (match_id, bookmaker, market, selection, line, captured_at)
       DO UPDATE SET is_closing = bookmaker_odds.is_closing OR EXCLUDED.is_closing`,
      params
    );
    lastSnapshot.set(matchId, ts.getTime());
    return res.rowCount || 0;
  }

  /** Guarda (o actualiza antes del inicio) la probabilidad original del modelo. */
  async function savePredictions(matchId, competitionCode, kickoff, predictions) {
    if (!pool || !matchId || !predictions?.length) return 0;
    if (kickoff && new Date(kickoff).getTime() <= Date.now()) return 0; // nunca después del inicio
    const slug = slugForCode(competitionCode);
    const values = [];
    const params = [];
    for (const p of predictions) {
      if (!Number.isFinite(p.modelProbability)) continue;
      const i = params.length;
      params.push(matchId, slug, p.market, p.selection, p.line ?? 0, p.modelProbability, p.calibratedProbability ?? null, p.marketProbability ?? null, modelVersion);
      values.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5},$${i + 6},$${i + 7},$${i + 8},$${i + 9})`);
    }
    if (!values.length) return 0;
    const res = await pool.query(
      `INSERT INTO model_predictions (match_id, competition_slug, market, selection, line, model_probability, calibrated_probability, market_probability, model_version)
       VALUES ${values.join(',')}
       ON CONFLICT (match_id, market, selection, line) DO UPDATE SET
         model_probability = EXCLUDED.model_probability,
         calibrated_probability = EXCLUDED.calibrated_probability,
         market_probability = COALESCE(EXCLUDED.market_probability, model_predictions.market_probability),
         model_version = EXCLUDED.model_version,
         predicted_at = now()
       WHERE model_predictions.outcome IS NULL`,
      params
    );
    return res.rowCount || 0;
  }

  /** Probabilidad de cierre y cuota de cierre de una selección (último snapshot marcado como cierre). */
  async function closingFor(matchId, market, selection, line = 0) {
    if (!pool || !matchId) return null;
    const { rows } = await pool.query(
      `SELECT bookmaker, odds, captured_at FROM bookmaker_odds
        WHERE match_id = $1 AND market = $2 AND selection = $3 AND line = $4 AND is_closing
        ORDER BY captured_at DESC`,
      [matchId, market, selection, line]
    );
    return rows;
  }

  async function openingFor(matchId, market, selection, line = 0) {
    if (!pool || !matchId) return [];
    const { rows } = await pool.query(
      `SELECT bookmaker, odds, captured_at FROM bookmaker_odds
        WHERE match_id = $1 AND market = $2 AND selection = $3 AND line = $4 AND is_opening`,
      [matchId, market, selection, line]
    );
    return rows;
  }

  /** Marca el resultado del partido y resuelve sus predicciones (para la calibración). */
  async function settleMatch(matchId, homeGoals, awayGoals, settleFn) {
    if (!pool || !matchId) return 0;
    await pool.query(
      `UPDATE matches SET home_goals = $1, away_goals = $2, status = 'FINISHED', updated_at = now() WHERE id = $3`,
      [homeGoals, awayGoals, matchId]
    );
    const { rows } = await pool.query(
      'SELECT id, selection, line FROM model_predictions WHERE match_id = $1 AND outcome IS NULL',
      [matchId]
    );
    let n = 0;
    for (const r of rows) {
      const st = settleFn(r.selection, Number(r.line), homeGoals, awayGoals);
      if (!st) continue;
      const outcome = st === 'won' ? 1 : st === 'lost' ? 0 : null;
      if (outcome == null) continue;
      await pool.query('UPDATE model_predictions SET outcome = $1, settled_at = now() WHERE id = $2', [outcome, r.id]);
      n++;
    }
    return n;
  }

  /** Partidos activos ya jugados con predicciones sin resolver. */
  async function matchesToSettle(limit = 60) {
    if (!pool) return [];
    const { rows } = await pool.query(
      `SELECT m.* FROM matches m
        WHERE m.competition_slug IN ('la_liga', 'champions_league')
          AND m.kickoff_utc < now() - interval '2 hours 15 minutes'
          AND m.kickoff_utc > now() - interval '10 days'
          AND (m.home_goals IS NULL OR EXISTS (SELECT 1 FROM model_predictions p WHERE p.match_id = m.id AND p.outcome IS NULL))
        ORDER BY m.kickoff_utc LIMIT $1`,
      [limit]
    );
    return rows;
  }

  async function upcomingMatches(minutes = 25) {
    if (!pool) return [];
    const { rows } = await pool.query(
      `SELECT * FROM matches
        WHERE competition_slug IN ('la_liga', 'champions_league')
          AND kickoff_utc BETWEEN now() AND now() + ($1 || ' minutes')::interval`,
      [String(minutes)]
    );
    return rows;
  }

  /** Borra capturas intermedias antiguas (se conservan apertura y cierre). */
  async function purgeOldSnapshots(days = 30) {
    if (!pool) return 0;
    const res = await pool.query(
      `DELETE FROM bookmaker_odds b USING matches m
        WHERE b.match_id = m.id AND NOT b.is_opening AND NOT b.is_closing
          AND m.kickoff_utc < now() - ($1 || ' days')::interval`,
      [String(days)]
    );
    return res.rowCount || 0;
  }

  return { upsertMatch, saveOddsSnapshot, savePredictions, closingFor, openingFor, settleMatch, matchesToSettle, upcomingMatches, purgeOldSnapshots };
}
