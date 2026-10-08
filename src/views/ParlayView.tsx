import { useState } from 'react';
import { api } from '../api';
import type { Parlay } from '../types';
import { Badge, Card, Chips, COMPETITIONS, Empty, ErrorBox, Spinner, Warnings } from '../components/ui';
import { kickoffDate, money, odds, pct, signedPct } from '../lib/format';
import type { BetsApi } from '../hooks/useBets';

export function ParlayView({ bets, currency }: { bets: BetsApi; currency: string }) {
  const [competition, setCompetition] = useState('');
  const [legs, setLegs] = useState('3');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.parlays>> | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.parlays(competition, Number(legs)));
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
          Combina solo selecciones que el motor de valor recomendó (EV ≥ 5%, cuota 1.50–4.00, cerca del mercado),
          de partidos distintos. La probabilidad combinada supone independencia entre partidos. Las combinadas no
          cuentan para el límite de 3 señales por jornada ni para el panel de rendimiento.
        </p>
        <div className="space-y-3">
          <Chips options={COMPETITIONS.map(c => ({ value: c.code, label: c.name }))} value={competition} onChange={setCompetition} />
          <div className="flex flex-wrap items-center gap-3">
            <Chips options={[{ value: '2', label: 'Dobles' }, { value: '3', label: 'Hasta 3' }, { value: '4', label: 'Hasta 4' }]} value={legs} onChange={setLegs} />
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
            <Empty>No hay combinadas: hacen falta al menos 2 selecciones recomendadas de partidos distintos ({result.candidates} disponibles).</Empty>
          ) : (
            <div className="space-y-3">
              {result.parlays.map(p => (
                <Card key={p.id}>
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex gap-2">
                      <Badge tone="accent">{p.legs.length} patas</Badge>
                      <Badge tone="warn">Riesgo alto</Badge>
                    </div>
                    <div className="text-xs text-muted tabular-nums">
                      Cuota {odds(p.combinedOdds)} · Prob. {pct(p.combinedProbability)} · EV <span className="text-good">{signedPct(p.ev)}</span>
                    </div>
                  </div>
                  <ul className="space-y-1.5 text-sm">
                    {p.legs.map(l => (
                      <li key={`${l.fixtureId}:${l.selection}`} className="flex justify-between gap-2">
                        <span className="min-w-0 truncate">{l.home} vs {l.away} <span className="text-muted">· {kickoffDate(l.kickoff)}</span></span>
                        <span className="shrink-0 tabular-nums">{l.label} @ {odds(l.executionOdds)}</span>
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
