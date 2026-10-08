/**
 * Orquestación v10: calendario + cuotas + modelo calibrado → ValueBettingEngine.
 *
 * Solo LaLiga EA Sports (PD) y UEFA Champions League (CL). Cualquier otra
 * competición se rechaza en ingesta, API y recomendaciones.
 */
import { normalizeFdMatch } from '../providers/footballData.js';
import { mergeBooks } from '../providers/oddsApi.js';
import { expectedGoals } from '../model/dixonColes.js';
import { matchProbabilities } from '../model/poisson.js';
import { kellyStake } from '../model/market.js';
import { buildMarketBook } from '../model/marketBook.js';
import { MARKETS, SELECTION_MARKET, FIXED_SELECTIONS, selectionLabel, ahSelectionProbability, expandProbabilities } from '../model/markets.js';
import { createValueBettingEngine } from '../model/valueEngine.js';
import { blendProbabilities, poolBinary, createBlendResolver, weightGroupFor } from '../model/blend.js';
import { ACTIVE_CODES, COMPETITION_NAMES, isActiveCompetition, slugForCode, jornadaKey } from '../competitions.js';

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

function dataQuality(homeSample, awaySample) {
  const n = Math.min(homeSample ?? 0, awaySample ?? 0);
  if (n >= 15) return 'alta';
  if (n >= 7) return 'media';
  return 'baja';
}

export function createAnalysisService({
  footballData, odds, bigBalls, ratings, teams, store, bankroll, calibration, ingest = null,
  executionBookmaker = '', valueRules = {}, blend = null, logger = console
}) {
  const engine = createValueBettingEngine(valueRules);
  const blender = blend?.weightsFor ? blend : createBlendResolver(blend || {});

  function blendInfo(weights, sel, calibratedP, blendedP, marketP) {
    const w = weights[weightGroupFor(sel)];
    if (blendedP == null || calibratedP == null) return null;
    const pct = x => `${(100 * x).toFixed(1)}%`;
    return {
      modelWeight: w,
      probability: blendedP,
      message: `Mezcla modelo ${Math.round(w * 100)}% + mercado ${Math.round((1 - w) * 100)}%: modelo calibrado ${pct(calibratedP)}, mercado ${marketP != null ? pct(marketP) : '—'} → probabilidad de decisión ${pct(blendedP)}.`
    };
  }

  /** Partidos de un día local (solo competiciones activas). */
  async function getFixtures({ date, competition = null, tzOffset = 0 }) {
    const warnings = [];
    if (competition && !isActiveCompetition(competition)) {
      return { fixtures: [], warnings: ['Competición desactivada: MK Bets v10 solo analiza LaLiga y Champions.'] };
    }
    const { start, end } = localDayRange(date, tzOffset);
    let fixtures = [];
    let calendarOk = false;

    if (footballData.configured) {
      try {
        const raw = await footballData.getMatches({ dateFrom: utcDate(start), dateTo: utcDate(end - 1), competition });
        fixtures = raw.map(normalizeFdMatch);
        calendarOk = true;
      } catch (err) {
        warnings.push(`football-data.org no respondió: ${err.message}`);
      }
    } else {
      warnings.push('FOOTBALL_DATA_TOKEN no configurado: el calendario se obtiene de The Odds API.');
    }

    // Respaldo: calendario desde The Odds API solo si football-data.org no está
    // configurado o falló. Un día sin partidos (p. ej. parón FIFA) no gasta créditos.
    if (!calendarOk && !fixtures.length) {
      for (const c of competition ? [competition] : ACTIVE_CODES) {
        const { events, blockedReason } = await odds.getEvents(c);
        if (blockedReason) warnings.push(blockedReason);
        for (const e of events) {
          fixtures.push({
            id: `odds-${e.id}`, providerId: e.id, source: 'the-odds-api',
            competitionCode: c, competition: COMPETITION_NAMES[c], kickoff: e.kickoff, status: 'SCHEDULED',
            home: e.home, away: e.away, homeCrest: null, awayCrest: null, score: null
          });
        }
      }
    }

    fixtures = fixtures
      .filter(f => f.home && f.away && f.kickoff && isActiveCompetition(f.competitionCode))
      .filter(f => { const t = new Date(f.kickoff).getTime(); return t >= start && t < end; })
      .filter(f => !competition || f.competitionCode === competition)
      .map(f => ({ ...f, competition: COMPETITION_NAMES[f.competitionCode], competitionSlug: slugForCode(f.competitionCode) }))
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff));

    return { fixtures, warnings };
  }

  async function findFixture({ id, date, competition, tzOffset, home, away }) {
    const { fixtures } = await getFixtures({ date, competition, tzOffset });
    if (id) return fixtures.find(f => f.id === id) || null;
    return fixtures.find(f => teams.sameTeam(f.home, home, f.competitionCode) && teams.sameTeam(f.away, away, f.competitionCode)) || null;
  }

  /** Cuotas de todas las casas para el partido + libro de mercado. */
  async function getMarket(fixture, { maxAgeMinutes = null, withExtras = true, closing = false } = {}) {
    const comp = fixture.competitionCode;
    if (!isActiveCompetition(comp)) return { available: false, reason: 'Competición desactivada' };
    const { events, fromCache, capturedAt, blockedReason } = await odds.getEvents(comp, { maxAgeMinutes, closing });
    if (!events.length) return { available: false, reason: blockedReason || 'Sin eventos de cuotas' };

    const match = teams.matchEvent({ home: fixture.home, away: fixture.away, kickoff: fixture.kickoff }, events, comp);
    if (!match) return { available: false, reason: 'Partido no encontrado en The Odds API' };

    let books = match.event.books;
    let extrasCapturedAt = null;
    if (withExtras && odds.getEventExtras) {
      const extras = await odds.getEventExtras(comp, match.event);
      if (extras?.books?.length) { books = mergeBooks(books, extras.books); extrasCapturedAt = extras.capturedAt; }
    }

    if (match.reversed) {
      const swap = { home: 'away', away: 'home', dc_1x: 'dc_x2', dc_x2: 'dc_1x' };
      books = books.map(b => {
        const p = {};
        for (const [k, v] of Object.entries(b.prices || {})) p[swap[k] || k] = v;
        const ah = {};
        for (const [line, v] of Object.entries(b.ah || {})) ah[String(-Number(line))] = { home: v.away, away: v.home };
        return { ...b, prices: p, ah };
      });
    }

    const book = buildMarketBook(books, { executionBookmaker });
    return {
      available: true,
      eventId: match.event.id,
      reversed: match.reversed,
      fromCache,
      capturedAt: capturedAt || null,
      extrasCapturedAt,
      bookmakers: books.length,
      books,
      ...book
    };
  }

  /** Probabilidades del modelo (originales) + matriz para el hándicap. */
  async function modelFor(fixture) {
    const comp = fixture.competitionCode;
    const warnings = [];
    const rh = teams.resolve(fixture.home, comp);
    const ra = teams.resolve(fixture.away, comp);
    if (!rh || !ra) {
      warnings.push(`No se pudo identificar ${!rh ? fixture.home : fixture.away} en la tabla de equipos; sin modelo propio para este partido.`);
      return { model: null, canonical: { home: fixture.home, away: fixture.away }, warnings };
    }
    const canonical = { home: rh.canonical, away: ra.canonical };
    const r = await ratings.getRatings(comp);
    if (!r) {
      warnings.push('El modelo de la competición no está disponible en este momento.');
      return { model: null, canonical, warnings };
    }
    const xg = expectedGoals(r, canonical.home, canonical.away);
    warnings.push(...xg.warnings);
    const p = matchProbabilities(xg.lambda, xg.mu, xg.rho);
    return {
      canonical,
      warnings,
      xg: { home: xg.lambda, away: xg.mu, rho: xg.rho },
      sample: { home: xg.homeSample, away: xg.awaySample },
      dataQuality: dataQuality(xg.homeSample, xg.awaySample),
      matrix: p.matrix,
      mostLikelyScore: p.mostLikelyScore,
      model: { home: p.home, draw: p.draw, away: p.away, over25: p.over25, under25: p.under25, btts_yes: p.btts, btts_no: 1 - p.btts }
    };
  }

  /** Aplica la calibración por competición y mercado. */
  function calibrated(slug, model) {
    if (!model) return null;
    const c1 = calibration.calibrate(slug, '1x2', { home: model.home, draw: model.draw, away: model.away });
    const c2 = calibration.calibrate(slug, 'over_under', { over25: model.over25, under25: model.under25 });
    const c3 = calibration.calibrate(slug, 'btts', { btts_yes: model.btts_yes, btts_no: model.btts_no });
    return expandProbabilities({ ...c1, ...c2, ...c3 });
  }

  function groupFor(sel) {
    return MARKETS[SELECTION_MARKET[sel]]?.calibrationGroup || null;
  }

  async function analyzeFixture(fixture, { withExtras = true, persist = true, withInfo = true } = {}) {
    const comp = fixture.competitionCode;
    if (!isActiveCompetition(comp)) {
      const err = new Error('Competición desactivada: MK Bets v10 solo analiza LaLiga y Champions.');
      err.status = 400;
      throw err;
    }
    const slug = slugForCode(comp);
    const warnings = [];

    const m = await modelFor(fixture);
    warnings.push(...m.warnings);
    const rawModel = m.model ? expandProbabilities(m.model) : null;
    const cal = calibrated(slug, m.model);

    const market = await getMarket(fixture, { withExtras });
    if (!market.available) warnings.push(`Cuotas: ${market.reason}.`);
    if (!rawModel) warnings.push('Sin modelo propio: no se generan recomendaciones para este partido.');

    const jk = jornadaKey(slug, fixture.kickoff);
    const names = { home: fixture.home, away: fixture.away };
    const selections = [];
    const weights = blender.weightsFor(slug);
    const blended = market.available && cal ? blendProbabilities(cal, market.fair, weights) : null;

    if (market.available) {
      for (const sel of FIXED_SELECTIONS) {
        const pr = market.prices[sel];
        if (!pr) continue;
        const raw = rawModel?.[sel] ?? null;
        const p = cal?.[sel] ?? null;
        const pb = blended?.[sel] ?? null;
        const pDecision = pb ?? p;
        const group = groupFor(sel);
        const ev = engine.evaluate({
          selection: sel,
          modelProbability: p,
          decisionProbability: pb,
          marketProbability: market.fair[sel] ?? null,
          executionOdds: pr.odds,
          bookmakerCount: pr.fairCount,
          modelAvailable: Boolean(rawModel)
        });
        const explain = group && raw != null && !sel.startsWith('dc_') ? calibration.explain(slug, group, raw, p) : null;
        selections.push({
          selection: sel,
          market: SELECTION_MARKET[sel],
          line: sel.startsWith('over') || sel.startsWith('under') ? 2.5 : 0,
          label: selectionLabel(sel, null, names),
          modelProbability: raw,
          calibratedProbability: p,
          blendedProbability: pb,
          probability: pDecision,
          marketProbability: market.fair[sel] ?? null,
          fairOdds: pDecision > 0 ? 1 / pDecision : null,
          blend: blendInfo(weights, sel, p, pb, market.fair[sel] ?? null),
          executionOdds: pr.odds,
          executionBookmaker: pr.bookmaker,
          avgMarketOdds: pr.median,
          bookmakerCount: pr.fairCount,
          calibration: explain,
          jornadaKey: jk,
          ...ev
        });
      }

      if (market.ah && m.matrix) {
        for (const sel of ['ah_home', 'ah_away']) {
          const pr = market.ah.prices[sel];
          if (!pr) continue;
          const r = ahSelectionProbability(m.matrix, sel, market.ah.line);
          const pMkt = market.ah.fair?.[sel] ?? null;
          const pb = poolBinary(r.probability, pMkt, weights['1x2']);
          const pDecision = pb ?? r.probability;
          const ev = engine.evaluate({
            selection: sel,
            modelProbability: r.probability,
            decisionProbability: pb,
            marketProbability: pMkt,
            executionOdds: pr.odds,
            bookmakerCount: pr.fairCount,
            pushProbability: r.push,
            modelAvailable: Boolean(rawModel)
          });
          selections.push({
            selection: sel,
            market: 'asian_handicap',
            line: market.ah.line,
            label: selectionLabel(sel, market.ah.line, names),
            modelProbability: r.probability,
            calibratedProbability: r.probability,
            blendedProbability: pb,
            probability: pDecision,
            pushProbability: r.push,
            marketProbability: pMkt,
            fairOdds: pDecision > 0 ? 1 / pDecision : null,
            blend: blendInfo(weights, sel, r.probability, pb, pMkt),
            executionOdds: pr.odds,
            executionBookmaker: pr.bookmaker,
            avgMarketOdds: pr.median,
            bookmakerCount: pr.fairCount,
            calibration: { message: 'Hándicap asiático: sin mapa de calibración propio todavía (se usa la probabilidad del modelo sin push).', method: 'identity' },
            jornadaKey: jk,
            ...ev
          });
        }
      }
    }

    for (const s of selections) {
      s.flatStake = bankroll.flatStake;
      s.suggestedStake = s.recommended
        ? kellyStake({ probability: s.probability, odds: s.executionOdds, bankroll: bankroll.bankroll, fraction: bankroll.kellyFraction, maxPct: bankroll.maxStakePct })
        : 0;
    }

    // Persistencia de la ingesta (no bloquea la respuesta si falla)
    let matchId = null;
    if (persist && ingest) {
      try {
        matchId = await ingest.upsertMatch({ ...fixture, oddsEventId: market.eventId || null });
        if (matchId && market.available) {
          await ingest.saveOddsSnapshot(matchId, market.books, { capturedAt: market.capturedAt, mainLine: market.ah?.line ?? null });
        }
        if (matchId && rawModel) {
          const preds = ['home', 'draw', 'away', 'over25', 'under25', 'btts_yes', 'btts_no'].map(sel => ({
            market: SELECTION_MARKET[sel], selection: sel, line: sel.startsWith('over') || sel.startsWith('under') ? 2.5 : 0,
            modelProbability: rawModel[sel], calibratedProbability: cal?.[sel] ?? null, marketProbability: market.available ? market.fair?.[sel] ?? null : null
          }));
          await ingest.savePredictions(matchId, comp, fixture.kickoff, preds);
        }
      } catch (err) {
        logger.warn(`[ingest] ${fixture.home} - ${fixture.away}: ${err.message}`);
      }
    }

    let secondOpinion = null;
    let injuries = null;
    if (withExtras && withInfo && bigBalls?.configured) {
      try {
        [secondOpinion, injuries] = await Promise.all([
          bigBalls.secondOpinion(fixture.home, fixture.away, comp),
          Promise.all([bigBalls.injuries(fixture.home, comp), bigBalls.injuries(fixture.away, comp)]).then(([h, a]) => ({ home: h, away: a }))
        ]);
      } catch (err) {
        warnings.push(`Big Balls no disponible: ${err.message}`);
      }
    }

    const best = selections.filter(s => s.recommended).sort((a, b) => b.ev - a.ev)[0] || null;

    return {
      ...fixture,
      matchId,
      competitionSlug: slug,
      jornadaKey: jk,
      canonical: m.canonical,
      modelAvailable: Boolean(rawModel),
      dataQuality: m.dataQuality || null,
      xg: m.xg || null,
      sample: m.sample || null,
      mostLikelyScore: m.mostLikelyScore || null,
      probabilities: { model: rawModel, calibrated: cal, market: market.available ? market.fair : null, final: cal },
      league: { code: comp, slug, hasModel: true, ...ratings.leagueParams(comp) },
      odds: {
        available: market.available,
        bookmakers: market.bookmakers || 0,
        fromCache: market.fromCache || false,
        eventId: market.eventId || null,
        capturedAt: market.capturedAt || null,
        executionMode: market.executionMode || (executionBookmaker ? 'fixed' : 'best'),
        executionBookmaker: executionBookmaker || null,
        asianHandicapLine: market.ah?.line ?? null
      },
      selections,
      bestValue: best,
      secondOpinion,
      injuries,
      currency: bankroll.currency,
      warnings: [...new Set(warnings)]
    };
  }

  /** Analiza los partidos de varios días (para valor y señales). */
  async function analyzeRange({ fromDate, days = 3, competition = null, tzOffset = 0, persist = true, withInfo = true }) {
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
          analyses.push(await analyzeFixture(f, { withExtras: true, persist, withInfo }));
        } catch (err) {
          logger.error(`[analysis] ${f.home} - ${f.away}: ${err.message}`);
          warnings.push(`Error analizando ${f.home} - ${f.away}`);
        }
      }
    }
    return { analyses, warnings: [...new Set(warnings)] };
  }

  return { blender, getFixtures, findFixture, analyzeFixture, analyzeRange, getMarket, engine };
}
