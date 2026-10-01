/**
 * Partidos de demostración y generador de análisis para el preview
 */

export interface FixtureItem {
  id: number | string;
  home: string;
  homeCrest: string;
  away: string;
  awayCrest: string;
  kickoff: string;
  competition: string;
  competitionCode: string;
  status: string;
}

export function getMockFixtures(dateStr: string, compCode: string): FixtureItem[] {
  const d = dateStr || new Date().toISOString().slice(0, 10);

  const allFixtures: FixtureItem[] = [
    {
      id: 'f-1',
      home: 'Real Madrid',
      homeCrest: 'https://crests.football-data.org/86.png',
      away: 'FC Barcelona',
      awayCrest: 'https://crests.football-data.org/81.png',
      kickoff: `${d}T19:00:00Z`,
      competition: 'LaLiga EA Sports',
      competitionCode: 'PD',
      status: 'SCHEDULED'
    },
    {
      id: 'f-2',
      home: 'Atlético de Madrid',
      homeCrest: 'https://crests.football-data.org/78.png',
      away: 'Sevilla FC',
      awayCrest: 'https://crests.football-data.org/559.png',
      kickoff: `${d}T16:15:00Z`,
      competition: 'LaLiga EA Sports',
      competitionCode: 'PD',
      status: 'SCHEDULED'
    },
    {
      id: 'f-3',
      home: 'Arsenal FC',
      homeCrest: 'https://crests.football-data.org/57.png',
      away: 'Chelsea FC',
      awayCrest: 'https://crests.football-data.org/61.png',
      kickoff: `${d}T14:00:00Z`,
      competition: 'Premier League',
      competitionCode: 'PL',
      status: 'SCHEDULED'
    },
    {
      id: 'f-4',
      home: 'Manchester City',
      homeCrest: 'https://crests.football-data.org/65.png',
      away: 'Liverpool FC',
      awayCrest: 'https://crests.football-data.org/64.png',
      kickoff: `${d}T16:30:00Z`,
      competition: 'Premier League',
      competitionCode: 'PL',
      status: 'SCHEDULED'
    },
    {
      id: 'f-5',
      home: 'Inter de Milán',
      homeCrest: 'https://crests.football-data.org/108.png',
      away: 'Juventus FC',
      awayCrest: 'https://crests.football-data.org/109.png',
      kickoff: `${d}T19:45:00Z`,
      competition: 'Serie A',
      competitionCode: 'SA',
      status: 'SCHEDULED'
    },
    {
      id: 'f-6',
      home: 'Bayern Múnich',
      homeCrest: 'https://crests.football-data.org/5.png',
      away: 'Borussia Dortmund',
      awayCrest: 'https://crests.football-data.org/4.png',
      kickoff: `${d}T17:30:00Z`,
      competition: 'Bundesliga',
      competitionCode: 'BL1',
      status: 'SCHEDULED'
    },
    {
      id: 'f-7',
      home: 'Paris Saint-Germain',
      homeCrest: 'https://crests.football-data.org/524.png',
      away: 'Olympique de Marsella',
      awayCrest: 'https://crests.football-data.org/516.png',
      kickoff: `${d}T20:00:00Z`,
      competition: 'Ligue 1',
      competitionCode: 'FL1',
      status: 'SCHEDULED'
    }
  ];

  if (!compCode) return allFixtures;
  return allFixtures.filter(f => f.competitionCode === compCode);
}

const HOME_ADVANTAGE_MAP: Record<string, number> = {
  PD: 1.14,
  SA: 1.13,
  EL: 1.13,
  BL1: 1.10,
  CL: 1.10,
  FL1: 1.09,
  PL: 1.07
};

export function getMockAnalysis(home: string, away: string, date: string, compCode: string = 'PD') {
  const advantage = HOME_ADVANTAGE_MAP[compCode] || 1.08;

  // Cálculos dinámicos
  const homeXg = Number((1.65 * advantage * 0.95).toFixed(2));
  const awayXg = 1.18;
  const totalXg = Number((homeXg + awayXg).toFixed(2));

  // Simulación de descanso calculado propio (Football-Data)
  const homeRestDays = 6; // descanso óptimo
  const awayRestDays = 3; // cansancio por jugar entre semana

  // Simulación de predicción Big Balls (/v1/predictions)
  const bbAgrees = true;
  const bbComparison = {
    available: true,
    agrees: bbAgrees,
    status: bbAgrees ? 'Consenso (+5% confianza)' : 'Divergencia (Alerta)',
    mkPick: 'Gana local',
    bbPick: 'Gana local',
    confidenceDelta: 5,
    message: 'Big Balls coincide con nuestro modelo proyectando victoria del conjunto local. Señal de alta fiabilidad.'
  };

  const confidence = 82; // Alta con círculo verde

  return {
    match: {
      id: 'demo-' + home + '-' + away,
      home,
      homeCrest: home.includes('Madrid') ? 'https://crests.football-data.org/86.png' : (home.includes('Arsenal') ? 'https://crests.football-data.org/57.png' : 'https://crests.football-data.org/108.png'),
      away,
      awayCrest: away.includes('Barcelona') ? 'https://crests.football-data.org/81.png' : (away.includes('Chelsea') ? 'https://crests.football-data.org/61.png' : 'https://crests.football-data.org/109.png'),
      date,
      kickoff: `${date}T19:00:00Z`,
      competition: compCode === 'PD' ? 'LaLiga' : (compCode === 'PL' ? 'Premier League' : 'Champions League'),
      competitionCode: compCode
    },
    recommendation: 'Gana local',
    reason: `El modelo detecta valor en la victoria local respaldado por 6 días de descanso frente a los 3 días del rival, ventaja de localía de ${advantage}x en esta liga y consenso con Big Balls.`,
    betEligible: true,
    strength: 'Valor fuerte',
    confidence,
    confidenceLevel: 'Alta',
    confidenceExplanation: 'Señal estadística superior respaldada por descanso favorable, xG superior y cuotas atractivas.',
    homeAdvantage: {
      factor: advantage,
      league: compCode,
      description: `Factor de localía ajustado: ${advantage}x`
    },
    rest: {
      home: { days: homeRestDays, status: 'Descanso óptimo (6d)', impactPct: 0 },
      away: { days: awayRestDays, status: 'Cansancio moderado (3d)', impactPct: -7 }
    },
    bigBallsComparison: bbComparison,
    xG: { home: homeXg, away: awayXg, total: totalXg },
    mostLikelyScore: { score: '2-1', probability: 14.8 },
    probabilities: {
      homeWin: 58.4,
      draw: 22.1,
      awayWin: 19.5,
      over25: 56.2,
      under25: 43.8,
      btts: 53.0
    },
    markets: [
      {
        type: 'h2h',
        outcome: 'home',
        name: 'Gana local',
        probability: 58.4,
        bestOdds: 1.95,
        referenceOdds: 1.88,
        referenceEvPct: 9.8,
        valueEligible: true,
        valueLevel: 'Valor fuerte',
        bookmaker: 'Bet365',
        suggestedStakeEur: 14.5
      },
      {
        type: 'h2h',
        outcome: 'draw',
        name: 'Empate',
        probability: 22.1,
        bestOdds: 3.65,
        referenceOdds: 3.50,
        referenceEvPct: -22.6,
        valueEligible: false,
        valueLevel: 'Sin valor',
        bookmaker: 'Pinnacle',
        suggestedStakeEur: 10
      },
      {
        type: 'h2h',
        outcome: 'away',
        name: 'Gana visitante',
        probability: 19.5,
        bestOdds: 4.50,
        referenceOdds: 4.20,
        referenceEvPct: -12.3,
        valueEligible: false,
        valueLevel: 'Sin valor',
        bookmaker: 'Bwin',
        suggestedStakeEur: 10
      },
      {
        type: 'totals',
        outcome: 'over',
        name: 'Over 2.5',
        probability: 56.2,
        bestOdds: 1.92,
        referenceOdds: 1.85,
        referenceEvPct: 7.9,
        valueEligible: true,
        valueLevel: 'Valor',
        bookmaker: 'Betfair',
        suggestedStakeEur: 12
      },
      {
        type: 'totals',
        outcome: 'under',
        name: 'Under 2.5',
        probability: 43.8,
        bestOdds: 1.98,
        referenceOdds: 2.05,
        referenceEvPct: -13.3,
        valueEligible: false,
        valueLevel: 'Sin valor',
        bookmaker: 'William Hill',
        suggestedStakeEur: 10
      }
    ],
    oddsAvailable: true
  };
}

export interface ValueOpportunity {
  id: string;
  matchId: string;
  home: string;
  homeCrest: string;
  away: string;
  awayCrest: string;
  kickoff: string;
  competition: string;
  competitionCode: string;
  marketName: string;
  outcome: string;
  probability: number;
  fairOdds: number;
  marketOdds: number;
  bookmaker: string;
  evPct: number;
  evLevel: string;
  suggestedStakeEur: number;
  kellyPct: number;
  reason: string;
}

export function getMockValueOpportunities(compCode?: string, minEv = 3.0): ValueOpportunity[] {
  const list: ValueOpportunity[] = [
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
    },
    {
      id: 'val-5',
      matchId: 'f-5',
      home: 'Bayern München',
      homeCrest: 'https://crests.football-data.org/5.png',
      away: 'Borussia Dortmund',
      awayCrest: 'https://crests.football-data.org/4.png',
      kickoff: new Date(Date.now() + 345600000).toISOString(),
      competition: 'Bundesliga',
      competitionCode: 'BL1',
      marketName: 'Más de 3.0 goles',
      outcome: 'over',
      probability: 61.0,
      fairOdds: 1.64,
      marketOdds: 1.88,
      bookmaker: 'Bet365',
      evPct: 14.68,
      evLevel: 'Valor fuerte',
      suggestedStakeEur: 15.00,
      kellyPct: 3.6,
      reason: 'Der Klassiker promedia 3.8 goles en sus últimos 5 enfrentamientos directos en Múnich.'
    }
  ];

  let res = list;
  if (compCode) {
    res = res.filter(o => o.competitionCode === compCode);
  }
  return res.filter(o => o.evPct >= minEv);
}

export interface ParlayLeg {
  home: string;
  homeCrest: string;
  away: string;
  awayCrest: string;
  competition: string;
  marketName: string;
  odds: number;
  probability: number;
}

export interface SmartParlay {
  id: string;
  type: 'double' | 'triple' | 'multi';
  title: string;
  riskProfile: 'Conservador' | 'Equilibrado' | 'Alto Riesgo';
  combinedOdds: number;
  combinedProbabilityPct: number;
  combinedEvPct: number;
  suggestedStakeEur: number;
  legs: ParlayLeg[];
}

export function getMockSmartParlays(): SmartParlay[] {
  return [
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
}


