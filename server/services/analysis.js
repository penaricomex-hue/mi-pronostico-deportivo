/**
 * Orquestación: calendario + cuotas + modelo → análisis por partido.
 *
 * Solo LaLiga EA Sports (PD) y UEFA Champions League (CL). La recomendación
 * se calcula con el ValueBettingEngine contra la cuota real de Caliente MX.
 */
import { normalizeFdMatch } from '../providers/footballData.js';
import { ODDS_SPORT_BY_COMPETITION } from '../providers/oddsApi.js';
import { SUPPORTED_MODEL_LEAGUES, FD_HISTORY_LEAGUES } from '../providers/history.js';
import { ACTIVE_CODES, COMPETITION_NAMES, slugForCode, isActiveCompetition } from '../competitions.js';
import { priceSummary, kellyStake } from '../model/market.js';
import { matchProbabilities } from '../model/poisson.js';
import { predictMatch, evaluateSelections, pickBestValue, SELECTIONS } from '../model/predict.js';
import {
  FIXED_SELECTIONS, MARKET_LABELS, marketOf, selectionLabel, swapSelection, parseAh,
  modelFixedProbabilities, asianHandicapFromMatrix, marketConsensus, averageOdds
} from '../model/markets.js';
import { evaluateCandidate, DEFAULT_ENGINE_RULES, matchdayKey } from '../model/valueEngine.js';
import { CALIENTE } from './oddsStore.js';

export { COMPETITION_NAMES };
export const ALL_COMPETITIONS = ACTIVE_CODES;

const DAY_MS = 86400000;

/** Rango UTC del día local indicado. tzOffset = minutos (Date.getTimezoneOffset del cliente). */
export function localDayRange(date, tzOffsetMinutes = 0) {
  const start = new Date(`${date}T00:00:00Z`).getTime() + tzOffsetMinutes * 60000;
  return { start, end: start + DAY_MS };
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Evalúa todas las selecciones de un partido con el motor de valor.
 * Función pura: la usan producción, tests y el backtest.
 */
export function evaluateEngine({ matrix, competitionSlug, books, caliente = {}, calibration = null, rules = DEFAULT_ENGINE_RULES }) {
  const r = { ...DEFAULT_ENGINE_RULES, ...rules };
  const { probs: marketProbs, books: marketBooks } = marketConsensus(books);
  const fixed = matrix ? modelFixedProbabilities(matrix) : {};

  const sels = new Set();
  for (const m of r.enabledMarkets) for (const s of FIXED_SELECTIONS[m] || []) sels.add(s);
  if (r.enabledMarkets.includes('asian_handicap')) {
    for (const b of books) for (const s of Object.keys(b.prices || {})) if (parseAh(s)) sels.add(s);
    for (const s of Object.keys(caliente)) if (parseAh(s)) sels.add(s);
  }

  const out = [];
  for (const selection of sels) {
    const market = marketOf(selection);
    let raw = fixed[selection] ?? null;
    let stakeAtRisk = 1;
    const ah = parseAh(selection);
    if (ah && matrix) {
      const res = asianHandicapFromMatrix(matrix, ah.side, ah.line);
      raw = res.probability;
      stakeAtRisk = res.stakeAtRisk;
    }
    const explanation = calibration && raw != null ? calibration.explain(competitionSlug, market, raw) : null;
    const modelProbability = explanation ? explanation.calibrated : raw;
    const cal = caliente[selection]?.current || null;
    const calOdds = cal?.odds ?? null;
    const marketProbability = marketProbs[selection] ?? null;

    const res = evaluateCandidate({
      market,
      modelProbability,
      marketProbability,
      marketBooks: marketBooks[selection] ?? 0,
      calienteMxOdds: calOdds,
      stakeAtRisk
    }, r);

    const others = books.filter(b => b.bookmaker !== CALIENTE).map(b => b.prices?.[selection]).filter(o => o > 1);
    const avg = averageOdds(books, selection);
    const minCalienteOdds = modelProbability > 0 ? (r.minEv / stakeAtRisk + 1) / modelProbability : null;

    out.push({
      selection,
      market,
      marketLabel: MARKET_LABELS[market],
      label: selectionLabel(selection),
      modelRaw: raw,
      modelProbability,
      calibration: explanation,
      marketProbability,
      marketBooks: marketBooks[selection] ?? 0,
      marketAvgOdds: avg,
      bestOtherOdds: others.length ? Math.max(...others) : null,
      fairOdds: modelProbability > 0 ? 1 / modelProbability : null,
      minCalienteOdds: minCalienteOdds ? Math.max(minCalienteOdds, r.minOdds) : null,
      stakeAtRisk,
      caliente: caliente[selection] ? {
        odds: calOdds,
        capturedAt: cal?.capturedAt || null,
        source: cal?.source || null,
        opening: caliente[selection].opening?.odds ?? null,
        openingAt: caliente[selection].opening?.capturedAt ?? null,
        closing: caliente[selection].closing?.odds ?? null
      } : null,
      calienteVsMarketPct: calOdds && avg ? Number(((calOdds / avg - 1) * 100).toFixed(2)) : null,
      ev: res.ev,
      marketGap: res.marketGap,
      recommended: res.recommended,
      reason: res.reason,
      blockers: res.blockers
    });
  }

  const order = ['1x2', 'double_chance', 'over_under', 'btts', 'asian_handicap'];
  out.sort((a, b) => order.indexOf(a.market) - order.indexOf(b.market) || String(a.selection).localeCompare(String(b.selection)));
  return out;
}

export function createAnalysisService({
  footballData, odds, bigBalls, ratings, teams, store, bankroll, logger = console,
  matchesRepo = null, oddsStore = null, calibration = null, engineRules = DEFAULT_ENGINE_RULES
}) {
  /** Partidos de un día local (solo LaLiga y Champions). */
  async function getFixtures({ date, competition = null, tzOffset = 0 }) {
    const warnings = [];
    if (competition && !isActiveCompetition(competition)) {
      return { fixtures: [], warnings: ['Competición desactivada: MK Bets solo cubre LaLiga EA Sports y UEFA Champions League.'] };
    }
    const { start, end } = localDayRange(date, tzOffset);
    let fixtures = [];
    let needFallback = false;

    if (footballData.configured) {
      try {
        const raw = await footballData.getMatches({ dateFrom: utcDate(start), dateTo: utcDate(end), competition });
        fixtures = raw.map(normalizeFdMatch);
      } catch (err) {
        warnings.push(`football-data.org no respondió: ${err.message}`);
        needFallback = true;
      }
    } else {
      warnings.push('FOOTBALL_DATA_TOKEN no configurado: el calendario se obtiene de The Odds API.');
      needFallback = true;
    }

    // Respaldo con The Odds API solo si football-data.org no está disponible
    if (needFallback) {
      for (const c of competition ? [competition] : ACTIVE_CODES) {
        const { events, blockedReason } = await odds.getEvents(c);
        if (blockedReason) warnings.push(blockedReason);
        for (const e of events) {
          fixtures.push({
            id: `odds-${e.id}`, providerId: e.id, source: 'the-odds-api',
            competitionCode: c, competition: COMPETITION_NAMES[c], kickoff: e.kickoff, status: 'SCHEDULED',
            home: e.home, away: e.away, homeCrest: null, awayCrest: null, score: null, matchday: null, stage: null
          });
        }
      }
    }

    fixtures = fixtures
      .filter(f => f.home && f.away && f.kickoff && isActiveCompetition(f.competitionCode))
      .filter(f => { const t = new Date(f.kickoff).getTime(); return t >= start && t < end; })
      .filter(f => !competition || f.competitionCode === competition)
      .map(f => ({ ...f, competition: COMPETITION_NAMES[f.competitionCode] || f.competition, competitionSlug: slugForCode(f.competitionCode) }))
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff));

    if (matchesRepo) for (const f of fixtures) await matchesRepo.upsertFixture(f);
    return { fixtures, warnings };
  }

  async function findFixture({ id, date, competition, tzOffset, home, away }) {
    const { fixtures } = await getFixtures({ date, competition, tzOffset });
    if (id) return fixtures.find(f => f.id === id) || null;
    return fixtures.find(f => teams.sameTeam(f.home, home, f.competitionCode) && teams.sameTeam(f.away, away, f.competitionCode)) || null;
  }

  /** Cuotas de todas las casas de referencia (orientadas a local/visitante del calendario). */
  async function getMarket(fixture) {
    const comp = fixture.competitionCode;
    if (!ODDS_SPORT_BY_COMPETITION[comp]) return { available: false, reason: 'Competición sin cuotas', books: [] };
    const { events, fromCache, blockedReason } = await odds.getEvents(comp);
    if (!events.length) return { available: false, reason: blockedReason || 'Sin eventos de cuotas', books: [] };

    const match = teams.matchEvent({ home: fixture.home, away: fixture.away, kickoff: fixture.kickoff }, events, comp);
    if (!match) return { available: false, reason: 'Partido no encontrado en The Odds API', books: [] };

    let rawBooks = match.event.books;
    if (odds.eventMarketsEnabled && new Date(fixture.kickoff).getTime() - Date.now() < 2 * DAY_MS) {
      const extra = await odds.getEventMarkets(comp, match.event.id);
      if (extra?.books?.length) {
        const by = new Map(rawBooks.map(b => [b.bookmaker, { ...b, prices: { ...b.prices } }]));
        for (const b of extra.books) {
          if (!by.has(b.bookmaker)) by.set(b.bookmaker, { ...b, prices: {} });
          Object.assign(by.get(b.bookmaker).prices, b.prices);
        }
        rawBooks = [...by.values()];
      }
    }

    const books = rawBooks.map(b => {
      if (!match.reversed) return b;
      const p = {};
      for (const [k, v] of Object.entries(b.prices)) p[swapSelection(k)] = v;
      return { ...b, prices: p };
    });

    // Resumen legacy (1X2 + O/U) para vistas antiguas
    const prices = {};
    for (const sel of SELECTIONS) prices[sel] = priceSummary(books.filter(b => b.bookmaker !== CALIENTE).map(b => ({ bookmaker: b.title || b.bookmaker, odds: b.prices[sel] })));
    const { probs } = marketConsensus(books);
    const fair = probs.home != null || probs.over25 != null
      ? { home: probs.home ?? null, draw: probs.draw ?? null, away: probs.away ?? null, over25: probs.over25 ?? null, under25: probs.under25 ?? null }
      : null;

    return { available: true, eventId: match.event.id, reversed: match.reversed, fromCache, bookmakers: books.filter(b => b.bookmaker !== CALIENTE).length, books, prices, fair };
  }

  async function analyzeFixture(fixture, { withExtras = true, persist = true } = {}) {
    const comp = fixture.competitionCode;
    const slug = slugForCode(comp);
    const warnings = [];
    const leagueParams = ratings.leagueParams(comp);
    const hasModel = SUPPORTED_MODEL_LEAGUES.includes(comp);

    let ratingsModel = null;
    let canonical = { home: fixture.home, away: fixture.away };
    if (hasModel && FD_HISTORY_LEAGUES.includes(comp)) {
      // Champions: el historial usa los mismos nombres que el calendario (football-data.org)
      ratingsModel = await ratings.getRatings(comp);
      if (!ratingsModel) warnings.push('El modelo de la competición no está disponible en este momento.');
    } else if (hasModel) {
      const rh = teams.resolve(fixture.home, comp);
      const ra = teams.resolve(fixture.away, comp);
      if (!rh || !ra) {
        warnings.push(`No se pudo identificar ${!rh ? fixture.home : fixture.away} en la tabla de equipos; sin modelo propio para este partido.`);
      } else {
        canonical = { home: rh.canonical, away: ra.canonical };
        ratingsModel = await ratings.getRatings(comp);
        if (!ratingsModel) warnings.push('El modelo de la competición no está disponible en este momento.');
      }
    }

    const market = await getMarket(fixture);
    if (!market.available) warnings.push(`Cuotas: ${market.reason}.`);

    // Persistencia: partido + snapshot de cuotas + cuotas de Caliente guardadas
    let matchRow = null;
    let caliente = {};
    if (matchesRepo && persist) {
      matchRow = await matchesRepo.upsertFixture(fixture);
      if (matchRow && oddsStore) {
        if (market.available) {
          await matchesRepo.setOddsEvent(matchRow.id, market.eventId);
          if (new Date(fixture.kickoff).getTime() > Date.now()) await oddsStore.recordBooks(matchRow.id, market.books, { source: 'api' });
        }
        caliente = await oddsStore.calienteOdds(matchRow.id);
      }
    }
    // Si The Odds API llegara a traer Caliente, también cuenta
    const apiCaliente = market.books?.find(b => b.bookmaker === CALIENTE);
    if (apiCaliente) {
      for (const [s, o] of Object.entries(apiCaliente.prices)) {
        if (!caliente[s]) caliente[s] = { selection: s, current: { odds: o, capturedAt: new Date().toISOString(), source: 'api' }, opening: null, closing: null };
      }
    }

    const prediction = predictMatch({
      ratings: ratingsModel, home: canonical.home, away: canonical.away,
      market: market.available ? market.fair : null, params: leagueParams
    });
    warnings.push(...prediction.warnings.filter(w => !warnings.includes(w)));

    const matrix = prediction.xg ? matchProbabilities(prediction.xg.home, prediction.xg.away, prediction.xg.rho).matrix : null;
    const engine = evaluateEngine({ matrix, competitionSlug: slug, books: market.books || [], caliente, calibration, rules: engineRules });
    for (const e of engine) {
      e.suggestedStake = e.recommended
        ? kellyStake({ probability: e.modelProbability, odds: e.caliente.odds, bankroll: bankroll.bankroll, fraction: bankroll.kellyFraction, maxPct: bankroll.maxStakePct })
        : 0;
      e.flatStake = bankroll.flatStake;
    }
    if (!Object.keys(caliente).length) warnings.push('Sin cuotas de Caliente MX para este partido: captura la cuota para evaluar si es jugable.');

    // Legacy (vista de combinadas)
    const selections = market.available
      ? evaluateSelections(prediction, market.prices, { valueEnabled: false })
      : [];
    for (const s of selections) { s.suggestedStake = 0; s.flatStake = bankroll.flatStake; }

    let secondOpinion = null;
    let injuries = null;
    if (withExtras && bigBalls.configured) {
      try {
        [secondOpinion, injuries] = await Promise.all([
          bigBalls.secondOpinion(fixture.home, fixture.away, comp),
          Promise.all([bigBalls.injuries(fixture.home, comp), bigBalls.injuries(fixture.away, comp)]).then(([h, a]) => ({ home: h, away: a }))
        ]);
      } catch (err) {
        warnings.push(`Big Balls no disponible: ${err.message}`);
      }
    }

    return {
      ...fixture,
      competitionSlug: slug,
      matchId: matchRow?.id ?? null,
      matchdayKey: matchdayKey({ competitionSlug: slug, matchday: fixture.matchday, stage: fixture.stage, kickoff: fixture.kickoff }),
      canonical,
      modelAvailable: prediction.modelAvailable,
      dataQuality: prediction.dataQuality,
      xg: prediction.xg,
      sample: prediction.sample,
      mostLikelyScore: prediction.model?.mostLikelyScore || null,
      probabilities: { model: prediction.model, market: prediction.market, final: prediction.final },
      weights: prediction.weights,
      league: {
        code: comp,
        slug,
        hasModel,
        valueEnabled: false,
        testClvPct: leagueParams.testClvPct ?? null,
        testRoiPct: leagueParams.testRoiPct ?? null,
        testBets: leagueParams.testBets ?? null
      },
      odds: {
        available: market.available,
        bookmakers: market.bookmakers || 0,
        fromCache: market.fromCache || false,
        eventId: market.eventId || null,
        books: (market.books || []).filter(b => b.bookmaker !== CALIENTE).map(b => b.title || b.bookmaker)
      },
      engine,
      engineRules,
      recommended: engine.filter(e => e.recommended).sort((a, b) => b.ev - a.ev),
      selections,
      bestValue: pickBestValue(selections),
      secondOpinion,
      injuries,
      currency: bankroll.currency,
      warnings
    };
  }

  /** Analiza los partidos de varios días. */
  async function analyzeRange({ fromDate, days = 3, competition = null, tzOffset = 0 }) {
    const warnings = [];
    const analyses = [];
    const seen = new Set();
    for (let i = 0; i < days; i++) {
      const date = utcDate(new Date(`${fromDate}T00:00:00Z`).getTime() + i * DAY_MS);
      const { fixtures, warnings: w } = await getFixtures({ date, competition, tzOffset });
      warnings.push(...w);
      for (const f of fixtures) {
        if (seen.has(f.id) || ['FINISHED', 'IN_PLAY', 'PAUSED'].includes(f.status)) continue;
        if (new Date(f.kickoff).getTime() < Date.now()) continue;
        seen.add(f.id);
        try {
          analyses.push(await analyzeFixture(f, { withExtras: false }));
        } catch (err) {
          logger.error(`[analysis] ${f.home} - ${f.away}: ${err.message}`);
          warnings.push(`Error analizando ${f.home} - ${f.away}`);
        }
      }
    }
    return { analyses, warnings: [...new Set(warnings)] };
  }

  return { getFixtures, findFixture, analyzeFixture, analyzeRange, getMarket };
}
