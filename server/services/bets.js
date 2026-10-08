/**
 * Apuestas simuladas en PostgreSQL: registro, liquidación automática por id de
 * partido, cuota de cierre y CLV.
 */
import { SELECTIONS, SELECTION_MARKET, selectionLabel, settleSelection, profitMultiplier } from '../model/markets.js';
import { ACTIVE_SLUGS_SQL, slugForCode, isActiveCompetition } from '../competitions.js';

/** Resultado de una selección (incluye doble oportunidad, BTTS y hándicap asiático). */
export function evaluateSelectionResult(selection, homeGoals, awayGoals, line = null) {
  return settleSelection(selection, line, homeGoals, awayGoals);
}

/** Selección a partir de columnas antiguas (market/outcome) para apuestas previas a v9. */
export function legacySelection(market, outcome) {
  if (market === 'h2h' && ['home', 'draw', 'away'].includes(outcome)) return outcome;
  if (market === 'totals' && outcome === 'over') return 'over25';
  if (market === 'totals' && outcome === 'under') return 'under25';
  return null;
}

export function computeProfit(status, stake, odds) {
  const s = Number(stake) || 0;
  return Number((s * profitMultiplier(status, odds)).toFixed(2));
}

/** Estado de una combinada a partir de sus patas. */
export function settleParlay(legs) {
  if (legs.some(l => l.status === 'lost')) return { status: 'lost', odds: null };
  if (legs.some(l => !l.status || l.status === 'pending')) return { status: 'pending', odds: null };
  // Factor de pago por pata: ganada = cuota, media ganada = (1 + cuota) / 2,
  // media perdida = 0.5, nula = 1 (hándicap asiático).
  const factor = l => (l.status === 'won' ? Number(l.odds) : l.status === 'half_won' ? (1 + Number(l.odds)) / 2 : l.status === 'half_lost' ? 0.5 : 1);
  if (legs.every(l => l.status === 'void')) return { status: 'void', odds: null };
  const odds = legs.reduce((s, l) => s * factor(l), 1);
  if (odds < 1) return { status: 'lost', odds, partial: true };
  return { status: 'won', odds };
}

function rowToBet(r) {
  const odds = Number(r.odds);
  const closingP = r.closing_fair_probability != null ? Number(r.closing_fair_probability) : null;
  return {
    id: r.id,
    createdAt: r.created_at,
    matchDate: r.match_date,
    kickoff: r.kickoff_utc,
    fixtureId: r.fixture_id,
    home: r.home,
    away: r.away,
    competition: r.competition,
    competitionSlug: r.competition_slug || null,
    line: r.line != null ? Number(r.line) : null,
    bookmaker: r.bookmaker || null,
    market: r.market,
    selection: r.selection || legacySelection(r.market, r.outcome) || (r.market === 'parlay' ? 'parlay' : null),
    label: r.market_name,
    odds,
    probability: r.model_probability != null ? Number(r.model_probability) : null,
    stake: Number(r.stake),
    currency: r.currency,
    status: r.status,
    profit: r.profit != null ? Number(r.profit) : null,
    settledAt: r.settled_at,
    score: r.home_goals != null ? `${r.home_goals}-${r.away_goals}` : null,
    closingOdds: r.closing_odds != null ? Number(r.closing_odds) : null,
    clvPct: closingP ? Number(((odds * closingP - 1) * 100).toFixed(2)) : null,
    legs: r.legs_json || null
  };
}

export function createBetsService({ pool, footballData, odds, analysis, teams, bankroll, logger = console }) {
  function requireDb() {
    if (!pool) {
      const err = new Error('La base de datos PostgreSQL no está configurada (DATABASE_URL).');
      err.status = 503;
      throw err;
    }
  }

  async function create(body) {
    requireDb();
    const { fixtureId, competition, kickoff, home, away, selection, odds: price, probability, stake, legs, line = null, bookmaker = null } = body || {};
    if (competition && !isActiveCompetition(competition)) {
      const err = new Error('Competición desactivada: solo se registran apuestas de LaLiga y Champions.');
      err.status = 400;
      throw err;
    }
    const isParlay = selection === 'parlay';
    if (!home || !away || !(Number(price) > 1) || (!isParlay && !SELECTIONS.includes(selection))) {
      const err = new Error('Datos incompletos: home, away, selection válida y odds > 1 son obligatorios.');
      err.status = 400;
      throw err;
    }
    if (isParlay && (!Array.isArray(legs) || legs.length < 2 || legs.some(l => !SELECTIONS.includes(l.selection)))) {
      const err = new Error('Una combinada necesita al menos 2 patas con selección válida.');
      err.status = 400;
      throw err;
    }
    const maxStake = bankroll.bankroll * 0.1;
    const finalStake = Number.isFinite(Number(stake)) && Number(stake) > 0 ? Math.min(Number(stake), maxStake) : bankroll.flatStake;
    const matchDate = kickoff ? String(kickoff).slice(0, 10) : null;

    const { rows } = await pool.query(
      `INSERT INTO simulated_bets
        (match_date, kickoff_utc, fixture_id, home, away, competition, market, outcome, selection, market_name, odds, model_probability, stake, currency, status, legs_json, competition_slug, line, bookmaker)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending',$15,$16,$17,$18) RETURNING *`,
      [
        matchDate, kickoff || null, fixtureId || null, home, away, competition || null,
        isParlay ? 'parlay' : SELECTION_MARKET[selection], selection, selection,
        isParlay ? `Combinada (${legs.length} patas)` : selectionLabel(selection, line, { home, away }),
        Number(price), probability != null ? Number(probability) : null, finalStake, bankroll.currency,
        isParlay ? JSON.stringify(legs.map(l => ({ ...l, status: 'pending' }))) : null,
        slugForCode(competition), line != null && Number.isFinite(Number(line)) ? Number(line) : null, bookmaker ? String(bookmaker).slice(0, 50) : null
      ]
    );
    return rowToBet(rows[0]);
  }

  async function list({ period = '' } = {}) {
    requireDb();
    const intervals = { week: '7 days', month: '30 days', year: '365 days' };
    const params = [];
    let where = `WHERE ${ACTIVE_SLUGS_SQL}`;
    if (intervals[period]) { params.push(intervals[period]); where += ' AND created_at >= now() - $1::interval'; }
    const { rows } = await pool.query(`SELECT * FROM simulated_bets ${where} ORDER BY created_at DESC LIMIT 500`, params);
    return rows.map(rowToBet);
  }

  async function settleManual(id, result) {
    requireDb();
    if (!['won', 'lost', 'void', 'pending', 'half_won', 'half_lost'].includes(result)) {
      const err = new Error("El resultado debe ser 'won', 'lost', 'half_won', 'half_lost', 'void' o 'pending'.");
      err.status = 400;
      throw err;
    }
    const { rows } = await pool.query('SELECT * FROM simulated_bets WHERE id = $1', [Number(id)]);
    if (!rows.length) { const err = new Error('Apuesta no encontrada.'); err.status = 404; throw err; }
    const profit = result === 'pending' ? null : computeProfit(result, rows[0].stake, rows[0].odds);
    const upd = await pool.query(
      `UPDATE simulated_bets SET status = $1, profit = $2, settled_at = CASE WHEN $1 = 'pending' THEN NULL ELSE now() END WHERE id = $3 RETURNING *`,
      [result, profit, Number(id)]
    );
    return rowToBet(upd.rows[0]);
  }

  async function remove(id) {
    requireDb();
    await pool.query('DELETE FROM simulated_bets WHERE id = $1', [Number(id)]);
    return { ok: true };
  }

  /** Resultado final de un partido por id (football-data) o por equipos (The Odds API). */
  async function resultFor({ fixtureId, competition, home, away, kickoff }) {
    if (fixtureId?.startsWith('fd-') && footballData.configured) {
      const m = await footballData.getMatch(fixtureId.slice(3), { ttlSeconds: 900 });
      if (m?.status !== 'FINISHED') return null;
      const ft = m.score?.fullTime;
      return Number.isFinite(ft?.home) ? { homeGoals: ft.home, awayGoals: ft.away } : null;
    }
    if (competition) {
      const scores = await odds.getScores(competition, 3);
      const found = teams.matchEvent({ home, away, kickoff }, scores, competition);
      if (found && Number.isFinite(found.event.homeGoals)) {
        return found.reversed
          ? { homeGoals: found.event.awayGoals, awayGoals: found.event.homeGoals }
          : { homeGoals: found.event.homeGoals, awayGoals: found.event.awayGoals };
      }
    }
    return null;
  }

  async function autoSettle() {
    if (!pool) return { settled: 0, checked: 0 };
    const { rows } = await pool.query(
      `SELECT * FROM simulated_bets WHERE status = 'pending' AND ${ACTIVE_SLUGS_SQL}
         AND (kickoff_utc IS NULL OR kickoff_utc < now() - interval '2 hours 15 minutes')
       ORDER BY kickoff_utc NULLS LAST LIMIT 100`
    );
    let settled = 0;
    for (const r of rows) {
      try {
        if (r.market === 'parlay') {
          const legs = r.legs_json || [];
          for (const leg of legs) {
            if (leg.status && leg.status !== 'pending') continue;
            if (leg.kickoff && new Date(leg.kickoff).getTime() > Date.now() - 2.25 * 3600000) continue;
            const res = await resultFor(leg);
            if (res) leg.status = evaluateSelectionResult(leg.selection, res.homeGoals, res.awayGoals, leg.line ?? null);
          }
          const p = settleParlay(legs);
          if (p.status === 'pending') {
            await pool.query('UPDATE simulated_bets SET legs_json = $1 WHERE id = $2', [JSON.stringify(legs), r.id]);
            continue;
          }
          const profit = p.partial
            ? Number((Number(r.stake) * (p.odds - 1)).toFixed(2))
            : p.status === 'won' ? computeProfit('won', r.stake, p.odds) : computeProfit(p.status, r.stake, r.odds);
          await pool.query(
            `UPDATE simulated_bets SET status = $1, profit = $2, settled_at = now(), legs_json = $3 WHERE id = $4`,
            [p.status, profit, JSON.stringify(legs), r.id]
          );
          settled++;
          continue;
        }

        const selection = r.selection || legacySelection(r.market, r.outcome);
        if (!selection) continue;
        const res = await resultFor({
          fixtureId: r.fixture_id, competition: r.competition, home: r.home, away: r.away,
          kickoff: r.kickoff_utc ? new Date(r.kickoff_utc).toISOString() : null
        });
        if (!res) continue;
        const status = evaluateSelectionResult(selection, res.homeGoals, res.awayGoals, r.line != null ? Number(r.line) : null);
        if (!status) continue;
        await pool.query(
          `UPDATE simulated_bets SET status = $1, profit = $2, settled_at = now(), home_goals = $3, away_goals = $4 WHERE id = $5`,
          [status, computeProfit(status, r.stake, r.odds), res.homeGoals, res.awayGoals, r.id]
        );
        settled++;
      } catch (err) {
        logger.warn(`[bets] No se pudo liquidar la apuesta ${r.id}: ${err.message}`);
      }
    }
    return { settled, checked: rows.length };
  }

  /** Guarda la cuota de cierre (último precio antes del inicio) para medir CLV. */
  async function captureClosingOdds() {
    if (!pool) return { captured: 0 };
    const { rows } = await pool.query(
      `SELECT * FROM simulated_bets WHERE status = 'pending' AND market <> 'parlay' AND closing_odds IS NULL AND ${ACTIVE_SLUGS_SQL}
         AND kickoff_utc BETWEEN now() AND now() + interval '25 minutes'`
    );
    let captured = 0;
    for (const r of rows) {
      const selection = r.selection || legacySelection(r.market, r.outcome);
      const fixture = {
        competitionCode: r.competition, home: r.home, away: r.away,
        kickoff: new Date(r.kickoff_utc).toISOString()
      };
      const market = await analysis.getMarket(fixture);
      if (!market.available || !market.prices[selection]?.median || !market.fair?.[selection]) continue;
      await pool.query(
        'UPDATE simulated_bets SET closing_odds = $1, closing_fair_probability = $2 WHERE id = $3',
        [market.prices[selection].median, market.fair[selection], r.id]
      );
      captured++;
    }
    return { captured };
  }

  async function summary({ period = 'month' } = {}) {
    requireDb();
    const interval = { week: '7 days', month: '30 days', year: '365 days', all: '100 years' }[period] || '30 days';
    const { rows } = await pool.query(
      `SELECT * FROM simulated_bets WHERE ${ACTIVE_SLUGS_SQL} AND created_at >= now() - $1::interval`,
      [interval]
    );
    const bets = rows.map(rowToBet);
    const settled = bets.filter(b => ['won', 'lost', 'half_won', 'half_lost'].includes(b.status));
    const staked = settled.reduce((s, b) => s + b.stake, 0);
    const profit = settled.reduce((s, b) => s + (b.profit || 0), 0);
    const clv = bets.filter(b => b.clvPct != null);
    return {
      period,
      currency: bankroll.currency,
      total: bets.length,
      pending: bets.filter(b => b.status === 'pending').length,
      won: bets.filter(b => b.status === 'won' || b.status === 'half_won').length,
      lost: bets.filter(b => b.status === 'lost' || b.status === 'half_lost').length,
      void: bets.filter(b => b.status === 'void').length,
      staked: Number(staked.toFixed(2)),
      profit: Number(profit.toFixed(2)),
      roiPct: staked ? Number(((100 * profit) / staked).toFixed(2)) : null,
      hitRatePct: settled.length ? Number(((100 * settled.filter(b => b.status === 'won').length) / settled.length).toFixed(1)) : null,
      avgClvPct: clv.length ? Number((clv.reduce((s, b) => s + b.clvPct, 0) / clv.length).toFixed(2)) : null,
      clvSample: clv.length
    };
  }

  return { create, list, settleManual, remove, autoSettle, captureClosingOdds, summary };
}
