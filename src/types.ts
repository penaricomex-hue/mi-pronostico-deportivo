export type Selection = 'home' | 'draw' | 'away' | 'over25' | 'under25';
export type BetStatus = 'pending' | 'won' | 'lost' | 'void';

export interface Fixture {
  id: string;
  providerId: string | number;
  source: 'football-data' | 'the-odds-api';
  competitionCode: string;
  competition: string;
  kickoff: string;
  status: string;
  home: string;
  away: string;
  homeCrest: string | null;
  awayCrest: string | null;
  score: { home: number; away: number } | null;
}

export interface Probabilities {
  home: number | null;
  draw: number | null;
  away: number | null;
  over25: number | null;
  under25: number | null;
  btts?: number | null;
}

export interface SelectionEval {
  selection: Selection;
  market: 'h2h' | 'totals';
  label: string;
  probability: number;
  fairOdds: number | null;
  bestOdds: number;
  bestBookmaker: string | null;
  referenceOdds: number | null;
  bookmakerCount: number | null;
  ev: number;
  evReference: number | null;
  outlier: boolean;
  passesRules: boolean;
  isValue: boolean;
  reasons: string[];
  suggestedStake: number;
  flatStake: number;
}

export interface LeagueInfo {
  code: string;
  hasModel: boolean;
  valueEnabled: boolean;
  testClvPct: number | null;
  testRoiPct: number | null;
  testBets: number | null;
}

export type EngineMarket = '1x2' | 'double_chance' | 'over_under' | 'btts' | 'asian_handicap';

export interface CalibrationExplain {
  raw: number;
  calibrated: number;
  method: 'identity' | 'platt' | 'isotonic';
  sample: number;
  text: string;
}

export interface EngineSelection {
  selection: string;
  market: EngineMarket;
  marketLabel: string;
  label: string;
  modelRaw: number | null;
  modelProbability: number | null;
  calibration: CalibrationExplain | null;
  marketProbability: number | null;
  marketBooks: number;
  marketAvgOdds: number | null;
  bestOtherOdds: number | null;
  fairOdds: number | null;
  minCalienteOdds: number | null;
  stakeAtRisk: number;
  caliente: { odds: number | null; capturedAt: string | null; source: string | null; opening: number | null; openingAt: string | null; closing: number | null } | null;
  calienteVsMarketPct: number | null;
  ev: number | null;
  marketGap: number | null;
  recommended: boolean;
  reason: string;
  blockers: string[];
  suggestedStake: number;
  flatStake: number;
}

export interface EngineRules {
  minEv: number;
  maxMarketGap: number;
  minOdds: number;
  maxOdds: number;
  maxBetsPerMatchday: number;
  minMarketBooks: number;
  enabledMarkets: EngineMarket[];
}

export interface Analysis extends Fixture {
  competitionSlug: string;
  matchId: number | null;
  matchdayKey: string;
  engine: EngineSelection[];
  engineRules: EngineRules;
  recommended: EngineSelection[];
  canonical: { home: string; away: string };
  modelAvailable: boolean;
  dataQuality: 'alta' | 'media' | 'baja' | null;
  xg: { home: number; away: number; rho: number } | null;
  sample: { home: number; away: number } | null;
  mostLikelyScore: { home: number; away: number; probability: number } | null;
  probabilities: { model: Probabilities | null; market: Probabilities | null; final: Probabilities };
  weights: { w1x2: number; wOU: number };
  league: LeagueInfo;
  odds: { available: boolean; bookmakers: number; fromCache: boolean; eventId: string | null; books?: string[] };
  selections: SelectionEval[];
  bestValue: SelectionEval | null;
  secondOpinion: { source: string; home: number | null; draw: number | null; away: number | null } | null;
  injuries: { home: Injury[]; away: Injury[] } | null;
  currency: string;
  warnings: string[];
}

export interface Injury {
  player: string;
  position: string | null;
  status: string;
}

export interface Pick {
  fixtureId: string;
  competitionCode: string;
  competition: string;
  kickoff: string;
  home: string;
  away: string;
  homeCrest: string | null;
  awayCrest: string | null;
  selection: Selection;
  market: string;
  label: string;
  probability: number;
  fairOdds: number | null;
  bestOdds: number;
  bestBookmaker: string | null;
  referenceOdds: number | null;
  bookmakerCount: number | null;
  ev: number;
  suggestedStake: number;
  flatStake: number;
  validated: boolean;
  reasons: string[];
  dataQuality: string | null;
}

export interface Parlay {
  id: string;
  legs: Pick[];
  combinedOdds: number;
  combinedProbability: number;
  ev: number;
  validated: boolean;
  suggestedStake: number;
}

export interface ScoreMetrics {
  matches: number;
  brier: number | null;
  logLoss: number | null;
  rps: number | null;
  accuracyPct: number | null;
  brierOU: number | null;
  logLossOU: number | null;
}

export interface CalibrationRow {
  outcome: string;
  range: string;
  matches: number;
  predictedPct: number;
  actualPct: number;
  gapPts: number;
}

export interface BacktestBet {
  date: string;
  home: string;
  away: string;
  score: string;
  selection: Selection;
  label: string;
  probabilityPct: number;
  odds: number;
  evPct: number;
  clvPct: number | null;
  result: 'won' | 'lost';
  profitUnits: number;
}

export interface BacktestSplit {
  matches: number;
  metrics: { model: ScoreMetrics; blended: ScoreMetrics; market: ScoreMetrics; uniform: ScoreMetrics };
  verdicts: Record<string, string>;
  calibration: CalibrationRow[];
  betting: {
    bets: number;
    won: number;
    hitRatePct: number | null;
    stakedUnits: number;
    profitUnits: number;
    roiPct: number | null;
    maxDrawdownUnits: number;
    avgClvPct: number | null;
    clvPositivePct: number | null;
    recentBets: BacktestBet[];
  };
}

export interface BacktestLeague {
  competition: string;
  xi: number;
  weights: { w1x2: number; wOU: number };
  trainSeasons: string[];
  testSeasons: string[];
  valueEnabled: boolean;
  valueRule: string;
  train: BacktestSplit;
  test: BacktestSplit;
  generatedAt: string;
  modelVersion: string;
  engine?: {
    proxy: string;
    bets: number;
    hitRatePct: number | null;
    profitUnits: number;
    yieldPct: number | null;
    avgClvPct: number | null;
    clvPositivePct: number | null;
    byMarket: Record<string, { bets: number; won: number; profit: number; hitRatePct: number | null; yieldPct: number | null }>;
    calibrators: Record<string, { method: string; n: number }>;
  } | null;
}

export interface Bet {
  id: number | string;
  createdAt: string;
  matchDate: string | null;
  kickoff: string | null;
  fixtureId: string | null;
  home: string;
  away: string;
  competition: string | null;
  market: string;
  selection: Selection | 'parlay' | null;
  label: string;
  odds: number;
  probability: number | null;
  stake: number;
  currency: string;
  status: BetStatus;
  profit: number | null;
  settledAt: string | null;
  score: string | null;
  closingOdds: number | null;
  clvPct: number | null;
  legs: Array<Pick & { status?: BetStatus }> | null;
}

export interface BetSummary {
  period: string;
  currency: string;
  total: number;
  pending: number;
  won: number;
  lost: number;
  void: number;
  staked: number;
  profit: number;
  roiPct: number | null;
  hitRatePct: number | null;
  avgClvPct: number | null;
  clvSample: number;
}

export interface Status {
  ok: boolean;
  modelVersion: string;
  modelName: string;
  config: {
    footballDataConfigured: boolean;
    oddsApiConfigured: boolean;
    databaseConfigured: boolean;
    bigBallsConfigured: boolean;
    currency: string;
    flatStake: number;
    bankroll: number;
    kellyFraction: number;
    maxStakePct: number;
    oddsCacheMinutes: number;
    trackClosingOdds: boolean;
  };
  persistentStore: boolean;
  competitions: Record<string, string>;
  model: {
    modelVersion: string | null;
    generatedAt: string | null;
    leagues: Record<string, { xi: number; w1x2: number; wOU: number; valueEnabled: boolean; testClvPct?: number; testRoiPct?: number; testBets?: number }>;
  };
  providers: {
    footballData: { calls: number; errors: number; rateLimited: number; lastAvailable: number | null; lastError: string | null; limiter: { limit: number; usedInWindow: number } };
    oddsApi: { remaining: number | null; used: number | null; todayUsed: number; dailyBudget: number; reserve: number; costPerCall: number; blocked: boolean; blockedReason: string | null };
  };
  unresolvedTeams: string[];
}

export interface SignalCandidate extends EngineSelection {
  fixtureId: string;
  matchId: number | null;
  matchdayKey: string;
  competitionSlug: string;
  competition: string;
  competitionCode: string;
  home: string;
  away: string;
  kickoff: string;
  homeCrest: string | null;
  awayCrest: string | null;
  droppedReason?: string;
}

export interface CalienteCheck {
  fixtureId: string;
  competitionCode: string;
  competition: string;
  kickoff: string;
  home: string;
  away: string;
  selection: string;
  label: string;
  market: EngineMarket;
  modelProbability: number;
  marketProbability: number;
  marketAvgOdds: number | null;
  minCalienteOdds: number;
}

export interface SignalsPreview {
  analyzed: number;
  recommended: SignalCandidate[];
  capped: SignalCandidate[];
  toCheckInCaliente: CalienteCheck[];
  rules: EngineRules;
  warnings: string[];
}

export interface Signal {
  id: number;
  matchId: number;
  competitionSlug: string;
  competition: string;
  matchdayKey: string;
  home: string;
  away: string;
  kickoff: string;
  market: EngineMarket;
  marketLabel: string;
  selection: string;
  label: string;
  modelProbabilityRaw: number;
  modelProbability: number;
  marketProbability: number;
  marketAvgOdds: number | null;
  calienteOdds: number;
  calienteCapturedAt: string;
  ev: number;
  marketGap: number;
  stake: number;
  currency: string;
  mode: 'paper' | 'real';
  status: 'pending' | 'won' | 'lost' | 'void' | 'half_won' | 'half_lost';
  profit: number | null;
  closingCalienteOdds: number | null;
  closingMarketProbability: number | null;
  clv: number | null;
  score: string | null;
}

export interface PerfGroup {
  key: string;
  competitionSlug: string;
  competition: string;
  market: string;
  marketLabel: string;
  signals: number;
  settled: number;
  hitRatePct: number | null;
  profit: number | null;
  yieldPct: number | null;
  avgEvPct: number | null;
  avgClvPct: number | null;
}

export interface Performance {
  days: number;
  mode: 'paper' | 'real';
  currency: string;
  totals: {
    signals: number; pending: number; settled: number; won: number; lost: number; void: number;
    hitRatePct: number | null; staked: number | null; profit: number | null; roiPct: number | null; yieldPct: number | null;
    avgEvPct: number | null; avgClvPct: number | null; clvPositivePct: number | null; clvSample: number;
  };
  byCompetition: PerfGroup[];
  byCompetitionMarket: PerfGroup[];
  calibration: Array<{ range: string; signals: number; predictedPct: number | null; actualPct: number | null; rawPredictedPct: number | null }>;
  calienteVsMarket: { signals: number; avgCalienteOdds: number | null; avgMarketOdds: number | null; avgPremiumPct: number | null; betterThanMarketPct: number | null; beatCalienteClosePct: number | null };
  bestMarkets: PerfGroup[];
  worstMarkets: PerfGroup[];
  keyQuestion: { text: string; clvPositivePct: number | null; avgClvPct: number | null; verdict: string };
}
