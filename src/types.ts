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

export interface ValueOpportunity {
  id: string;
  matchId?: string;
  home: string;
  homeCrest?: string;
  away: string;
  awayCrest?: string;
  kickoff?: string;
  competition: string;
  competitionCode?: string;
  marketName: string;
  outcome?: string;
  probability: number;
  fairOdds: number;
  marketOdds: number;
  bookmaker: string;
  evPct: number;
  evLevel?: string;
  kellyPct?: number;
  suggestedStakeEur: number;
  reason?: string;
}

export interface ParlayLeg {
  home: string;
  homeCrest?: string;
  away: string;
  awayCrest?: string;
  competition?: string;
  marketName: string;
  odds: number;
  probability: number;
  selection?: string;
  bookmaker?: string;
}

export interface SmartParlay {
  id: string;
  type?: 'double' | 'triple' | 'multi';
  title?: string;
  riskProfile: string;
  combinedOdds: number;
  combinedProbabilityPct: number;
  combinedProbability?: number;
  combinedEvPct: number;
  suggestedStakeEur: number;
  legs: ParlayLeg[];
}
