import { useEffect, useState } from 'react';
import { Activity, BarChart3, Calendar, LineChart, ShieldCheck, Settings, Wallet } from 'lucide-react';
import { api } from './api';
import type { Status } from './types';
import { useBets } from './hooks/useBets';
import { LogoMark, Wordmark } from './components/Logo';
import { MatchesView } from './views/MatchesView';
import { SignalsView } from './views/SignalsView';
import { PerformanceView } from './views/PerformanceView';
import { BacktestView } from './views/BacktestView';
import { BetsView } from './views/BetsView';
import { StatusView } from './views/StatusView';

type Tab = 'matches' | 'value' | 'performance' | 'bets' | 'backtest' | 'status';

const TABS: Array<{ id: Tab; label: string; short: string; icon: typeof Calendar; title: string; subtitle: string }> = [
  { id: 'matches', label: 'Partidos', short: 'Partidos', icon: Calendar, title: 'Partidos', subtitle: 'Elige un partido para ver probabilidades, cuotas y valor.' },
  { id: 'value', label: 'Señales', short: 'Señales', icon: Activity, title: 'Señales Caliente MX', subtitle: 'Apuestas con EV positivo a la cuota que realmente puedes tomar en Caliente MX.' },
  { id: 'performance', label: 'Rendimiento', short: 'Rendim.', icon: LineChart, title: 'Rendimiento — LaLiga y Champions', subtitle: 'ROI, yield, CLV y calibración de las señales registradas.' },
  { id: 'bets', label: 'Mis apuestas', short: 'Apuestas', icon: Wallet, title: 'Mis apuestas', subtitle: 'Tu registro simulado, resultados y CLV.' },
  { id: 'backtest', label: 'Backtest', short: 'Backtest', icon: BarChart3, title: 'Backtest', subtitle: 'Cómo le habría ido al modelo con partidos reales.' },
  { id: 'status', label: 'Estado', short: 'Estado', icon: Settings, title: 'Estado y equipos', subtitle: 'Conexiones, créditos y fuerza de cada equipo.' }
];

function Hero({ status, compact }: { status: Status | null; compact: boolean }) {
  return (
    <header className="relative isolate overflow-hidden">
      <picture>
        <source media="(min-width: 768px)" srcSet="/img/hero-estadio.webp" />
        <img
          src="/img/hero-movil.webp"
          alt=""
          className="absolute inset-0 -z-10 h-full w-full object-cover object-[50%_72%] md:object-[50%_60%]"
          fetchPriority="high"
        />
      </picture>
      <div className="absolute inset-0 -z-10 bg-gradient-to-b from-ink/30 via-ink/45 to-ink" aria-hidden />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-24 bg-gradient-to-b from-transparent to-ink" aria-hidden />

      <div className="safe-top safe-x">
        <div className={`mx-auto max-w-5xl px-5 ${compact ? 'pb-6 pt-6' : 'pb-10 pt-10 md:pb-16 md:pt-16'}`}>
          <div className="flex items-center gap-4">
            <LogoMark size={compact ? 48 : 72} className="shrink-0 drop-shadow-[0_8px_24px_rgba(255,160,70,0.35)]" />
            <div className="min-w-0">
              <h1><Wordmark className={compact ? 'text-4xl' : 'text-5xl md:text-6xl'} /></h1>
              <p className="mt-1.5 text-[13px] text-text/80 md:text-sm">LaLiga y Champions · modelo calibrado · ejecución en Caliente MX</p>
            </div>
          </div>
          {!compact && (
            <div className="mt-6 flex flex-wrap gap-2 text-[12px]">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-black/35 px-3 py-1.5 text-text/90 backdrop-blur">
                <ShieldCheck className="h-3.5 w-3.5 text-accent" aria-hidden /> Modelo {status?.modelVersion || 'V9'}
              </span>
              <span className="rounded-full border border-white/15 bg-black/35 px-3 py-1.5 text-text/90 backdrop-blur">LaLiga EA Sports · UEFA Champions League</span>
              <span className="rounded-full border border-white/15 bg-black/35 px-3 py-1.5 text-text/90 backdrop-blur">Ejecución en Caliente MX</span>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => (() => { const t = new URLSearchParams(location.search).get('tab') as Tab; return TABS.some(x => x.id === t) ? t : 'matches'; })());
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  useEffect(() => {
    api.status().then(setStatus).catch(err => setStatusError((err as Error).message));
  }, []);

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('tab', tab);
    history.replaceState(null, '', url);
    window.scrollTo({ top: 0 });
  }, [tab]);

  const currency = status?.config.currency || 'MXN';
  const bets = useBets(currency);
  const pending = bets.bets.filter(b => b.status === 'pending').length;
  const current = TABS.find(t => t.id === tab)!;

  return (
    <div className="min-h-dvh">
      <div className="app-backdrop" aria-hidden />
      <Hero status={status} compact={tab !== 'matches'} />

      {/* Pestañas en escritorio */}
      <nav className="sticky top-0 z-20 hidden border-b border-white/[0.06] bg-ink/80 backdrop-blur-xl md:block" aria-label="Secciones">
        <ul className="mx-auto flex max-w-5xl gap-1 px-4">
          {TABS.map(t => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <li key={t.id}>
                <button type="button" onClick={() => setTab(t.id)} aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2 border-b-2 px-4 py-3.5 text-sm font-medium transition-colors ${active ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}`}>
                  <Icon className="h-4 w-4" aria-hidden />
                  {t.label}
                  {t.id === 'bets' && pending > 0 && <span className="rounded-full bg-accent/15 px-1.5 text-[11px] text-accent">{pending}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="safe-x"><main className="mx-auto max-w-5xl px-5 pb-32 pt-2 md:pb-16 md:pt-8">
        <div className="mb-5 px-1">
          <h2 className="font-display text-3xl font-bold uppercase tracking-wide md:text-4xl">{current.title}</h2>
          <p className="mt-1 text-sm text-muted">{current.subtitle}</p>
        </div>
        <div key={tab} className="fade-in">
          {tab === 'matches' && <MatchesView bets={bets} />}
          {tab === 'value' && <SignalsView currency={currency} />}
          {tab === 'performance' && <PerformanceView />}
          {tab === 'bets' && <BetsView bets={bets} currency={currency} />}
          {tab === 'backtest' && <BacktestView />}
          {tab === 'status' && <StatusView status={status} error={statusError} />}
        </div>
        <p className="mt-10 text-center text-[11px] text-muted/70">Análisis estadístico, no garantiza resultados. Apuesta con responsabilidad. +18</p>
      </main></div>

      {/* Barra inferior en móvil */}
      <nav className="safe-bottom safe-x fixed inset-x-0 bottom-0 z-30 border-t border-white/[0.08] bg-ink/85 backdrop-blur-xl md:hidden" aria-label="Secciones">
        <ul className="grid grid-cols-6">
          {TABS.map(t => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <li key={t.id}>
                <button type="button" onClick={() => setTab(t.id)} aria-current={active ? 'page' : undefined}
                  className={`relative flex w-full flex-col items-center gap-1 px-1 pb-2.5 pt-3 text-[10.5px] font-medium ${active ? 'text-accent' : 'text-muted'}`}>
                  {active && <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-accent" aria-hidden />}
                  <span className="relative">
                    <Icon className="h-5 w-5" aria-hidden />
                    {t.id === 'bets' && pending > 0 && (
                      <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-accent px-1 text-center text-[9px] font-bold leading-4 text-ink">{pending}</span>
                    )}
                  </span>
                  {t.short}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
