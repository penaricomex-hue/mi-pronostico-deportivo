import type { Analysis, BacktestLeague, Bet, BetStatus, BetSummary, Fixture, Parlay, Performance, Pick, Signal, Status, ThresholdStudy, ValueRules } from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const tz = () => new Date().getTimezoneOffset();

async function request<T>(path: string, init?: RequestInit, attempt = 0): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', 'X-MK-Request': '1', ...(init?.headers || {}) }
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(`Respuesta no válida del servidor (HTTP ${res.status})`, res.status);
  }
  if (res.status === 503 && attempt < 5 && String(data?.error || '').includes('arrancando')) {
    await new Promise(r => setTimeout(r, 2000));
    return request<T>(path, init, attempt + 1);
  }
  if (!res.ok || data?.ok === false) throw new ApiError(data?.error || `HTTP ${res.status}`, res.status);
  return data as T;
}

function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  p.set('tz', String(tz()));
  return p.toString();
}

export const api = {
  status: () => request<Status>('/api/status'),

  fixtures: (date: string, competition: string) =>
    request<{ fixtures: Fixture[]; warnings: string[] }>(`/api/fixtures?${qs({ date, competition })}`),

  analyze: (f: Pick | Fixture, date: string) => {
    const id = 'fixtureId' in f ? f.fixtureId : f.id;
    return request<{ analysis: Analysis }>(`/api/analyze?${qs({ id, date, competition: f.competitionCode })}`);
  },

  valueBets: (competition: string, days: number, includeNearMisses: boolean) =>
    request<{
      analyzed: number; withOdds: number; picks: Pick[]; nearMisses: Pick[]; recorded: number; rules: ValueRules;
      execution: { bookmaker: string | null; mode: 'fixed' | 'best' | null }; warnings: string[];
    }>(`/api/value-bets?${qs({ competition, days, includeNearMisses })}`, { method: 'POST' }),

  parlays: (competition: string, legs: number) =>
    request<{ parlays: Parlay[]; candidates: number; assumption: string; warnings: string[] }>(
      `/api/parlay?${qs({ competition, legs })}`
    ),

  performance: (days: number) => request<Performance>(`/api/performance?days=${days}`),
  thresholds: (days: number) => request<ThresholdStudy>(`/api/evaluations/thresholds?days=${days}`),
  signals: (days = 90) => request<{ signals: Signal[] }>(`/api/signals?days=${days}`),

  backtest: (competition: string) => request<BacktestLeague>(`/api/backtest?competition=${encodeURIComponent(competition)}`),

  ratings: (competition: string) =>
    request<{ asOf: string; homeAdvantage: number; rho: number; matches: number; teams: Array<{ name: string; attack: number; defense: number; matches: number; effectiveMatches: number }> }>(
      `/api/ratings?competition=${encodeURIComponent(competition)}`
    ),

  bets: {
    list: (period = '') => request<{ bets: Bet[] }>(`/api/bets?period=${period}`),
    summary: (period = 'month') => request<BetSummary>(`/api/bets/summary?period=${period}`),
    create: (body: Record<string, unknown>) => request<{ bet: Bet }>('/api/bets', { method: 'POST', body: JSON.stringify(body) }),
    settle: (id: Bet['id'], result: BetStatus) =>
      request<{ bet: Bet }>(`/api/bets/${id}/settle`, { method: 'POST', body: JSON.stringify({ result }) }),
    remove: (id: Bet['id']) => request<{ ok: boolean }>(`/api/bets/${id}`, { method: 'DELETE' }),
    autoSettle: () => request<{ settled: number; checked: number }>('/api/bets/auto-settle', { method: 'POST' })
  }
};
