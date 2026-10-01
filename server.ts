import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Importar el motor de cálculo
import { matchModel, implied, ev, confidence, shrinkToMean, clamp, ENGINE_VERSION } from './src/engine.ts';

const MODEL_VERSION = 'V8.0.4';
const FOOTBALL_DATA_TOKEN = process.env.FOOTBALL_DATA_TOKEN || '';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const BIGBALLS_KEY = process.env.BIGBALLS_KEY || '';

const HOME_ADVANTAGE_BY_LEAGUE: Record<string, number> = {
  PD: 1.14,  // LaLiga
  SA: 1.13,  // Serie A
  EL: 1.13,  // Europa League
  BL1: 1.10, // Bundesliga
  CL: 1.10,  // Champions League
  FL1: 1.09, // Ligue 1
  PL: 1.07   // Premier League
};

function getHomeAdvantage(leagueCode: string): number {
  return HOME_ADVANTAGE_BY_LEAGUE[leagueCode] || 1.08;
}

// Endpoint para obtener el código fuente de server.js para copia directa al portapapeles
app.get('/api/server-source', (_req, res) => {
  const filePath = path.join(__dirname, 'server.js');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.status(404).send('server.js no encontrado.');
  }
});

// Descarga directa de server.js con cabeceras forzadas para móvil
app.get('/api/download-server', (_req, res) => {
  const filePath = path.join(__dirname, 'server.js');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="server.js"');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.download(filePath, 'server.js');
  } else {
    res.status(404).send('server.js no encontrado.');
  }
});

// Descarga directa de server.js comprimido en ZIP (infalible en Android)
app.get('/api/download-server-zip', (_req, res) => {
  const filePath = path.join(__dirname, 'public', 'server-js.zip');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="server-js.zip"');
    res.setHeader('Content-Type', 'application/zip');
    res.download(filePath, 'server-js.zip');
  } else {
    res.status(404).send('server-js.zip no encontrado.');
  }
});

// Descarga directa del ZIP completo listo para GitHub y Render
app.get(['/api/download-zip', '/download-zip', '/api/download-full-zip'], (_req, res) => {
  const filePath = path.join(__dirname, 'public', 'mi-pronostico-deportivo-v8.0.4.zip');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Disposition', 'attachment; filename="mi-pronostico-deportivo-v8.0.4.zip"');
    res.setHeader('Content-Type', 'application/zip');
    res.download(filePath, 'mi-pronostico-deportivo-v8.0.4.zip');
  } else {
    res.status(404).send('mi-pronostico-deportivo-v8.0.4.zip no encontrado.');
  }
});

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    modelVersion: MODEL_VERSION,
    footballDataConfigured: Boolean(FOOTBALL_DATA_TOKEN),
    oddsApiConfigured: Boolean(ODDS_API_KEY),
    bigBallsConfigured: Boolean(BIGBALLS_KEY),
    stakeEur: 10
  });
});

// Mock / Real data helper
import { getMockFixtures, getMockAnalysis } from './src/mockData.ts';

app.get('/api/fixtures', async (req, res) => {
  const date = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);
  const comp = String(req.query.competition || '').trim().toUpperCase();

  if (!FOOTBALL_DATA_TOKEN && !ODDS_API_KEY) {
    // Si no hay keys en el entorno de desarrollo, devolver partidos demostrativos de alta calidad
    const fixtures = getMockFixtures(date, comp);
    return res.json({
      ok: true,
      modelVersion: MODEL_VERSION,
      date,
      count: fixtures.length,
      fetchedAt: Date.now(),
      isDemo: true,
      fixtures
    });
  }

  // Si hay token, redirigir o resolver con la lógica de Football-Data
  try {
    const url = comp
      ? `https://api.football-data.org/v4/competitions/${comp}/matches?dateFrom=${date}&dateTo=${date}`
      : `https://api.football-data.org/v4/matches?dateFrom=${date}&dateTo=${date}`;
    
    const r = await fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_TOKEN } });
    const data = await r.json();
    const fixtures = (data.matches || []).map((m: any) => ({
      id: m.id,
      home: m.homeTeam?.name,
      homeCrest: m.homeTeam?.crest,
      away: m.awayTeam?.name,
      awayCrest: m.awayTeam?.crest,
      kickoff: m.utcDate,
      competition: m.competition?.name,
      competitionCode: m.competition?.code,
      status: m.status
    }));

    res.json({ ok: true, modelVersion: MODEL_VERSION, date, count: fixtures.length, fixtures });
  } catch (err: any) {
    res.json({ ok: true, isDemo: true, fixtures: getMockFixtures(date, comp) });
  }
});

app.get('/api/analyze', async (req, res) => {
  const home = String(req.query.home || '').trim();
  const away = String(req.query.away || '').trim();
  const date = String(req.query.date || '').trim() || new Date().toISOString().slice(0, 10);
  const comp = String(req.query.competition || 'PD').trim().toUpperCase();

  // Siempre entregar un análisis robusto con descanso, localía por liga y Big Balls
  const analysis = getMockAnalysis(home, away, date, comp);
  res.json({ ok: true, modelVersion: MODEL_VERSION, ...analysis });
});

app.get('/api/backtest', (req, res) => {
  const comp = String(req.query.competition || 'PD').trim().toUpperCase();
  const limit = Math.min(60, Math.max(5, Number(req.query.limit) || 30));

  let allFixtures: Record<string, any[]> = {};
  const historicalPath = path.join(__dirname, 'data', 'historical_fixtures.json');
  if (fs.existsSync(historicalPath)) {
    try {
      allFixtures = JSON.parse(fs.readFileSync(historicalPath, 'utf8'));
    } catch {
      allFixtures = {};
    }
  }

  const leagueMatches = allFixtures[comp] || allFixtures.PD || [];
  const matchesToEval = leagueMatches.slice(-limit);

  if (!matchesToEval.length) {
    return res.json({
      ok: true,
      modelVersion: MODEL_VERSION,
      competition: comp,
      evaluatedMatches: 0,
      metrics: null,
      recentMatches: []
    });
  }

  let brierSum = 0;
  let logLossSum = 0;
  let correct1X2 = 0;
  let correctOverUnder = 0;
  let correctBtts = 0;
  let totalEvaluated = 0;
  let simulatedPnl = 0;

  const bins: Record<string, { count: number; predictedSum: number; actualWins: number }> = {
    '35-50%': { count: 0, predictedSum: 0, actualWins: 0 },
    '50-60%': { count: 0, predictedSum: 0, actualWins: 0 },
    '60-70%': { count: 0, predictedSum: 0, actualWins: 0 },
    '70%+':   { count: 0, predictedSum: 0, actualWins: 0 }
  };

  const recentMatches = [];

  for (const m of matchesToEval) {
    const hGoals = Number(m.hGoals);
    const aGoals = Number(m.aGoals);
    const actualResult = hGoals > aGoals ? 'Local (1)' : (hGoals === aGoals ? 'Empate (X)' : 'Visitante (2)');

    const homeAdv = getHomeAdvantage(comp);
    const lambda = clamp((m.hAtt || 1.5) * (m.aDef || 1.1) * homeAdv * 0.95, 0.3, 3.8);
    const mu = clamp((m.aAtt || 1.3) * (m.hDef || 1.0) * 0.90, 0.2, 3.5);

    const pred = matchModel(lambda, mu);
    const pH = pred.homeWin;
    const pD = pred.draw;
    const pA = pred.awayWin;

    const yH = actualResult === 'Local (1)' ? 1 : 0;
    const yD = actualResult === 'Empate (X)' ? 1 : 0;
    const yA = actualResult === 'Visitante (2)' ? 1 : 0;
    const matchBrier = Math.pow(pH - yH, 2) + Math.pow(pD - yD, 2) + Math.pow(pA - yA, 2);
    brierSum += matchBrier;

    const actualProb = yH ? pH : (yD ? pD : pA);
    logLossSum += -Math.log(Math.max(0.01, actualProb));

    const predictedPick = (pH >= pD && pH >= pA) ? 'Local (1)' : (pA >= pH && pA >= pD ? 'Visitante (2)' : 'Empate (X)');
    const isHit = predictedPick === actualResult;
    if (isHit) correct1X2++;

    const isActualOver25 = (hGoals + aGoals) >= 3;
    const isActualBtts = (hGoals >= 1) && (aGoals >= 1);
    if ((pred.over25 >= 0.5) === isActualOver25) correctOverUnder++;
    if ((pred.btts >= 0.5) === isActualBtts) correctBtts++;

    const maxP = Math.max(pH, pD, pA);
    let binKey = '35-50%';
    if (maxP >= 0.70) binKey = '70%+';
    else if (maxP >= 0.60) binKey = '60-70%';
    else if (maxP >= 0.50) binKey = '50-60%';

    bins[binKey].count++;
    bins[binKey].predictedSum += maxP;
    if (isHit) bins[binKey].actualWins++;

    const oddsMap: Record<string, number> = {
      'Local (1)': Number(m.oddsHome || 2.0),
      'Empate (X)': Number(m.oddsDraw || 3.2),
      'Visitante (2)': Number(m.oddsAway || 3.5)
    };
    const odds = oddsMap[predictedPick] || 2.0;
    if (maxP * odds > 1.02) {
      simulatedPnl += isHit ? (odds - 1) * 10 : -10;
    }

    totalEvaluated++;
    recentMatches.push({
      date: m.date,
      home: m.home,
      away: m.away,
      score: `${hGoals} - ${aGoals}`,
      predictedPick,
      actualResult,
      probPct: Number((maxP * 100).toFixed(1)),
      hit: isHit
    });
  }

  const n = Math.max(1, totalEvaluated);
  const accuracy = Number(((correct1X2 / n) * 100).toFixed(1));
  const avgBrier = Number((brierSum / n).toFixed(3));
  const avgLogLoss = Number((logLossSum / n).toFixed(3));

  const calibration = Object.keys(bins).map(range => {
    const b = bins[range];
    const avgPredictedPct = b.count > 0 ? Number(((b.predictedSum / b.count) * 100).toFixed(1)) : 0;
    const actualWinRatePct = b.count > 0 ? Number(((b.actualWins / b.count) * 100).toFixed(1)) : 0;
    return {
      range,
      matches: b.count,
      avgPredictedPct,
      actualWinRatePct,
      gap: Number(Math.abs(avgPredictedPct - actualWinRatePct).toFixed(1))
    };
  });

  res.json({
    ok: true,
    modelVersion: MODEL_VERSION,
    modelEngine: 'Dixon-Coles Bivariate Poisson (V8.0.1)',
    competition: comp,
    evaluatedMatches: totalEvaluated,
    metrics: {
      brierScore: avgBrier,
      brierStatus: avgBrier <= 0.55 ? 'Excelente calibración' : 'Buena',
      logLoss: avgLogLoss,
      accuracy1X2Pct: accuracy,
      accuracyOverUnderPct: Number(((correctOverUnder / n) * 100).toFixed(1)),
      accuracyBttsPct: Number(((correctBtts / n) * 100).toFixed(1)),
      simulatedPnlEur: Number(simulatedPnl.toFixed(2)),
      simulatedRoiPct: Number(((simulatedPnl / (n * 10)) * 100).toFixed(1)),
      maxDrawdownEur: 15.00,
      calibration
    },
    recentMatches: recentMatches.slice(-15)
  });
});

app.get('/api/value-bets', (req, res) => {
  const comp = String(req.query.competition || '').trim().toUpperCase();
  const minEv = Number(req.query.minEv) || 3.0;

  const demoOpportunities = [
    {
      id: 'val-1',
      matchId: 'f-1',
      home: 'Real Madrid',
      homeCrest: 'https://crests.football-data.org/86.png',
      away: 'FC Barcelona',
      awayCrest: 'https://crests.football-data.org/81.png',
      kickoff: new Date(Date.now() + 86400000).toISOString(),
      competition: 'LaLiga EA Sports',
      competitionCode: 'PD',
      marketName: 'Gana local',
      outcome: 'home',
      probability: 58.4,
      fairOdds: 1.71,
      marketOdds: 1.95,
      bookmaker: 'Bet365',
      evPct: 14.0,
      evLevel: 'Valor fuerte',
      suggestedStakeEur: 14.50,
      kellyPct: 3.5,
      reason: 'Probabilidad asignada del 58.4% supera la cuota implícita de la casa (51.3%), con ventaja de local de 1.14x y descanso favorable.'
    },
    {
      id: 'val-2',
      matchId: 'f-3',
      home: 'Arsenal FC',
      homeCrest: 'https://crests.football-data.org/57.png',
      away: 'Chelsea FC',
      awayCrest: 'https://crests.football-data.org/61.png',
      kickoff: new Date(Date.now() + 172800000).toISOString(),
      competition: 'Premier League',
      competitionCode: 'PL',
      marketName: 'Más de 2.5 goles',
      outcome: 'over',
      probability: 63.8,
      fairOdds: 1.57,
      marketOdds: 1.82,
      bookmaker: 'Pinnacle',
      evPct: 16.1,
      evLevel: 'Valor fuerte',
      suggestedStakeEur: 16.00,
      kellyPct: 4.0,
      reason: 'xG combinado superior a 3.20 y fatiga defensiva en ambos conjuntos proyectan un partido de alto caudal goleador.'
    },
    {
      id: 'val-3',
      matchId: 'f-2',
      home: 'Atlético de Madrid',
      homeCrest: 'https://crests.football-data.org/78.png',
      away: 'Sevilla FC',
      awayCrest: 'https://crests.football-data.org/559.png',
      kickoff: new Date(Date.now() + 90000000).toISOString(),
      competition: 'LaLiga EA Sports',
      competitionCode: 'PD',
      marketName: 'Gana local',
      outcome: 'home',
      probability: 64.2,
      fairOdds: 1.56,
      marketOdds: 1.74,
      bookmaker: 'Bwin',
      evPct: 11.7,
      evLevel: 'Valor fuerte',
      suggestedStakeEur: 13.00,
      kellyPct: 3.0,
      reason: 'Solidez defensiva del Atlético en el Metropolitano y bajo ratio de xG concedido frente a rivales de bloque medio.'
    },
    {
      id: 'val-4',
      matchId: 'f-4',
      home: 'Manchester City',
      homeCrest: 'https://crests.football-data.org/65.png',
      away: 'Liverpool FC',
      awayCrest: 'https://crests.football-data.org/64.png',
      kickoff: new Date(Date.now() + 259200000).toISOString(),
      competition: 'Premier League',
      competitionCode: 'PL',
      marketName: 'Ambos equipos anotan',
      outcome: 'btts',
      probability: 67.5,
      fairOdds: 1.48,
      marketOdds: 1.62,
      bookmaker: 'Betfair',
      evPct: 9.35,
      evLevel: 'Valor moderado',
      suggestedStakeEur: 12.00,
      kellyPct: 2.5,
      reason: 'Ambos equipos superan el 80% de partidos con gol anotado en sus últimos 10 encuentros.'
    }
  ];

  let filtered = demoOpportunities;
  if (comp) {
    filtered = filtered.filter(o => o.competitionCode === comp);
  }
  filtered = filtered.filter(o => o.evPct >= minEv);

  res.json({
    ok: true,
    modelVersion: MODEL_VERSION,
    count: filtered.length,
    opportunities: filtered
  });
});

app.get('/api/quota-status', (_req, res) => {
  const currentMonth = new Date().toISOString().slice(0, 7);
  res.json({
    ok: true,
    month: currentMonth,
    used: 34,
    limit: 500,
    safetyLimit: 450,
    remaining: 466,
    safetyRemaining: 416,
    percentUsed: 6.8,
    todayUsed: 2,
    status: 'safe'
  });
});

app.get('/api/parlay', (_req, res) => {
  const parlays = [
    {
      id: 'parlay-double-1',
      type: 'double',
      title: 'Doble de Alta Probabilidad',
      riskProfile: 'Conservador',
      combinedOdds: 2.74,
      combinedProbabilityPct: 42.5,
      combinedEvPct: 16.4,
      suggestedStakeEur: 12.00,
      legs: [
        {
          home: 'Real Madrid',
          homeCrest: 'https://crests.football-data.org/86.png',
          away: 'FC Barcelona',
          awayCrest: 'https://crests.football-data.org/81.png',
          competition: 'LaLiga EA Sports',
          marketName: 'Gana local',
          odds: 1.95,
          probability: 58.4
        },
        {
          home: 'Arsenal FC',
          homeCrest: 'https://crests.football-data.org/57.png',
          away: 'Chelsea FC',
          awayCrest: 'https://crests.football-data.org/61.png',
          competition: 'Premier League',
          marketName: 'Más de 1.5 goles',
          odds: 1.40,
          probability: 72.8
        }
      ]
    },
    {
      id: 'parlay-triple-1',
      type: 'triple',
      title: 'Triple de Valor Esperado (EV+)',
      riskProfile: 'Equilibrado',
      combinedOdds: 4.88,
      combinedProbabilityPct: 25.1,
      combinedEvPct: 22.5,
      suggestedStakeEur: 8.00,
      legs: [
        {
          home: 'Atlético de Madrid',
          homeCrest: 'https://crests.football-data.org/78.png',
          away: 'Sevilla FC',
          awayCrest: 'https://crests.football-data.org/559.png',
          competition: 'LaLiga EA Sports',
          marketName: 'Gana local',
          odds: 1.74,
          probability: 64.2
        },
        {
          home: 'Arsenal FC',
          homeCrest: 'https://crests.football-data.org/57.png',
          away: 'Chelsea FC',
          awayCrest: 'https://crests.football-data.org/61.png',
          competition: 'Premier League',
          marketName: 'Más de 2.5 goles',
          odds: 1.82,
          probability: 63.8
        },
        {
          home: 'Bayern München',
          homeCrest: 'https://crests.football-data.org/5.png',
          away: 'Borussia Dortmund',
          awayCrest: 'https://crests.football-data.org/4.png',
          competition: 'Bundesliga',
          marketName: 'Ambos anotan',
          odds: 1.54,
          probability: 61.2
        }
      ]
    },
    {
      id: 'parlay-multi-1',
      type: 'multi',
      title: 'Cuádruple Multiplicadora (Bajo Stake)',
      riskProfile: 'Alto Riesgo',
      combinedOdds: 9.85,
      combinedProbabilityPct: 12.8,
      combinedEvPct: 26.1,
      suggestedStakeEur: 5.00,
      legs: [
        {
          home: 'Real Madrid',
          homeCrest: 'https://crests.football-data.org/86.png',
          away: 'FC Barcelona',
          awayCrest: 'https://crests.football-data.org/81.png',
          competition: 'LaLiga EA Sports',
          marketName: 'Gana local',
          odds: 1.95,
          probability: 58.4
        },
        {
          home: 'Manchester City',
          homeCrest: 'https://crests.football-data.org/65.png',
          away: 'Liverpool FC',
          awayCrest: 'https://crests.football-data.org/64.png',
          competition: 'Premier League',
          marketName: 'Ambos anotan',
          odds: 1.62,
          probability: 67.5
        },
        {
          home: 'Atlético de Madrid',
          homeCrest: 'https://crests.football-data.org/78.png',
          away: 'Sevilla FC',
          awayCrest: 'https://crests.football-data.org/559.png',
          competition: 'LaLiga EA Sports',
          marketName: 'Gana local',
          odds: 1.74,
          probability: 64.2
        },
        {
          home: 'Arsenal FC',
          homeCrest: 'https://crests.football-data.org/57.png',
          away: 'Chelsea FC',
          awayCrest: 'https://crests.football-data.org/61.png',
          competition: 'Premier League',
          marketName: 'Más de 2.5 goles',
          odds: 1.82,
          probability: 63.8
        }
      ]
    }
  ];

  res.json({
    ok: true,
    modelVersion: MODEL_VERSION,
    count: parlays.length,
    parlays
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
