import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { Bet, BetStatus, Pick, Parlay } from '../types';

const LOCAL_KEY = 'mkbets_v9_bets';

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
  if (status === 'lost') return -stake;
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
      selection: p.selection, odds: p.bestOdds, probability: p.probability, stake
    };
    if (mode === 'server') {
      await api.bets.create(body);
      return refresh();
    }
    const bet: Bet = {
      id: `local-${Date.now()}`, createdAt: new Date().toISOString(), matchDate: p.kickoff.slice(0, 10), kickoff: p.kickoff,
      fixtureId: p.fixtureId, home: p.home, away: p.away, competition: p.competitionCode, market: p.market,
      selection: p.selection, label: p.label, odds: p.bestOdds, probability: p.probability, stake, currency,
      status: 'pending', profit: null, settledAt: null, score: null, closingOdds: null, clvPct: null, legs: null
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
        selection: l.selection, odds: l.bestOdds, label: l.label
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

  return { bets, mode, error, refresh, addPick, addParlay, settle, remove, autoSettle };
}

export type BetsApi = ReturnType<typeof useBets>;
