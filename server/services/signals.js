/**
 * Señales del ValueBettingEngine y Performance Lab.
 *
 * - generate(): analiza los próximos partidos de LaLiga y Champions, guarda la
 *   predicción original del modelo (model_predictions) y registra como señal
 *   (bet_signals) cada selección recomendada, con la cuota EXACTA de Caliente MX
 *   y su hora de captura. Máximo 3 por jornada.
 * - captureClosing(): cuotas de cierre de todas las casas + Caliente → CLV.
 * - settle(): resultado real, beneficio y resultado de cada predicción.
 * - performance(days): métricas del panel “Rendimiento — LaLiga y Champions”.
 */
import { ACTIVE_SLUG_SQL, ACTIVE_CODES, COMPETITION_NAMES, codeForSlug } from '../competitions.js';
import { settleSelection, profitPerUnit, marketConsensus, averageOdds, MARKET_LABELS } from '../model/markets.js';
import { capPerMatchday } from '../model/valueEngine.js';
import { MODEL_VERSION } from '../version.js';
import { CALIENTE } from './oddsStore.js';

const n = v => (v == null ? null : Number(v));
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

export function rowToSignal(r) {
  return {
    id: r.id,
    matchId: r.match_id,
    competitionSlug: r.competition_slug,
    competition: COMPETITION_NAMES[codeForSlug(r.competition_slug)] || r.competition_slug,
    matchdayKey: r.matchday_key,
    home: r.home, away: r.away, kickoff: r.kickoff_utc,
    market: r.market, marketLabel: MARKET_LABELS[r.market] || r.market,
    selection: r.selection, label: r.label,
    modelProbabilityRaw: n(r.model_probability_raw),
    modelProbability: n(r.model_probability),
    marketProbability: n(r.market_probability),
    marketBooks: r.market_books,
    marketAvgOdds: n(r.market_avg_odds),
    calienteOdds: n(r.caliente_odds),
    calienteCapturedAt: r.caliente_captured_at,
    ev: n(r.ev), marketGap: n(r.market_gap),
    stake: n(r.stake), currency: r.currency, mode: r.mode,
    status: r.status, profit: n(r.profit),
    closingCalienteOdds: n(r.closing_caliente_odds),
    closingMarketProbability: n(r.closing_market_probability),
    closingMarketAvgOdds: n(r.closing_market_avg_odds),
    clv: n(r.clv),
    score: r.home_goals != null ? `${r.home_goals}-${r.away_goals}` : null,
    createdAt: r.created_at, settledAt: r.settled_at
  };
}

/** Métricas puras a partir de señales (testeable sin base de datos). */
export function computePerformance(signals, { days = 30, bankroll = null } = {}) {
  const settled = signals.filter(s => ['won', 'lost', 'void', 'half_won', 'half_lost'].includes(s.status));
  const graded = settled.filter(s => s.status !== 'void');
  const staked = settled.reduce((a, s) => a + s.stake, 0);
  const profit = settled.reduce((a, s) => a + (s.profit || 0), 0);
  const wins = graded.filter(s => s.status === 'won' || s.status === 'half_won').length;
  const withClv = signals.filter(s => s.clv != null);
  const avg = (arr, f) => (arr.length ? arr.reduce((a, x) => a + f(x), 0) / arr.length : null);

  const groupBy = (keyFn) => {
    const m = new Map();
    for (const s of signals) {
      const k = keyFn(s);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(s);
    }
    return [...m.entries()].map(([key, arr]) => {
      const st = arr.filter(s => s.status !== 'pending');
      const gr = st.filter(s => s.status !== 'void');
      const stake = st.reduce((a, s) => a + s.stake, 0);
      const pr = st.reduce((a, s) => a + (s.profit || 0), 0);
      const clv = arr.filter(s => s.clv != null);
      return {
        key,
        competitionSlug: arr[0].competitionSlug,
        competition: arr[0].competition,
        market: arr[0].market,
        marketLabel: arr[0].marketLabel,
        signals: arr.length,
        settled: st.length,
        hitRatePct: gr.length ? round((100 * gr.filter(s => s.status === 'won' || s.status === 'half_won').length) / gr.length, 1) : null,
        profit: round(pr),
        yieldPct: stake ? round((100 * pr) / stake) : null,
        avgEvPct: round(avg(arr, s => s.ev) * 100),
        avgClvPct: clv.length ? round(avg(clv, s => s.clv) * 100) : null
      };
    });
  };

  const byCompMarket = groupBy(s => `${s.competitionSlug}|${s.market}`).sort((a, b) => a.key.localeCompare(b.key));
  const byCompetition = groupBy(s => s.competitionSlug);
  const ranked = byCompMarket.filter(g => g.settled >= 1).sort((a, b) => (b.yieldPct ?? -1e9) - (a.yieldPct ?? -1e9));

  // Calibración por rangos 50–60, 60–70, 70–80 con la probabilidad calibrada
  const ranges = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8]];
  const calibration = ranges.map(([lo, hi]) => {
    const arr = graded.filter(s => s.modelProbability >= lo && s.modelProbability < hi);
    return {
      range: `${lo * 100}–${hi * 100}%`,
      signals: arr.length,
      predictedPct: arr.length ? round(avg(arr, s => s.modelProbability) * 100, 1) : null,
      actualPct: arr.length ? round((100 * arr.filter(s => s.status === 'won' || s.status === 'half_won').length) / arr.length, 1) : null,
      rawPredictedPct: arr.length ? round(avg(arr, s => s.modelProbabilityRaw) * 100, 1) : null
    };
  });

  // Caliente MX contra el mercado promedio (misma selección, mismo momento)
  const cmp = signals.filter(s => s.marketAvgOdds > 1 && s.calienteOdds > 1);
  const closingCmp = signals.filter(s => s.closingCalienteOdds > 1 && s.calienteOdds > 1);
  const calienteVsMarket = {
    signals: cmp.length,
    avgCalienteOdds: round(avg(cmp, s => s.calienteOdds), 3),
    avgMarketOdds: round(avg(cmp, s => s.marketAvgOdds), 3),
    avgPremiumPct: cmp.length ? round(avg(cmp, s => s.calienteOdds / s.marketAvgOdds - 1) * 100) : null,
    betterThanMarketPct: cmp.length ? round((100 * cmp.filter(s => s.calienteOdds > s.marketAvgOdds).length) / cmp.length, 1) : null,
    beatCalienteClosePct: closingCmp.length ? round((100 * closingCmp.filter(s => s.calienteOdds > s.closingCalienteOdds).length) / closingCmp.length, 1) : null
  };

  return {
    days,
    totals: {
      signals: signals.length,
      pending: signals.filter(s => s.status === 'pending').length,
      settled: settled.length,
      won: signals.filter(s => s.status === 'won' || s.status === 'half_won').length,
      lost: signals.filter(s => s.status === 'lost' || s.status === 'half_lost').length,
      void: signals.filter(s => s.status === 'void').length,
      hitRatePct: graded.length ? round((100 * wins) / graded.length, 1) : null,
      staked: round(staked),
      profit: round(profit),
      // ROI = beneficio neto / banca inicial; Yield = beneficio neto / total apostado
      roiPct: bankroll > 0 ? round((100 * profit) / bankroll) : null,
      yieldPct: staked ? round((100 * profit) / staked) : null,
      avgEvPct: signals.length ? round(avg(signals, s => s.ev) * 100) : null,
      avgClvPct: withClv.length ? round(avg(withClv, s => s.clv) * 100) : null,
      clvPositivePct: withClv.length ? round((100 * withClv.filter(s => s.clv > 0).length) / withClv.length, 1) : null,
      clvSample: withClv.length
    },
    byCompetition,
    byCompetitionMarket: byCompMarket,
    calibration,
    calienteVsMarket,
    bestMarkets: ranked.slice(0, 3),
    worstMarkets: ranked.slice(-3).reverse(),
    keyQuestion: {
      text: '¿MK Bets encuentra apuestas en Caliente MX con EV positivo y las toma antes de que el mercado corrija la cuota?',
      evPositive: signals.length ? signals.every(s => s.ev > 0) : null,
      clvPositivePct: withClv.length ? round((100 * withClv.filter(s => s.clv > 0).length) / withClv.length, 1) : null,
      avgClvPct: withClv.length ? round(avg(withClv, s => s.clv) * 100) : null,
      verdict: withClv.length < 50
        ? `Muestra insuficiente (${withClv.length} señales con cierre). Meta: 300–500 señales reales antes de concluir.`
        : (avg(withClv, s => s.clv) > 0 && withClv.filter(s => s.clv > 0).length / withClv.length > 0.5)
          ? 'Sí, por ahora: las cuotas tomadas en Caliente superan al cierre del mercado.'
          : 'No, por ahora: el mercado de cierre no confirma las cuotas tomadas.'
    }
  };
}

export function createSignalsService({ pool, analysis, footballData, matchesRepo, oddsStore, calibration, odds, teams, bankroll, paperTrading = true, engineRules, logger = console }) {
  function requireDb() {
    if (!pool) {
      const err = new Error('La base de datos PostgreSQL no está configurada (DATABASE_URL).');
      err.status = 503;
      throw err;
    }
  }

  async function savePredictions(a) {
    if (!a.matchId) return;
    const rows = a.engine.filter(e => e.modelRaw != null);
    for (const e of rows) {
      await pool.query(
        `INSERT INTO model_predictions (match_id, competition_slug, market, selection, raw_probability, calibrated_probability, market_probability, model_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (match_id, market, selection) DO UPDATE SET
           raw_probability = EXCLUDED.raw_probability, calibrated_probability = EXCLUDED.calibrated_probability,
           market_probability = EXCLUDED.market_probability, model_version = EXCLUDED.model_version, predicted_at = now()
         WHERE model_predictions.result IS NULL`,
        [a.matchId, a.competitionSlug, e.market, e.selection, e.modelRaw, e.modelProbability, e.marketProbability, MODEL_VERSION]
      ).catch(err => logger.warn(`[signals] predicción ${a.matchId}/${e.selection}: ${err.message}`));
    }
  }

  async function takenPerMatchday() {
    const { rows } = await pool.query(`SELECT matchday_key, COUNT(*)::int AS c FROM bet_signals WHERE ${ACTIVE_SLUG_SQL} GROUP BY matchday_key`);
    return Object.fromEntries(rows.map(r => [r.matchday_key, r.c]));
  }

  async function signaledMatches() {
    const { rows } = await pool.query(`SELECT DISTINCT match_id FROM bet_signals WHERE ${ACTIVE_SLUG_SQL} AND status = 'pending'`);
    return new Set(rows.map(r => r.match_id));
  }

  /** Analiza los próximos días y registra señales nuevas. */
  async function generate({ days = 4, tzOffset = 0, dryRun = false } = {}) {
    requireDb();
    const fromDate = new Date().toISOString().slice(0, 10);
    const { analyses, warnings } = await analysis.analyzeRange({ fromDate, days, tzOffset });
    for (const a of analyses) await savePredictions(a);

    const already = await signaledMatches();
    const candidates = [];
    for (const a of analyses) {
      if (!a.matchId || already.has(a.matchId)) continue;
      for (const e of a.recommended) candidates.push({ ...e, fixtureId: a.id, matchId: a.matchId, matchdayKey: a.matchdayKey, competitionSlug: a.competitionSlug, home: a.home, away: a.away, kickoff: a.kickoff });
    }
    const { kept, dropped } = capPerMatchday(candidates, { maxBetsPerMatchday: engineRules.maxBetsPerMatchday, alreadyTaken: await takenPerMatchday() });

    const created = [];
    if (!dryRun) {
      for (const c of kept) {
        const { rows } = await pool.query(
          `INSERT INTO bet_signals (match_id, competition_slug, matchday_key, market, selection, label, model_version,
             model_probability_raw, model_probability, market_probability, market_books, market_avg_odds,
             caliente_odds, caliente_captured_at, ev, market_gap, stake, currency, mode)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT (match_id, market, selection) DO NOTHING RETURNING id`,
          [c.matchId, c.competitionSlug, c.matchdayKey, c.market, c.selection, c.label, MODEL_VERSION,
            c.modelRaw, c.modelProbability, c.marketProbability, c.marketBooks, c.marketAvgOdds,
            c.caliente.odds, c.caliente.capturedAt, c.ev, c.marketGap, bankroll.flatStake, bankroll.currency, paperTrading ? 'paper' : 'real']
        );
        if (rows.length) created.push({ id: rows[0].id, ...c });
      }
    }
    return {
      analyzed: analyses.length,
      withCaliente: analyses.filter(a => a.engine.some(e => e.caliente)).length,
      candidates: candidates.length,
      created: created.length,
      signals: (dryRun ? kept : created).map(c => ({
        fixtureId: c.fixtureId, home: c.home, away: c.away, kickoff: c.kickoff, competitionSlug: c.competitionSlug,
        matchdayKey: c.matchdayKey, market: c.market, selection: c.selection, label: c.label,
        modelProbability: c.modelProbability, marketProbability: c.marketProbability, calienteOdds: c.caliente.odds, ev: c.ev
      })),
      dropped: dropped.map(d => ({ home: d.home, away: d.away, label: d.label, ev: d.ev, reason: d.droppedReason })),
      warnings
    };
  }

  /** Candidatas actuales sin registrar (para la vista de señales). */
  async function preview({ days = 4, tzOffset = 0, competition = null } = {}) {
    const fromDate = new Date().toISOString().slice(0, 10);
    const { analyses, warnings } = await analysis.analyzeRange({ fromDate, days, tzOffset, competition });
    const candidates = [];
    const pendingCaliente = [];
    for (const a of analyses) {
      for (const e of a.recommended) candidates.push({ ...e, fixtureId: a.id, matchId: a.matchId, matchdayKey: a.matchdayKey, competitionSlug: a.competitionSlug, competition: a.competition, competitionCode: a.competitionCode, home: a.home, away: a.away, kickoff: a.kickoff, homeCrest: a.homeCrest, awayCrest: a.awayCrest });
      // Selecciones que serían jugables si Caliente paga al menos minCalienteOdds
      for (const e of a.engine) {
        if (e.caliente || e.modelProbability == null || e.marketProbability == null) continue;
        if (e.modelProbability - e.marketProbability > engineRules.maxMarketGap) continue;
        if (!(e.minCalienteOdds <= engineRules.maxOdds)) continue;
        const marketFair = 1 / e.marketProbability;
        if (e.minCalienteOdds > marketFair * 1.12) continue; // casi imposible que Caliente lo pague
        pendingCaliente.push({ fixtureId: a.id, competitionCode: a.competitionCode, competition: a.competition, kickoff: a.kickoff, home: a.home, away: a.away, selection: e.selection, label: e.label, market: e.market, modelProbability: e.modelProbability, marketProbability: e.marketProbability, marketAvgOdds: e.marketAvgOdds, minCalienteOdds: e.minCalienteOdds });
      }
    }
    const taken = pool ? await takenPerMatchday() : {};
    const { kept, dropped } = capPerMatchday(candidates, { maxBetsPerMatchday: engineRules.maxBetsPerMatchday, alreadyTaken: taken });
    pendingCaliente.sort((x, y) => (x.minCalienteOdds / (x.marketAvgOdds || 99)) - (y.minCalienteOdds / (y.marketAvgOdds || 99)));
    return { analyzed: analyses.length, recommended: kept, capped: dropped, toCheckInCaliente: pendingCaliente.slice(0, 20), warnings };
  }

  async function list({ days = 30 } = {}) {
    requireDb();
    const { rows } = await pool.query(
      `SELECT s.*, m.home, m.away, m.kickoff_utc FROM bet_signals s JOIN matches m ON m.id = s.match_id
        WHERE s.${ACTIVE_SLUG_SQL} AND s.created_at >= now() - $1::interval
        ORDER BY m.kickoff_utc DESC LIMIT 1000`,
      [`${Math.max(1, Number(days) || 30)} days`]
    );
    return rows.map(rowToSignal);
  }

  async function performance({ days = 30 } = {}) {
    const d = [7, 30, 60, 90].includes(Number(days)) ? Number(days) : 30;
    const signals = await list({ days: d });
    return { ...computePerformance(signals, { days: d, bankroll: bankroll.bankroll }), mode: paperTrading ? 'paper' : 'real', currency: bankroll.currency };
  }

  /** Cuotas de cierre: snapshot de todas las casas y cierre de Caliente → CLV. */
  async function captureClosing() {
    if (!pool) return { captured: 0 };
    const soon = await matchesRepo.startingBetween(Date.now(), Date.now() + 25 * 60000);
    let captured = 0;
    for (const m of soon) {
      const fixture = { competitionCode: m.competition_code, home: m.home, away: m.away, kickoff: new Date(m.kickoff_utc).toISOString() };
      const market = await analysis.getMarket(fixture);
      if (market.available) await oddsStore.recordBooks(m.id, market.books, { source: 'api', isClosing: true });
      await oddsStore.markClosing(m.id, m.kickoff_utc, CALIENTE);
      captured++;
    }
    await computeClv();
    return { captured };
  }

  /** CLV = cuota tomada en Caliente × probabilidad sin margen de cierre − 1. */
  async function computeClv() {
    const { rows } = await pool.query(
      `SELECT s.* FROM bet_signals s JOIN matches m ON m.id = s.match_id
        WHERE s.${ACTIVE_SLUG_SQL} AND s.clv IS NULL AND m.kickoff_utc < now() + interval '20 minutes'`
    );
    let updated = 0;
    for (const s of rows) {
      const closing = await oddsStore.closingBooks(s.match_id);
      if (!closing.length) continue;
      const { probs } = marketConsensus(closing);
      const pClose = probs[s.selection];
      const calClose = closing.find(b => b.bookmaker === CALIENTE)?.prices?.[s.selection] ?? null;
      const avgClose = averageOdds(closing, s.selection);
      if (pClose == null) continue;
      const clv = Number(s.caliente_odds) * pClose - 1;
      await pool.query(
        `UPDATE bet_signals SET clv = $1, closing_market_probability = $2, closing_caliente_odds = $3, closing_market_avg_odds = $4 WHERE id = $5`,
        [clv, pClose, calClose, avgClose, s.id]
      );
      updated++;
    }
    return updated;
  }

  async function resultForMatch(m) {
    if (m.external_id?.startsWith('fd-') && footballData.configured) {
      const fm = await footballData.getMatch(m.external_id.slice(3), { ttlSeconds: 900 });
      if (fm?.status !== 'FINISHED') return null;
      const sc = fm.score || {};
      const reg = sc.duration && sc.duration !== 'REGULAR' && sc.regularTime && Number.isFinite(sc.regularTime.home) ? sc.regularTime : sc.fullTime;
      return Number.isFinite(reg?.home) ? { homeGoals: reg.home, awayGoals: reg.away } : null;
    }
    const scores = await odds.getScores(m.competition_code, 3);
    const found = teams.matchEvent({ home: m.home, away: m.away, kickoff: new Date(m.kickoff_utc).toISOString() }, scores, m.competition_code);
    if (!found || !Number.isFinite(found.event.homeGoals)) return null;
    return found.reversed ? { homeGoals: found.event.awayGoals, awayGoals: found.event.homeGoals } : { homeGoals: found.event.homeGoals, awayGoals: found.event.awayGoals };
  }

  /** Liquida señales y predicciones con el resultado real (90 minutos). */
  async function settle() {
    if (!pool) return { settled: 0, predictions: 0 };
    const pendingMatches = await matchesRepo.awaitingResult();
    let settled = 0, predictions = 0, matches = 0;
    for (const m of pendingMatches) {
      try {
        const res = await resultForMatch(m);
        if (!res) continue;
        await matchesRepo.setResult(m.id, res);
        matches++;
      } catch (err) {
        logger.warn(`[signals] resultado ${m.id}: ${err.message}`);
      }
    }
    const { rows: preds } = await pool.query(
      `SELECT p.id, p.selection, m.home_goals, m.away_goals FROM model_predictions p JOIN matches m ON m.id = p.match_id
        WHERE p.result IS NULL AND m.home_goals IS NOT NULL AND m.${ACTIVE_SLUG_SQL}`
    );
    for (const p of preds) {
      const r = settleSelection(p.selection, p.home_goals, p.away_goals);
      // Para calibrar: medias apuestas cuentan como acierto/fallo; devoluciones se excluyen
      const label = r === 'half_won' ? 'won' : r === 'half_lost' ? 'lost' : r;
      await pool.query('UPDATE model_predictions SET result = $1 WHERE id = $2', [label, p.id]);
      predictions++;
    }
    const { rows: sigs } = await pool.query(
      `SELECT s.*, m.home_goals, m.away_goals FROM bet_signals s JOIN matches m ON m.id = s.match_id
        WHERE s.status = 'pending' AND m.home_goals IS NOT NULL AND s.${ACTIVE_SLUG_SQL}`
    );
    for (const s of sigs) {
      const r = settleSelection(s.selection, s.home_goals, s.away_goals);
      if (!r) continue;
      const profit = Number((Number(s.stake) * profitPerUnit(r, Number(s.caliente_odds))).toFixed(2));
      await pool.query(
        `UPDATE bet_signals SET status = $1, profit = $2, home_goals = $3, away_goals = $4, settled_at = now() WHERE id = $5`,
        [r, profit, s.home_goals, s.away_goals, s.id]
      );
      settled++;
    }
    return { matches, settled, predictions };
  }

  return { generate, preview, list, performance, captureClosing, computeClv, settle, competitions: ACTIVE_CODES };
}
