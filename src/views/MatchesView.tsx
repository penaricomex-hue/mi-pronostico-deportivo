import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Fixture } from '../types';
import { Chips, COMPETITIONS, Crest, Empty, ErrorBox, Spinner, Warnings } from '../components/ui';
import { kickoffTime, localToday } from '../lib/format';
import { AnalysisPanel } from './AnalysisPanel';
import type { BetsApi } from '../hooks/useBets';

export function MatchesView({ bets }: { bets: BetsApi }) {
  const [date, setDate] = useState(localToday());
  const [competition, setCompetition] = useState('');
  const [fixtures, setFixtures] = useState<Fixture[] | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Fixture | null>(null);

  useEffect(() => {
    let alive = true;
    setFixtures(null);
    setError(null);
    setSelected(null);
    api.fixtures(date, competition)
      .then(r => { if (alive) { setFixtures(r.fixtures); setWarnings(r.warnings); } })
      .catch(err => alive && setError((err as Error).message));
    return () => { alive = false; };
  }, [date, competition]);

  return (
    <div className="space-y-4">
      <div className="glass rounded-2xl p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="grid min-w-[15rem] flex-1 grid-cols-3 gap-1 rounded-xl bg-black/30 p-1">
            {[0, 1, 2].map(d => {
              const v = localToday(d);
              const active = date === v;
              return (
                <button key={v} type="button" onClick={() => setDate(v)} aria-pressed={active}
                  className={`rounded-lg px-2 py-2 text-[13px] font-medium transition-colors ${active ? 'bg-panel-2 text-accent shadow-[inset_0_0_0_1px_rgba(255,180,93,0.35)]' : 'text-muted hover:text-text'}`}>
                  {d === 0 ? 'Hoy' : d === 1 ? 'Mañana' : 'Pasado'}
                </button>
              );
            })}
          </div>
          <label className="sr-only" htmlFor="date">Fecha</label>
          <input id="date" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)}
            className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-text sm:w-auto" />
        </div>
        <div className="mt-3">
          <Chips options={COMPETITIONS.map(c => ({ value: c.code, label: c.name }))} value={competition} onChange={setCompetition} />
        </div>
      </div>

      <ErrorBox error={error} />
      <Warnings items={warnings} />

      {selected && <AnalysisPanel fixture={selected} date={date} onClose={() => setSelected(null)} bets={bets} />}

      {!fixtures && !error && <Spinner label="Cargando partidos…" />}
      {fixtures && fixtures.length === 0 && <Empty>No hay partidos para esta fecha y competición. Prueba con otro día u otra liga.</Empty>}

      {fixtures && fixtures.length > 0 && (
        <ul className="grid gap-3 md:grid-cols-2">
          {fixtures.map(f => {
            const active = selected?.id === f.id;
            return (
              <li key={f.id}>
                <button type="button" onClick={() => { setSelected(f); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                  className={`glass group grid w-full grid-cols-[4.25rem_1fr_auto] items-center gap-4 rounded-2xl px-4 py-4 text-left transition hover:border-accent/40 ${active ? 'border-accent/60' : ''}`}>
                  <span className="flex flex-col items-center justify-center rounded-xl bg-black/35 py-2">
                    <span className="font-display text-xl font-semibold leading-none tabular-nums">
                      {f.status === 'FINISHED' && f.score ? 'FT' : kickoffTime(f.kickoff).split(' ')[0]}
                    </span>
                    <span className="mt-1 text-[10px] uppercase tracking-wide text-muted">
                      {f.status === 'FINISHED' && f.score ? f.competitionCode : (kickoffTime(f.kickoff).split(' ').slice(1).join(' ') || f.competitionCode)}
                    </span>
                  </span>
                  <span className="min-w-0 space-y-2">
                    <span className="flex items-center gap-2.5 text-[15px] font-medium"><Crest src={f.homeCrest} name={f.home} size={26} /><span className="truncate">{f.home}</span></span>
                    <span className="flex items-center gap-2.5 text-[15px] font-medium"><Crest src={f.awayCrest} name={f.away} size={26} /><span className="truncate">{f.away}</span></span>
                  </span>
                  <span className="text-right">
                    {f.score ? (
                      <span className="font-display flex flex-col text-2xl font-bold leading-tight tabular-nums">
                        <span>{f.score.home}</span><span>{f.score.away}</span>
                      </span>
                    ) : (
                      <span className="rounded-full border border-accent/30 px-2.5 py-1 text-[11px] font-medium text-accent transition group-hover:bg-accent group-hover:text-ink">Analizar</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
