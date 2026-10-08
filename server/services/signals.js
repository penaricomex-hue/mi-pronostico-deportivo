/**
 * Señales de valor (tabla value_signals): registro con la cuota exacta de
 * ejecución en el momento de la señal, límite por jornada, cuota de cierre,
 * CLV, liquidación y Performance Lab.
 *
 * Todas las consultas filtran: competition_slug IN ('la_liga', 'champions_league').
 */
import { ACTIVE_SLUGS_SQL, ACTIVE_CODES, codeForSlug, COMPETITION_NAMES } from '../competitions.js';
import { settleSelection, profitMultiplier, hitValue, MARKETS } from '../model/markets.js';
import { normalizeFdMatch } from '../providers/footballData.js';

const round = (x, d = 2) => (x == null || !Number.isFinite(Number(x)) ? null : Number(Number(x).toFixed(d)));

function rowToSignal(r) {
  const n = v => (v == null ? null : Number(v));
  return {
    id: r.id,
    createdAt: r.created_at,
    fixtureId: r.fixture_id,
    matchId: r.match_id,
    competitionSlug: r.competition_slug,
    competition: COMPETITION_NAMES[codeForSlug(r.competition_slug)] || r.competition_slug,
    jornadaKey: r.jornada_key,
    kickoff: r.kickoff_utc,
    home: r.home,
    away: r.away,
    market: r.market,
    marketLabel: MARKETS[r.market]?.label || r.market,
    selection: r.selection,
    line: n(r.line),
    label: r.label,
    bookmaker: r.bookmaker,
    odds: n(r.odds),
    oddsCapturedAt: r.odds_captured_at,
    modelProbability: n(r.model_probability),
    calibratedProbability: n(r.calibrated_probability),
    marketProbability: n(r.market_probability),
    ev: n(r.ev),
    marketGap: n(r.market_gap),
    avgMarketOdds: n(r.avg_market_odds),
    bookmakerCount: r.bookmaker_count,
    stake: n(r.stake),
    currency: r.currency,
    mode: r.mode,
    modelVersion: r.model_version,
    status: r.status,
    profit: n(r.profit),
    score: r.home_goals != null ? `${r.home_goals}-${r.away_goals}` : null,
    settledAt: r.settled_at,
    closingOdds: n(r.closing_odds),
    closingFairProbability: n(r.closing_fair_probability),
    clv: n(r.clv)
  };
}

export function createSignalsService({ pool, analysis, footballData, odds, teams, ingest, calibration, bankroll, mode = 'paper', modelVersion = null, logger = console }) {
  function requireDb() {
    if (!pool) {
      const err = new Error('La base de datos PostgreSQL no está configurada (DATABASE_URL).');
      err.status = 503;
      throw err;
    }
  }

  /** Señales ya registradas por jornada (para el límite de 3). */
  async function countsByJornada(keys) {
    const out = new Map();
    if (!pool || !keys.length) return out;
    const { rows } = await pool.query(
      `SELECT jornada_key, COUNT(*)::int AS n FROM value_signals WHERE ${ACTIVE_SLUGS_SQL} AND jornada_key = ANY($1) GROUP BY jornada_key`,
      [keys]
    );
    for (const r of rows) out.set(r.jornada_key, r.n);
    return out;
  }

  async function existingFor(fixtureIds) {
    if (!pool || !fixtureIds.length) return new Set();
    const { rows } = await pool.query(
      `SELECT fixture_id, market, selection, line FROM value_signals WHERE ${ACTIVE_SLUGS_SQL} AND fixture_id = ANY($1)`,
      [fixtureIds]
    );
    return new Set(rows.map(r => `${r.fixture_id}|${r.market}|${r.selection}|${Number(r.line)}`));
  }

  const keyOf = (a, s) => `${a.id}|${s.market}|${s.selection}|${Number(s.line || 0)}`;
  const fixturesOf = set => new Set([...set].map(k => k.split('|')[0]));

  /**
   * Aplica el límite por jornada a un conjunto de análisis y marca las
   * selecciones que ya son señal registrada.
   */
  async function applyJornadaCap(analyses) {
    const all = [];
    for (const a of analyses) for (const s of a.selections || []) all.push({ a, s });
    const keys = [...new Set(all.map(x => x.s.jornadaKey).filter(Boolean))];
    let taken = new Map();
    let existing = new Set();
    try {
      taken = await countsByJornada(keys);
      existing = await existingFor(analyses.map(a => a.id));
    } catch (err) {
      logger.warn(`[signals] No se pudieron leer señales previas: ${err.message}`);
    }
    const candidates = all.map(({ a, s }) => ({ ...s, _a: a, alreadySignaled: existing.has(keyOf(a, s)) }));
    const capped = analysis.engine.capPerJornada(candidates, taken, { matchKey: c => c._a.id, takenMatches: fixturesOf(existing) });
    const byA = new Map();
    for (const c of capped) {
      const { _a, ...s } = c;
      if (!byA.has(_a)) byA.set(_a, []);
      byA.get(_a).push(s);
    }
    return analyses.map(a => {
      const selections = byA.get(a) || [];
      const best = selections.filter(s => s.recommended).sort((x, y) => y.ev - x.ev)[0] || null;
      return { ...a, selections, bestValue: best };
    });
  }

  /** Registra las selecciones recomendadas (idempotente). */
  async function recordFromAnalyses(analyses) {
    if (!pool) return { recorded: 0 };
    let recorded = 0;
    for (const a of analyses) {
      for (const s of a.selections || []) {
        if (!s.recommended || s.alreadySignaled) continue;
        try {
          const res = await pool.query(
            `INSERT INTO value_signals (match_id, fixture_id, competition_slug, jornada_key, kickoff_utc, home, away, market, selection, line, label,
               bookmaker, odds, odds_captured_at, model_probability, calibrated_probability, market_probability, push_probability, ev, market_gap,
               avg_market_odds, bookmaker_count, stake, currency, mode, model_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
             ON CONFLICT (fixture_id, market, selection, line) DO NOTHING`,
            [
              a.matchId || null, a.id, a.competitionSlug, s.jornadaKey, a.kickoff, a.home, a.away, s.market, s.selection, s.line || 0, s.label,
              s.executionBookmaker, s.executionOdds, a.odds.capturedAt || new Date().toISOString(), s.modelProbability, s.calibratedProbability,
              s.marketProbability, s.pushProbability ?? null, s.ev, s.marketGap, s.avgMarketOdds, s.bookmakerCount,
              bankroll.flatStake, bankroll.currency, mode, modelVersion
            ]
          );
          if (res.rowCount) { recorded++; s.alreadySignaled = true; }
        } catch (err) {
          logger.warn(`[signals] No se pudo registrar ${a.home}-${a.away} ${s.selection}: ${err.message}`);
        }
      }
    }
    return { recorded };
  }

  /** Escaneo programado: próximos 3 días de LaLiga y Champions. */
  async function scan({ days = 3 } = {}) {
    const fromDate = new Date().toISOString().slice(0, 10);
    const { analyses, warnings } = await analysis.analyzeRange({ fromDate, days, competition: null, tzOffset: 0, withInfo: false });
    const capped = await applyJornadaCap(analyses);
    const { recorded } = await recordFromAnalyses(capped);
    if (analyses.length) invalidateKickoffs();
    return { analyzed: analyses.length, recorded, warnings };
  }

  async function list({ days = 90, status = '' } = {}) {
    requireDb();
    const params = [String(days)];
    let where = `${ACTIVE_SLUGS_SQL} AND created_at >= now() - ($1 || ' days')::interval`;
    if (status) { params.push(status); where += ` AND status = $${params.length}`; }
    const { rows } = await pool.query(`SELECT * FROM value_signals WHERE ${where} ORDER BY kickoff_utc DESC NULLS LAST LIMIT 500`, params);
    return rows.map(rowToSignal);
  }

  /** Resultados finales de partidos recientes por competición (una llamada por competición). */
  async function recentResults() {
    const out = new Map();
    if (!footballData?.configured) return out;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 9 * 86400000).toISOString().slice(0, 10);
    for (const c of ACTIVE_CODES) {
      try {
        const list = await footballData.getMatches({ dateFrom: from, dateTo: to, competition: c, ttlSeconds: 1800 });
        for (const m of list) {
          if (m.status !== 'FINISHED') continue;
          const reg = m.score?.regularTime || m.score?.fullTime;
          if (!Number.isFinite(reg?.home)) continue;
          out.set(normalizeFdMatch(m).id, { homeGoals: reg.home, awayGoals: reg.away });
        }
      } catch (err) {
        logger.warn(`[signals] Resultados ${c}: ${err.message}`);
      }
    }
    return out;
  }

  async function resultForRow(r, results) {
    if (results.has(r.fixture_id || r.external_id)) return results.get(r.fixture_id || r.external_id);
    const code = r.competition_code || codeForSlug(r.competition_slug);
    if (!code || !odds?.getScores) return null;
    const scores = await odds.getScores(code, 3);
    const found = teams.matchEvent({ home: r.home, away: r.away, kickoff: r.kickoff_utc ? new Date(r.kickoff_utc).toISOString() : null }, scores, code);
    if (found && Number.isFinite(found.event.homeGoals)) {
      return found.reversed
        ? { homeGoals: found.event.awayGoals, awayGoals: found.event.homeGoals }
        : { homeGoals: found.event.homeGoals, awayGoals: found.event.awayGoals };
    }
    return null;
  }

  /** Liquida señales y predicciones; después recalibra (aprende de la jornada). */
  async function settle() {
    if (!pool) return { settled: 0, predictions: 0 };
    const results = await recentResults();
    let settled = 0;
    const { rows } = await pool.query(
      `SELECT * FROM value_signals WHERE ${ACTIVE_SLUGS_SQL} AND status = 'pending'
         AND kickoff_utc < now() - interval '2 hours 15 minutes' ORDER BY kickoff_utc LIMIT 100`
    );
    for (const r of rows) {
      try {
        const res = await resultForRow(r, results);
        if (!res) continue;
        const status = settleSelection(r.selection, Number(r.line), res.homeGoals, res.awayGoals);
        if (!status) continue;
        const profit = Number(r.stake) * profitMultiplier(status, Number(r.odds));
        await pool.query(
          `UPDATE value_signals SET status = $1, profit = $2, home_goals = $3, away_goals = $4, settled_at = now() WHERE id = $5`,
          [status, round(profit), res.homeGoals, res.awayGoals, r.id]
        );
        settled++;
      } catch (err) {
        logger.warn(`[signals] No se pudo liquidar la señal ${r.id}: ${err.message}`);
      }
    }

    let predictions = 0;
    if (ingest) {
      for (const m of await ingest.matchesToSettle()) {
        try {
          const res = await resultForRow({ ...m, fixture_id: m.external_id }, results);
          if (!res) continue;
          predictions += await ingest.settleMatch(m.id, res.homeGoals, res.awayGoals, settleSelection);
        } catch (err) {
          logger.warn(`[signals] Partido ${m.id}: ${err.message}`);
        }
      }
    }
    // Aprendizaje: cada liquidación (fin de jornada) reajusta los mapas de calibración
    if (predictions > 0 && calibration) await calibration.refit();
    return { settled, predictions, recalibrated: predictions > 0 };
  }

  /**
   * Cuota de cierre: justo antes del inicio se guarda una captura marcada como
   * cierre para TODOS los partidos activos que empiezan, y se calcula el CLV de
   * las señales: CLV = cuota tomada × probabilidad justa de cierre − 1.
   */
  // Se repite cada 5 min dentro de la ventana; la última captura antes del inicio
  // sobrescribe a la anterior (con caché de 15 min casi siempre sin coste extra).
  // Caché en memoria de los próximos inicios: el job corre cada 5 min, pero solo
  // consulta la base (Neon, que se suspende tras 5 min sin actividad) una vez por
  // hora o cuando de verdad hay un partido a punto de empezar.
  let kickoffCache = { at: 0, times: [] };
  async function nextKickoffs() {
    if (Date.now() - kickoffCache.at < 60 * 60000) return kickoffCache.times;
    const rows = await ingest.upcomingMatches(26 * 60);
    kickoffCache = { at: Date.now(), times: rows.map(r => new Date(r.kickoff_utc).getTime()) };
    return kickoffCache.times;
  }
  function invalidateKickoffs() { kickoffCache.at = 0; }

  async function captureClosing({ windowMinutes = 20 } = {}) {
    if (!pool || !ingest) return { matches: 0, signals: 0 };
    const now = Date.now();
    const soon = (await nextKickoffs()).some(t => t >= now && t <= now + windowMinutes * 60000);
    if (!soon) return { matches: 0, signals: 0, skipped: true };
    const upcoming = await ingest.upcomingMatches(windowMinutes);
    let matches = 0, signals = 0;
    for (const m of upcoming) {
      try {
        const fixture = { id: m.external_id, competitionCode: m.competition_code, home: m.home, away: m.away, kickoff: new Date(m.kickoff_utc).toISOString() };
        const market = await analysis.getMarket(fixture, { maxAgeMinutes: 15, withExtras: false, closing: true });
        if (!market.available) continue;
        // Si no hubo presupuesto, la captura solo vale como cierre si es de la última hora y media
        if (market.capturedAt && Date.now() - new Date(market.capturedAt).getTime() > 90 * 60000) continue;
        await ingest.saveOddsSnapshot(m.id, market.books, { capturedAt: market.capturedAt, mainLine: market.ah?.line ?? null, isClosing: true });
        matches++;

        const { rows } = await pool.query(
          `SELECT * FROM value_signals WHERE fixture_id = $1 AND status = 'pending' AND ${ACTIVE_SLUGS_SQL}`,
          [m.external_id]
        );
        for (const s of rows) {
          let fair = null, closeOdds = null;
          if (s.market === 'asian_handicap') {
            if (market.ah && Number(market.ah.line) === Number(s.line)) {
              fair = market.ah.fair?.[s.selection] ?? null;
              const p = market.ah.prices[s.selection];
              closeOdds = market.books.find(b => b.bookmaker === s.bookmaker)?.ah?.[String(s.line)]?.[s.selection === 'ah_home' ? 'home' : 'away'] ?? p?.median ?? null;
            }
          } else {
            fair = market.fair?.[s.selection] ?? null;
            closeOdds = market.books.find(b => b.bookmaker === s.bookmaker)?.prices?.[s.selection] ?? market.prices[s.selection]?.median ?? null;
          }
          if (!fair) continue;
          const clv = Number(s.odds) * fair - 1;
          await pool.query(
            `UPDATE value_signals SET closing_odds = $1, closing_fair_probability = $2, clv = $3, closing_captured_at = $4 WHERE id = $5`,
            [closeOdds, fair, clv, market.capturedAt || new Date().toISOString(), s.id]
          );
          signals++;
        }
      } catch (err) {
        logger.warn(`[signals] Cierre ${m.home}-${m.away}: ${err.message}`);
      }
    }
    return { matches, signals };
  }

  /** Performance Lab — LaLiga y Champions. */
  async function performance({ days = 30 } = {}) {
    requireDb();
    const d = [7, 30, 60, 90].includes(Number(days)) ? Number(days) : 30;
    const { rows } = await pool.query(
      `SELECT * FROM value_signals WHERE ${ACTIVE_SLUGS_SQL} AND created_at >= now() - ($1 || ' days')::interval`,
      [String(d)]
    );
    const all = rows.map(rowToSignal);
    const resolved = all.filter(s => ['won', 'lost', 'half_won', 'half_lost', 'void'].includes(s.status));
    const graded = resolved.filter(s => hitValue(s.status) != null);

    function agg(list) {
      const g = list.filter(s => hitValue(s.status) != null);
      const staked = list.filter(s => s.status !== 'pending').reduce((a, s) => a + s.stake, 0);
      const profit = list.reduce((a, s) => a + (s.profit || 0), 0);
      const clv = list.filter(s => s.clv != null);
      return {
        signals: list.length,
        resolved: list.filter(s => s.status !== 'pending').length,
        hitRatePct: g.length ? round((100 * g.reduce((a, s) => a + hitValue(s.status), 0)) / g.length, 1) : null,
        staked: round(staked),
        profit: round(profit),
        yieldPct: staked ? round((100 * profit) / staked) : null,
        avgEvPct: list.length ? round((100 * list.reduce((a, s) => a + (s.ev || 0), 0)) / list.length) : null,
        avgClvPct: clv.length ? round((100 * clv.reduce((a, s) => a + s.clv, 0)) / clv.length) : null,
        clvPositivePct: clv.length ? round((100 * clv.filter(s => s.clv > 0).length) / clv.length, 1) : null,
        clvSample: clv.length
      };
    }

    const totals = agg(all);
    const settledStaked = resolved.reduce((a, s) => a + s.stake, 0);
    const profit = resolved.reduce((a, s) => a + (s.profit || 0), 0);

    const breakdown = {};
    for (const s of all) {
      const k = `${s.competitionSlug}|${s.market}`;
      (breakdown[k] = breakdown[k] || []).push(s);
    }
    const byMarket = Object.entries(breakdown).map(([k, list]) => {
      const [competitionSlug, market] = k.split('|');
      return { competitionSlug, competition: COMPETITION_NAMES[codeForSlug(competitionSlug)], market, marketLabel: MARKETS[market]?.label || market, ...agg(list) };
    }).sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0));

    const byCompetition = ['la_liga', 'champions_league'].map(slug => ({
      competitionSlug: slug, competition: COMPETITION_NAMES[codeForSlug(slug)], ...agg(all.filter(s => s.competitionSlug === slug))
    }));

    // Calibración real de las señales resueltas: probabilidad calibrada vs acierto
    const bands = [[0.5, 0.6], [0.6, 0.7], [0.7, 0.8]];
    const calibrationBands = bands.map(([lo, hi]) => {
      const sel = graded.filter(s => s.calibratedProbability >= lo && s.calibratedProbability < hi);
      return {
        range: `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`,
        signals: sel.length,
        predictedPct: sel.length ? round((100 * sel.reduce((a, s) => a + s.calibratedProbability, 0)) / sel.length, 1) : null,
        rawModelPct: sel.length ? round((100 * sel.reduce((a, s) => a + (s.modelProbability ?? s.calibratedProbability), 0)) / sel.length, 1) : null,
        actualPct: sel.length ? round((100 * sel.reduce((a, s) => a + hitValue(s.status), 0)) / sel.length, 1) : null
      };
    });

    // Calibración del modelo con TODOS los partidos (semilla + real), por competición y mercado
    const modelCalibration = calibration
      ? Object.fromEntries(['la_liga', 'champions_league'].flatMap(slug => ['1x2', 'over_under', 'btts'].map(g => [`${slug}_${g}`, calibration.table(slug, g)])))
      : null;

    // Casa de ejecución vs mercado promedio
    const withAvg = all.filter(s => s.avgMarketOdds > 1 && s.odds > 1);
    const execVsMarket = {
      sample: withAvg.length,
      avgExecutionOdds: withAvg.length ? round(withAvg.reduce((a, s) => a + s.odds, 0) / withAvg.length, 3) : null,
      avgMarketOdds: withAvg.length ? round(withAvg.reduce((a, s) => a + s.avgMarketOdds, 0) / withAvg.length, 3) : null,
      priceEdgePct: withAvg.length ? round((100 * withAvg.reduce((a, s) => a + (s.odds / s.avgMarketOdds - 1), 0)) / withAvg.length) : null,
      bookmakers: Object.entries(all.reduce((acc, s) => { if (s.bookmaker) acc[s.bookmaker] = (acc[s.bookmaker] || 0) + 1; return acc; }, {}))
        .map(([bookmaker, n]) => ({ bookmaker, signals: n })).sort((a, b) => b.signals - a.signals)
    };

    const minSample = 5;
    const ranked = byMarket.filter(m => m.resolved >= minSample);
    const clvList = all.filter(s => s.clv != null);

    return {
      days: d,
      mode,
      currency: bankroll.currency,
      bankroll: bankroll.bankroll,
      totals: {
        ...totals,
        pending: all.filter(s => s.status === 'pending').length,
        roiPct: bankroll.bankroll ? round((100 * profit) / bankroll.bankroll) : null,
        settledStaked: round(settledStaked),
        netProfit: round(profit)
      },
      // La métrica principal: ¿encontramos EV+ y lo tomamos antes de que el mercado corrija?
      keyMetric: {
        question: '¿MK Bets encuentra apuestas con EV positivo y las toma antes de que el mercado corrija la cuota?',
        signalsWithClv: clvList.length,
        beatClosingPct: clvList.length ? round((100 * clvList.filter(s => s.clv > 0).length) / clvList.length, 1) : null,
        avgClvPct: clvList.length ? round((100 * clvList.reduce((a, s) => a + s.clv, 0)) / clvList.length) : null,
        target: 'Acumular 300–500 señales reales antes de concluir si hay ventaja sostenida.',
        progressPct: round(Math.min(100, (100 * all.length) / 300), 1)
      },
      byCompetition,
      byMarket,
      // Mejores = mitad superior (máx. 3); peores = mitad inferior sin repetir
      bestMarkets: ranked.slice(0, Math.min(3, Math.ceil(ranked.length / 2))),
      worstMarkets: ranked.length >= 2 ? ranked.slice(Math.min(3, Math.ceil(ranked.length / 2))).slice(-3).reverse() : [],
      minSampleForRanking: minSample,
      calibrationBands,
      modelCalibration,
      execVsMarket,
      recent: all.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30)
    };
  }

  return { applyJornadaCap, recordFromAnalyses, scan, list, settle, captureClosing, performance };
}
