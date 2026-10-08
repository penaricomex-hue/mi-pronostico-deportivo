/**
 * Orquestación: calendario + cuotas + modelo → análisis por partido.
 */
import { normalizeFdMatch } from '../providers/footballData.js';
import { ODDS_SPORT_BY_COMPETITION } from '../providers/oddsApi.js';
import { SUPPORTED_MODEL_LEAGUES } from '../providers/history.js';
import { consensus, priceSummary, kellyStake } from '../model/market.js';
import { predictMatch, evaluateSelections, pickBestValue, SELECTIONS } from '../model/predict.js';

export const COMPETITION_NAMES = {
  PL: 'Premier League',
  PD: 'LaLiga',
  SA: 'Serie A',
  BL1: 'Bundesliga',
  FL1: 'Ligue 1',
  CL: 'Champions League',
  EL: 'Europa League'
};

export const ALL_COMPETITIONS = Object.keys(COMPETITION_NAMES);

const DAY_MS = 86400000;

/** Rango UTC del día local indicado. tzOffset = minutos (Date.getTimezoneOffset del cliente). */
export function localDayRange(date, tzOffsetMinutes = 0) {
  const start = new Date(`${date}T00:00:00Z`).getTime() + tzOffsetMinutes * 60000;
  return { start, end: start + DAY_MS };
}

function utcDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function createAnalysisService({ footballData, odds, bigBalls, ratings, teams, store, bankroll, logger = console }) {
  /** Partidos de un día local. */
  async function getFixtures({ date, competition = null, tzOffset = 0 }) {
    const warnings = [];
    const { start, end } = localDayRange(date, tzOffset);
    let fixtures = [];

    const fdComps = competition ? (competition === 'EL' ? [] : [competition]) : null;
    if (footballData.configured && (fdComps === null || fdComps.length)) {
      try {
        const raw = await footballData.getMatches({
          dateFrom: utcDate(start),
          dateTo: utcDate(end - 1),
          competition: fdComps ? fdComps[0] : null
        });
        fixtures = raw.map(normalizeFdMatch);
      } catch (err) {
        warnings.push(`football-data.org no respondió: ${err.message}`);
      }
    } else if (!footballData.configured) {
      warnings.push('FOOTBALL_DATA_TOKEN no configurado: el calendario se obtiene de The Odds API.');
    }

    // Europa League (no está en el plan gratuito) o respaldo si no hubo calendario
    const oddsComps = competition === 'EL' ? ['EL']
      : (!fixtures.length && competition ? [competition] : []);
    for (const c of oddsComps) {
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

    fixtures = fixtures
      .filter(f => f.home && f.away && f.kickoff)
      .filter(f => { const t = new Date(f.kickoff).getTime(); return t >= start && t < end; })
      .filter(f => !competition || f.competitionCode === competition)
      .map(f => ({ ...f, competition: COMPETITION_NAMES[f.competitionCode] || f.competition }))
      .sort((a, b) => a.kickoff.localeCompare(b.kickoff));

    return { fixtures, warnings };
  }

  async function findFixture({ id, date, competition, tzOffset, home, away }) {
    const { fixtures } = await getFixtures({ date, competition, tzOffset });
    if (id) return fixtures.find(f => f.id === id) || null;
    return fixtures.find(f => teams.sameTeam(f.home, home, f.competitionCode) && teams.sameTeam(f.away, away, f.competitionCode)) || null;
  }

  /** Precios y consenso de mercado del partido. */
  async function getMarket(fixture) {
    const comp = fixture.competitionCode;
    if (!ODDS_SPORT_BY_COMPETITION[comp]) return { available: false, reason: 'Competición sin cuotas' };
    const { events, fromCache, blockedReason } = await odds.getEvents(comp);
    if (!events.length) return { available: false, reason: blockedReason || 'Sin eventos de cuotas' };

    const match = teams.matchEvent({ home: fixture.home, away: fixture.away, kickoff: fixture.kickoff }, events, comp);
    if (!match) return { available: false, reason: 'Partido no encontrado en The Odds API' };

    const swap = { home: 'away', away: 'home', draw: 'draw', over25: 'over25', under25: 'under25' };
    const books = match.event.books.map(b => {
      if (!match.reversed) return b;
      const p = {};
      for (const [k, v] of Object.entries(b.prices)) p[swap[k]] = v;
      return { ...b, prices: p };
    });

    const prices = {};
    for (const sel of SELECTIONS) {
      prices[sel] = priceSummary(books.map(b => ({ bookmaker: b.bookmaker, odds: b.prices[sel] })));
    }
    const c1 = consensus(books, ['home', 'draw', 'away']);
    const c2 = consensus(books, ['over25', 'under25']);
    const fair = c1 || c2 ? {
      home: c1?.probs.home ?? null, draw: c1?.probs.draw ?? null, away: c1?.probs.away ?? null,
      over25: c2?.probs.over25 ?? null, under25: c2?.probs.under25 ?? null
    } : null;

    return {
      available: true,
      eventId: match.event.id,
      reversed: match.reversed,
      fromCache,
      bookmakers: books.length,
      prices,
      fair
    };
  }

  async function analyzeFixture(fixture, { withExtras = true } = {}) {
    const comp = fixture.competitionCode;
    const warnings = [];
    const leagueParams = ratings.leagueParams(comp);
    const hasModel = SUPPORTED_MODEL_LEAGUES.includes(comp);

    let ratingsModel = null;
    let canonical = { home: fixture.home, away: fixture.away };
    if (hasModel) {
      const rh = teams.resolve(fixture.home, comp);
      const ra = teams.resolve(fixture.away, comp);
      if (!rh || !ra) {
        warnings.push(`No se pudo identificar ${!rh ? fixture.home : fixture.away} en la tabla de equipos; sin modelo propio para este partido.`);
      } else {
        canonical = { home: rh.canonical, away: ra.canonical };
        ratingsModel = await ratings.getRatings(comp);
        if (!ratingsModel) warnings.push('El modelo de la liga no está disponible en este momento.');
      }
    }

    const market = await getMarket(fixture);
    if (!market.available) warnings.push(`Cuotas: ${market.reason}.`);

    const prediction = predictMatch({
      ratings: ratingsModel,
      home: canonical.home,
      away: canonical.away,
      market: market.available ? market.fair : null,
      params: leagueParams
    });
    warnings.push(...prediction.warnings.filter(w => !warnings.includes(w)));

    const selections = market.available
      ? evaluateSelections(prediction, market.prices, { valueEnabled: Boolean(leagueParams.valueEnabled && hasModel) })
      : [];

    for (const s of selections) {
      s.suggestedStake = s.isValue
        ? kellyStake({ probability: s.probability, odds: s.bestOdds, bankroll: bankroll.bankroll, fraction: bankroll.kellyFraction, maxPct: bankroll.maxStakePct })
        : 0;
      s.flatStake = bankroll.flatStake;
    }

    let secondOpinion = null;
    let injuries = null;
    if (withExtras && bigBalls.configured) {
      try {
        [secondOpinion, injuries] = await Promise.all([
          bigBalls.secondOpinion(fixture.home, fixture.away, comp),
          Promise.all([bigBalls.injuries(fixture.home, comp), bigBalls.injuries(fixture.away, comp)])
            .then(([h, a]) => ({ home: h, away: a }))
        ]);
      } catch (err) {
        warnings.push(`Big Balls no disponible: ${err.message}`);
      }
    }

    return {
      ...fixture,
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
        hasModel,
        valueEnabled: Boolean(leagueParams.valueEnabled && hasModel),
        testClvPct: leagueParams.testClvPct ?? null,
        testRoiPct: leagueParams.testRoiPct ?? null,
        testBets: leagueParams.testBets ?? null
      },
      odds: {
        available: market.available,
        bookmakers: market.bookmakers || 0,
        fromCache: market.fromCache || false,
        eventId: market.eventId || null
      },
      selections,
      bestValue: pickBestValue(selections),
      secondOpinion,
      injuries,
      currency: bankroll.currency,
      warnings
    };
  }

  /** Analiza los partidos de varios días (para valor y parlays). */
  async function analyzeRange({ fromDate, days = 3, competition = null, tzOffset = 0 }) {
    const comps = competition ? [competition] : ALL_COMPETITIONS.filter(c => c !== 'EL');
    const warnings = [];
    const analyses = [];
    const seen = new Set();
    for (let i = 0; i < days; i++) {
      const date = utcDate(new Date(`${fromDate}T00:00:00Z`).getTime() + i * DAY_MS);
      for (const c of competition ? comps : [null]) {
        const { fixtures, warnings: w } = await getFixtures({ date, competition: c, tzOffset });
        warnings.push(...w);
        for (const f of fixtures) {
          if (seen.has(f.id) || f.status === 'FINISHED' || f.status === 'IN_PLAY' || f.status === 'PAUSED') continue;
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
    }
    return { analyses, warnings: [...new Set(warnings)] };
  }

  return { getFixtures, findFixture, analyzeFixture, analyzeRange, getMarket };
}
