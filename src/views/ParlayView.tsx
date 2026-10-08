import { useState } from 'react';
import { api } from '../api';
import type { Parlay } from '../types';
import { Badge, Card, Chips, COMPETITIONS, Empty, ErrorBox, Spinner, Warnings } from '../components/ui';
import { kickoffDate, money, odds, pct, signedPct } from '../lib/format';
import type { BetsApi } from '../hooks/useBets';

export function ParlayView({ bets, currency }: { bets: BetsApi; currency: string }) {
  const [competition, setCompetition] = useState('');
  const [legs, setLegs] = useState('3');
  const [includeUnvalidated, setIncludeUnvalidated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.parlays>> | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.parlays(competition, Number(legs), includeUnvalidated));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const save = async (p: Parlay) => {
    try {
      const stake = p.suggestedStake > 0 ? p.suggestedStake : p.legs[0].flatStake / 2;
      await bets.addParlay(p, stake);
      setSaved(s => new Set(s).add(p.id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-3 text-sm text-muted">
          Combina selecciones con valor de partidos distintos. Las cuotas atípicas nunca entran en una combinada.
          La probabilidad combinada supone que los partidos son independientes.
        </p>
        <div className="space-y-3">
          <Chips options={COMPETITIONS.filter(c => c.code !== 'EL').map(c => ({ value: c.code, label: c.name }))} value={competition} onChange={setCompetition} />
          <div className="flex flex-wrap items-center gap-3">
            <Chips options={[{ value: '2', label: 'Dobles' }, { value: '3', label: 'Hasta 3' }, { value: '4', label: 'Hasta 4' }]} value={legs} onChange={setLegs} />
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={includeUnvalidated} onChange={e => setIncludeUnvalidated(e.target.checked)} />
              Incluir ligas no validadas (riesgo alto)
            </label>
            <button type="button" onClick={load} disabled={loading} className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60">
              {loading ? 'Calculando…' : 'Generar combinadas'}
            </button>
          </div>
        </div>
      </Card>

      <ErrorBox error={error} />
      {loading && <Spinner label="Analizando partidos…" />}
      {result && !loading && (
        <>
          <Warnings items={result.warnings} />
          {result.parlays.length === 0 ? (
            <Empty>No hay combinadas con EV positivo ({result.candidates} selecciones candidatas).</Empty>
          ) : (
            <div className="space-y-3">
              {result.parlays.map(p => (
                <Card key={p.id}>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex gap-2">
                      <Badge tone="accent">{p.legs.length} patas</Badge>
                      {p.validated ? <Badge tone="good">Validada</Badge> : <Badge tone="warn">Incluye ligas no validadas</Badge>}
                    </div>
                    <div className="text-xs text-muted tabular-nums">
                      Cuota {odds(p.combinedOdds)} · Prob. {pct(p.combinedProbability)} · EV <span className="text-good">{signedPct(p.ev)}</span>
                    </div>
                  </div>
                  <ul className="space-y-1.5 text-sm">
                    {p.legs.map(l => (
                      <li key={`${l.fixtureId}:${l.selection}`} className="flex justify-between gap-2">
                        <span className="min-w-0 truncate">{l.home} vs {l.away} <span className="text-muted">· {kickoffDate(l.kickoff)}</span></span>
                        <span className="shrink-0 tabular-nums">{l.label} @ {odds(l.bestOdds)}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex items-center justify-between text-xs">
                    <span className="text-muted">Stake sugerido: <span className="text-text">{money(p.suggestedStake > 0 ? p.suggestedStake : p.legs[0].flatStake / 2, currency)}</span></span>
                    <button type="button" onClick={() => save(p)} disabled={saved.has(p.id)} className="text-accent hover:underline disabled:text-muted">
                      {saved.has(p.id) ? 'Guardada' : 'Simular combinada'}
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
