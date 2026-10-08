import { useEffect, useState } from 'react';
import { Activity, BarChart3, Calendar, Layers, Settings, Wallet } from 'lucide-react';
import { api } from './api';
import type { Status } from './types';
import { useBets } from './hooks/useBets';
import { MatchesView } from './views/MatchesView';
import { ValueView } from './views/ValueView';
import { ParlayView } from './views/ParlayView';
import { BacktestView } from './views/BacktestView';
import { BetsView } from './views/BetsView';
import { StatusView } from './views/StatusView';

type Tab = 'matches' | 'value' | 'parlay' | 'bets' | 'backtest' | 'status';

const TABS: Array<{ id: Tab; label: string; icon: typeof Calendar }> = [
  { id: 'matches', label: 'Partidos', icon: Calendar },
  { id: 'value', label: 'Valor', icon: Activity },
  { id: 'parlay', label: 'Combinadas', icon: Layers },
  { id: 'bets', label: 'Mis apuestas', icon: Wallet },
  { id: 'backtest', label: 'Backtest', icon: BarChart3 },
  { id: 'status', label: 'Estado', icon: Settings }
];

function Logo() {
  return (
    <svg viewBox="0 0 130 90" className="h-7 w-10" aria-hidden>
      <polyline points="10,80 10,10 45,55 80,10 80,80" fill="none" stroke="currentColor" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="80" y1="45" x2="118" y2="8" stroke="currentColor" strokeWidth="11" strokeLinecap="round" />
      <line x1="80" y1="45" x2="118" y2="82" stroke="currentColor" strokeWidth="11" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') as Tab) || 'matches');
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    api.status().then(setStatus).catch(err => setStatusError((err as Error).message));
  }, []);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('tab', tab);
    history.replaceState(null, '', url);
  }, [tab]);

  const currency = status?.config.currency || 'MXN';
  const bets = useBets(currency);

  return (
    <div className="min-h-screen pb-16">
      <header className="sticky top-0 z-10 border-b border-line bg-ink/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <span className="text-accent"><Logo /></span>
          <div className="min-w-0">
            <h1 className="text-base font-semibold leading-tight">MK Bets</h1>
            <p className="text-[11px] text-muted">Pronósticos con modelo Dixon-Coles y cuotas reales{status ? ` · ${status.modelVersion}` : ''}</p>
          </div>
        </div>
        <nav className="mx-auto max-w-4xl overflow-x-auto px-2" aria-label="Secciones">
          <ul className="flex min-w-max">
            {TABS.map(t => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <li key={t.id}>
                  <button type="button" onClick={() => setTab(t.id)} aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm ${active ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}`}>
                    <Icon className="h-4 w-4" aria-hidden />
                    {t.label}
                    {t.id === 'bets' && bets.bets.some(b => b.status === 'pending') && (
                      <span className="rounded-full bg-line px-1.5 text-[10px] text-text">{bets.bets.filter(b => b.status === 'pending').length}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      <main className="mx-auto max-w-4xl px-4 pt-4">
        {tab === 'matches' && <MatchesView bets={bets} />}
        {tab === 'value' && <ValueView bets={bets} currency={currency} />}
        {tab === 'parlay' && <ParlayView bets={bets} currency={currency} />}
        {tab === 'bets' && <BetsView bets={bets} currency={currency} />}
        {tab === 'backtest' && <BacktestView />}
        {tab === 'status' && <StatusView status={status} error={statusError} />}
      </main>
    </div>
  );
}
