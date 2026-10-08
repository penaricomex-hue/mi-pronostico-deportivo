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
      <div className="flex flex-wrap items-center gap-2">
        {[0, 1, 2].map(d => {
          const v = localToday(d);
          return (
            <button key={v} type="button" onClick={() => setDate(v)}
              className={`rounded-lg border px-3 py-1.5 text-xs ${date === v ? 'border-accent text-accent' : 'border-line text-muted hover:text-text'}`}>
              {d === 0 ? 'Hoy' : d === 1 ? 'Mañana' : 'Pasado mañana'}
            </button>
          );
        })}
        <label className="sr-only" htmlFor="date">Fecha</label>
        <input id="date" type="date" value={date} onChange={e => e.target.value && setDate(e.target.value)}
          className="rounded-lg border border-line bg-panel px-2 py-1.5 text-xs text-text" />
      </div>

      <Chips options={COMPETITIONS.map(c => ({ value: c.code, label: c.name }))} value={competition} onChange={setCompetition} />

      <ErrorBox error={error} />
      <Warnings items={warnings} />

      {selected && <AnalysisPanel fixture={selected} date={date} onClose={() => setSelected(null)} bets={bets} />}

      {!fixtures && !error && <Spinner label="Cargando partidos…" />}
      {fixtures && fixtures.length === 0 && <Empty>No hay partidos para esta fecha y competición.</Empty>}

      {fixtures && fixtures.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
          {fixtures.map(f => (
            <li key={f.id}>
              <button type="button" onClick={() => setSelected(f)}
                className={`grid w-full grid-cols-[3.5rem_1fr_auto] items-center gap-3 px-4 py-3 text-left hover:bg-ink/50 ${selected?.id === f.id ? 'bg-ink/60' : ''}`}>
                <span className="text-xs tabular-nums text-muted">{f.status === 'FINISHED' && f.score ? 'Final' : kickoffTime(f.kickoff)}</span>
                <span className="min-w-0 space-y-1">
                  <span className="flex items-center gap-2 text-sm"><Crest src={f.homeCrest} name={f.home} size={20} /><span className="truncate">{f.home}</span></span>
                  <span className="flex items-center gap-2 text-sm"><Crest src={f.awayCrest} name={f.away} size={20} /><span className="truncate">{f.away}</span></span>
                </span>
                <span className="text-right text-[11px] text-muted">
                  {f.score ? <span className="text-sm font-semibold text-text tabular-nums">{f.score.home}-{f.score.away}</span> : f.competition}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
