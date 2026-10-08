import { useCallback, useState } from 'react';
import { api } from '../api';
import type { Pick } from '../types';
import { Badge, Card, Chips, COMPETITIONS, Crest, Empty, ErrorBox, Spinner, Warnings } from '../components/ui';
import { kickoffDate, kickoffTime, money, odds, pct, signedPct } from '../lib/format';
import type { BetsApi } from '../hooks/useBets';

function PickCard({ p, currency, onSave, saved }: { p: Pick; currency: string; onSave: () => void; saved: boolean }) {
  const stake = p.suggestedStake > 0 ? p.suggestedStake : p.flatStake;
  return (
    <Card className={p.validated ? '' : 'border-warn/40'}>
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{p.competition} · {kickoffDate(p.kickoff)} {kickoffTime(p.kickoff)}</span>
        {p.validated ? <Badge tone="good">Validado</Badge> : <Badge tone="warn">Liga no validada</Badge>}
      </div>
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Crest src={p.homeCrest} name={p.home} size={20} /> {p.home}
        <span className="text-muted">vs</span>
        <Crest src={p.awayCrest} name={p.away} size={20} /> {p.away}
      </div>
      <div className="grid grid-cols-4 gap-2 text-center text-xs">
        <div><div className="text-muted">Selección</div><div className="font-semibold">{p.label}</div></div>
        <div><div className="text-muted">Prob.</div><div className="font-semibold tabular-nums">{pct(p.probability)}</div></div>
        <div><div className="text-muted">Cuota</div><div className="font-semibold tabular-nums">{odds(p.bestOdds)}</div><div className="text-[10px] text-muted">{p.bestBookmaker}</div></div>
        <div><div className="text-muted">EV</div><div className="font-semibold text-good tabular-nums">{signedPct(p.ev)}</div></div>
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-muted">Stake {p.suggestedStake > 0 ? 'Kelly fraccional' : 'plano'}: <span className="text-text">{money(stake, currency)}</span></span>
        <button type="button" onClick={onSave} disabled={saved} className="text-accent hover:underline disabled:text-muted">
          {saved ? 'Guardada' : 'Simular apuesta'}
        </button>
      </div>
    </Card>
  );
}

export function ValueView({ bets, currency }: { bets: BetsApi; currency: string }) {
  const [competition, setCompetition] = useState('');
  const [days, setDays] = useState('3');
  const [includeUnvalidated, setIncludeUnvalidated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.valueBets>> | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.valueBets(competition, Number(days), includeUnvalidated));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [competition, days, includeUnvalidated]);

  const save = async (p: Pick) => {
    try {
      await bets.addPick(p, p.suggestedStake > 0 ? p.suggestedStake : p.flatStake);
      setSaved(s => new Set(s).add(`${p.fixtureId}:${p.selection}`));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const all = result ? [...result.picks, ...(includeUnvalidated ? result.unvalidatedPicks : [])] : [];

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-3 text-sm text-muted">
          Busca selecciones donde la mejor cuota disponible supera a la probabilidad estimada, con al menos 3 casas,
          sin cuotas atípicas y solo en ligas cuya ventaja se comprobó en el backtest fuera de muestra.
        </p>
        <div className="space-y-3">
          <Chips options={COMPETITIONS.filter(c => c.code !== 'EL').map(c => ({ value: c.code, label: c.name }))} value={competition} onChange={setCompetition} />
          <div className="flex flex-wrap items-center gap-3">
            <Chips options={[{ value: '1', label: 'Hoy' }, { value: '3', label: '3 días' }, { value: '5', label: '5 días' }]} value={days} onChange={setDays} />
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={includeUnvalidated} onChange={e => setIncludeUnvalidated(e.target.checked)} />
              Mostrar también ligas no validadas (riesgo alto)
            </label>
            <button type="button" onClick={scan} disabled={loading}
              className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60">
              {loading ? 'Analizando…' : 'Buscar valor'}
            </button>
          </div>
        </div>
      </Card>

      <ErrorBox error={error} />
      {loading && <Spinner label="Analizando partidos y cuotas…" />}
      {result && !loading && (
        <>
          <div className="text-xs text-muted">{result.analyzed} partidos analizados · {result.withOdds} con cuotas · {result.picks.length} con valor validado</div>
          <Warnings items={result.warnings} />
          {all.length === 0 ? (
            <Empty>
              No hay selecciones con valor. Es lo esperado: según el backtest, hoy ninguna liga ha demostrado ventaja estable sobre el mercado.
            </Empty>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {all.map(p => (
                <PickCard key={`${p.fixtureId}:${p.selection}`} p={p} currency={currency} onSave={() => save(p)} saved={saved.has(`${p.fixtureId}:${p.selection}`)} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
