export type Selection =
  | 'home' | 'draw' | 'away'
  | 'dc_1x' | 'dc_x2' | 'dc_12'
  | 'over25' | 'under25'
  | 'btts_yes' | 'btts_no'
  | 'ah_home' | 'ah_away';
export type MarketKey = '1x2' | 'double_chance' | 'over_under' | 'btts' | 'asian_handicap';
export type BetStatus = 'pending' | 'won' | 'lost' | 'void' | 'half_won' | 'half_lost';

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

export type Probabilities = Partial<Record<Selection, number | null>>;

export interface CalibrationInfo {
  message: string;
  method: string;
  range?: { range: string; samples: number; hitRate: number | null } | null;
  samples?: number;
}

export interface BlendInfo {
  modelWeight: number;
  probability: number;
  message: string;
}

export interface SelectionEval {
  selection: Selection;
  market: MarketKey;
  line: number;
  label: string;
  modelProbability: number | null;
  calibratedProbability: number | null;
  /** Mezcla modelo + mercado: es la probabilidad con la que se calcula el EV */
  blendedProbability?: number | null;
  blend?: BlendInfo | null;
  evModel?: number | null;
  rulesOk?: boolean;
  probability: number | null;
  marketProbability: number | null;
  pushProbability?: number | null;
  fairOdds: number | null;
  executionOdds: number;
  executionBookmaker: string | null;
  avgMarketOdds: number | null;
  minimumOdds: number | null;
  bookmakerCount: number | null;
  ev: number;
  marketGap: number | null;
  recommended: boolean;
  alreadySignaled?: boolean;
  reason: string;
  blockers: string[];
  calibration: CalibrationInfo | null;
  jornadaKey: string;
  suggestedStake: number;
  flatStake: number;
}

export interface LeagueInfo {
  code: string;
  slug: string;
  hasModel: boolean;
  xi?: number;
}

export interface Analysis extends Fixture {
  matchId: number | null;
  competitionSlug: string;
  jornadaKey: string;
  canonical: { home: string; away: string };
  modelAvailable: boolean;
  dataQuality: 'alta' | 'media' | 'baja' | null;
  xg: { home: number; away: number; rho: number } | null;
  sample: { home: number; away: number } | null;
  mostLikelyScore: { home: number; away: number; probability: number } | null;
  probabilities: { model: Probabilities | null; calibrated: Probabilities | null; market: Probabilities | null; final: Probabilities | null };
  league: LeagueInfo;
  odds: {
    available: boolean; bookmakers: number; fromCache: boolean; eventId: string | null; capturedAt: string | null;
    executionMode: 'fixed' | 'best'; executionBookmaker: string | null; asianHandicapLine: number | null;
  };
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

export interface Pick extends Omit<SelectionEval, 'jornadaKey'> {
  fixtureId: string;
  matchId: number | null;
  competitionCode: string;
  competitionSlug: string;
  competition: string;
  jornadaKey: string;
  kickoff: string;
  home: string;
  away: string;
  homeCrest: string | null;
  awayCrest: string | null;
  oddsCapturedAt: string | null;
  dataQuality: string | null;
}

export interface ValueRules {
  minEv: number;
  maxMarketGap: number;
  minOdds: number;
  maxOdds: number;
  maxBetsPerJornada: number;
  minBookmakers: number;
  enabledMarkets: MarketKey[];
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

export interface BandRow {
  range: string;
  samples: number;
  predictedPct: number | null;
  actualPct: number | null;
}

export interface BacktestBet {
  date: string;
  home: string;
  away: string;
  score: string;
  selection: Selection;
  label: string;
  rawProbabilityPct: number;
  calibratedPct?: number;
  probabilityPct: number;
  marketPct: number;
  odds: number;
  evPct: number;
  clvPct: number | null;
  result: BetStatus;
  profitUnits: number;
}

export interface BacktestBetting {
  priceMode: 'average' | 'best';
  bets: number;
  won: number;
  hitRatePct: number | null;
  stakedUnits: number;
  profitUnits: number;
  yieldPct: number | null;
  avgEvPct: number | null;
  maxDrawdownUnits: number;
  avgClvPct: number | null;
  clvPositivePct: number | null;
  byMarket: Record<string, { bets: number; won: number; profit: number; hitRatePct: number }>;
  recentBets: BacktestBet[];
}

export interface BacktestSplit {
  matches: number;
  metrics: { model: ScoreMetrics; calibrated: ScoreMetrics; blended?: ScoreMetrics | null; market: ScoreMetrics; uniform: ScoreMetrics; bttsModel: { n: number; brier: number | null; logLoss: number | null }; bttsCalibrated: { n: number; brier: number | null; logLoss: number | null } };
  verdicts: Record<string, string>;
  calibration: { model: BandRow[]; calibrated: BandRow[] };
}

export interface BacktestLeague {
  code: string;
  competition: string;
  competitionSlug: string;
  xi: number;
  trainSeasons: string[];
  testSeasons: string[];
  rules: ValueRules;
  calibrationMaps: Record<string, { method: string; samples: number }>;
  train: BacktestSplit;
  test: BacktestSplit;
  betting: BacktestBetting | null;
  bettingBestPrice: BacktestBetting | null;
  bettingModelOnly?: BacktestBetting | null;
  bettingModelOnlyBestPrice?: BacktestBetting | null;
  blendWeights?: Record<string, { weight: number; optimumWeight?: number; samples: number; fitted: boolean; logLoss?: number; logLossMarketOnly?: number; logLossModelOnly?: number; inheritedFrom?: string }> | null;
  generatedAt: string;
  modelVersion: string;
}

export interface Signal {
  id: number;
  createdAt: string;
  fixtureId: string;
  competitionSlug: string;
  competition: string;
  jornadaKey: string;
  kickoff: string;
  home: string;
  away: string;
  market: MarketKey;
  marketLabel: string;
  selection: Selection;
  line: number;
  label: string;
  bookmaker: string | null;
  odds: number;
  oddsCapturedAt: string;
  modelProbability: number | null;
  calibratedProbability: number | null;
  blendedProbability: number | null;
  modelWeight: number | null;
  marketProbability: number | null;
  ev: number;
  evModel: number | null;
  marketGap: number | null;
  avgMarketOdds: number | null;
  stake: number;
  currency: string;
  mode: 'paper' | 'live';
  status: BetStatus;
  profit: number | null;
  score: string | null;
  closingOdds: number | null;
  closingFairProbability: number | null;
  clv: number | null;
}

export interface MeanCI { n: number; mean: number | null; lo: number | null; hi: number | null; se: number | null }
export interface PropCI { n: number; pct: number | null; lo: number | null; hi: number | null }
export interface Verdict { level: 'insufficient' | 'positive' | 'negative' | 'warning' | 'review' | 'inconclusive'; title: string; text: string; remaining: number }

export interface PerfAgg {
  yieldCI: MeanCI;
  clvCI: MeanCI;
  hitRateCI: PropCI;
  signals: number;
  resolved: number;
  hitRatePct: number | null;
  staked: number;
  profit: number;
  yieldPct: number | null;
  avgEvPct: number | null;
  avgClvPct: number | null;
  clvPositivePct: number | null;
  clvSample: number;
}

export interface Performance {
  days: number;
  mode: 'paper' | 'live';
  currency: string;
  bankroll: number;
  totals: PerfAgg & { pending: number; roiPct: number | null; settledStaked: number; netProfit: number };
  keyMetric: {
    question: string; signalsWithClv: number; beatClosingPct: number | null; avgClvPct: number | null; target: string; progressPct: number;
    clvCI: MeanCI; beatClosingCI: PropCI; verdict: Verdict; stopRule: string;
  };
  byCompetition: Array<PerfAgg & { competitionSlug: string; competition: string }>;
  byMarket: Array<PerfAgg & { competitionSlug: string; competition: string; market: MarketKey; marketLabel: string }>;
  bestMarkets: Array<PerfAgg & { competition: string; marketLabel: string }>;
  worstMarkets: Array<PerfAgg & { competition: string; marketLabel: string }>;
  minSampleForRanking: number;
  calibrationBands: Array<{ range: string; signals: number; predictedPct: number | null; rawModelPct: number | null; actualPct: number | null }>;
  modelCalibration: Record<string, Array<{ range: string; samples: number; predicted: number | null; actual: number | null }>> | null;
  execVsMarket: { sample: number; avgExecutionOdds: number | null; avgMarketOdds: number | null; priceEdgePct: number | null; bookmakers: Array<{ bookmaker: string; signals: number }> };
  recent: Signal[];
}

export interface ThresholdRow {
  variant: 'blend' | 'model';
  variantLabel: string;
  minEvPct: number;
  candidates: number;
  settled: number;
  avgEvPct: number | null;
  hitRateCI: PropCI;
  yieldCI: MeanCI;
  clvCI: MeanCI;
  beatClosingCI: PropCI;
  verdict: Verdict;
}

export interface ThresholdStudy {
  days: number;
  evaluations: number;
  evaluationsSettled: number;
  evaluationsWithClv: number;
  currentMinEvPct: number;
  method: string;
  table: ThresholdRow[];
}

export interface BlendSummary {
  enabled: boolean;
  override: number | null;
  competitions: Record<string, { '1x2': number; over_under: number; btts: number; source: string }>;
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
  competitionSlug?: string | null;
  line?: number | null;
  bookmaker?: string | null;
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
  activeCompetitions?: Record<string, { name: string; slug: string }>;
  disabledCompetitions?: Record<string, { name: string; slug: string }>;
  valueRules?: ValueRules | null;
  blend?: BlendSummary | null;
  calibration?: { lastFit: string | null; seedGeneratedAt: string | null; maps: Record<string, { method: string; samples: number; liveSamples: number; fittedAt: string }> } | null;
  model: {
    modelVersion: string | null;
    generatedAt: string | null;
    leagues: Record<string, { xi: number; testBets?: number | null; testYieldPct?: number | null; testClvPct?: number | null }>;
  };
  providers: {
    footballData: { calls: number; errors: number; rateLimited: number; lastAvailable: number | null; lastError: string | null; limiter: { limit: number; usedInWindow: number } };
    oddsApi: { remaining: number | null; used: number | null; todayUsed: number; dailyBudget: number; reserve: number; costPerCall: number; blocked: boolean; blockedReason: string | null };
  };
  unresolvedTeams: string[];
}
