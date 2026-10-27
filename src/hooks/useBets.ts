import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { Bet, BetStatus, Pick, Parlay } from '../types';

const LOCAL_KEY = 'mkbets_v10_bets';

function readLocal(): Bet[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? (JSON.parse(raw) as Bet[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(bets: Bet[]) {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(bets));
}

function profitFor(status: BetStatus, stake: number, odds: number) {
  if (status === 'won') return Number((stake * (odds - 1)).toFixed(2));
  if (status === 'half_won') return Number((stake * (odds - 1) / 2).toFixed(2));
  if (status === 'lost') return -stake;
  if (status === 'half_lost') return Number((-stake / 2).toFixed(2));
  return status === 'void' ? 0 : null;
}

/**
 * Apuestas simuladas: en el servidor (PostgreSQL) si está configurado; si no,
 * en este navegador (sin liquidación automática).
 */
export function useBets(currency: string) {
  const [bets, setBets] = useState<Bet[]>([]);
  const [mode, setMode] = useState<'server' | 'local' | 'loading'>('loading');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { bets: list } = await api.bets.list();
      setBets(list);
      setMode('server');
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setBets(readLocal());
        setMode('local');
      } else {
        setError((err as Error).message);
        setMode(m => (m === 'loading' ? 'local' : m));
        setBets(readLocal());
      }
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const addPick = useCallback(async (p: Pick, stake: number) => {
    const body = {
      fixtureId: p.fixtureId, competition: p.competitionCode, kickoff: p.kickoff, home: p.home, away: p.away,
      selection: p.selection, odds: p.executionOdds, probability: p.probability, stake,
      line: p.line ?? null, bookmaker: p.executionBookmaker
    };
    if (mode === 'server') {
      await api.bets.create(body);
      return refresh();
    }
    const bet: Bet = {
      id: `local-${Date.now()}`, createdAt: new Date().toISOString(), matchDate: p.kickoff.slice(0, 10), kickoff: p.kickoff,
      fixtureId: p.fixtureId, home: p.home, away: p.away, competition: p.competitionCode, market: p.market,
      selection: p.selection, label: p.label, odds: p.executionOdds, probability: p.probability, stake, currency, line: p.line, bookmaker: p.executionBookmaker,
      status: 'pending', profit: null, settledAt: null, score: null, closingOdds: null, clvPct: null, legs: null
    };
    const next = [bet, ...readLocal()];
    writeLocal(next);
    setBets(next);
  }, [mode, refresh, currency]);

  const addManual = useCallback(async (input: {
    fixtureId?: string | null; competition: string; kickoff: string; home: string; away: string;
    selection: string; odds: number; stake: number; line?: number | null; reason: string; tags: string[];
  }) => {
    const body = { ...input, source: 'manual' };
    if (mode === 'server') {
      await api.bets.create(body);
      return refresh();
    }
    const bet: Bet = {
      id: `local-${Date.now()}`, createdAt: new Date().toISOString(), matchDate: input.kickoff.slice(0, 10), kickoff: input.kickoff,
      fixtureId: input.fixtureId || null, home: input.home, away: input.away, competition: input.competition, market: '1x2',
      selection: input.selection as Bet['selection'], label: input.selection, odds: input.odds, probability: null, stake: input.stake, currency,
      status: 'pending', profit: null, settledAt: null, score: null, closingOdds: null, clvPct: null, legs: null,
      source: 'manual', reason: input.reason, tags: input.tags
    };
    const next = [bet, ...readLocal()];
    writeLocal(next);
    setBets(next);
  }, [mode, refresh, currency]);

  const addParlay = useCallback(async (parlay: Parlay, stake: number) => {
    const first = parlay.legs[0];
    const body = {
      competition: first.competitionCode, kickoff: parlay.legs.map(l => l.kickoff).sort()[0],
      home: parlay.legs.map(l => l.home).join(' + '), away: parlay.legs.map(l => l.away).join(' + '),
      selection: 'parlay', odds: parlay.combinedOdds, probability: parlay.combinedProbability, stake,
      legs: parlay.legs.map(l => ({
        fixtureId: l.fixtureId, competition: l.competitionCode, kickoff: l.kickoff, home: l.home, away: l.away,
        selection: l.selection, odds: l.executionOdds, label: l.label, line: l.line
      }))
    };
    if (mode === 'server') {
      await api.bets.create(body);
      return refresh();
    }
    const bet: Bet = {
      id: `local-${Date.now()}`, createdAt: new Date().toISOString(), matchDate: body.kickoff.slice(0, 10), kickoff: body.kickoff,
      fixtureId: null, home: body.home, away: body.away, competition: body.competition, market: 'parlay',
      selection: 'parlay', label: `Combinada (${parlay.legs.length} patas)`, odds: parlay.combinedOdds,
      probability: parlay.combinedProbability, stake, currency, status: 'pending', profit: null, settledAt: null,
      score: null, closingOdds: null, clvPct: null, legs: parlay.legs
    };
    const next = [bet, ...readLocal()];
    writeLocal(next);
    setBets(next);
  }, [mode, refresh, currency]);

  const settle = useCallback(async (id: Bet['id'], status: BetStatus) => {
    if (mode === 'server') {
      await api.bets.settle(id, status);
      return refresh();
    }
    const next = readLocal().map(b => (b.id === id ? { ...b, status, profit: profitFor(status, b.stake, b.odds), settledAt: new Date().toISOString() } : b));
    writeLocal(next);
    setBets(next);
  }, [mode, refresh]);

  const remove = useCallback(async (id: Bet['id']) => {
    if (mode === 'server') {
      await api.bets.remove(id);
      return refresh();
    }
    const next = readLocal().filter(b => b.id !== id);
    writeLocal(next);
    setBets(next);
  }, [mode, refresh]);

  const autoSettle = useCallback(async () => {
    if (mode !== 'server') return { settled: 0, checked: 0 };
    const r = await api.bets.autoSettle();
    await refresh();
    return r;
  }, [mode, refresh]);

  return { bets, mode, error, refresh, addPick, addParlay, addManual, settle, remove, autoSettle };
}

export type BetsApi = ReturnType<typeof useBets>;
