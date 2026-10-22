import { useCallback, useState } from 'react';
import { api } from '../api';
import type { Pick } from '../types';
import { Badge, Card, Chips, COMPETITIONS, Crest, Empty, ErrorBox, Spinner, Warnings } from '../components/ui';
import { kickoffDate, kickoffTime, money, odds, pct, signedPct } from '../lib/format';
import type { BetsApi } from '../hooks/useBets';

export function CalibrationNote({ message }: { message?: string | null }) {
  if (!message) return null;
  return <p className="rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2 text-[11px] leading-relaxed text-muted">{message}</p>;
}

function PickCard({ p, currency, onSave, saved, nearMiss }: { p: Pick; currency: string; onSave: () => void; saved: boolean; nearMiss?: boolean }) {
  const stake = p.suggestedStake > 0 ? p.suggestedStake : p.flatStake;
  return (
    <Card className={nearMiss ? 'border-warn/30 opacity-90' : ''}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
        <span>{p.competition} · {kickoffDate(p.kickoff)} {kickoffTime(p.kickoff)}</span>
        <div className="flex gap-1.5">
          {nearMiss ? <Badge tone="warn">No recomendada</Badge> : <Badge tone="good">Apuesta con valor</Badge>}
          {p.alreadySignaled && <Badge tone="accent">Señal registrada</Badge>}
        </div>
      </div>
      <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <Crest src={p.homeCrest} name={p.home} size={20} /> {p.home}
        <span className="text-muted">vs</span>
        <Crest src={p.awayCrest} name={p.away} size={20} /> {p.away}
      </div>
      <div className="mb-2 text-sm font-semibold text-accent">{p.label}</div>
      <div className="grid grid-cols-4 gap-2 text-center text-xs">
        <div><div className="text-muted">Prob. decisión</div><div className="font-semibold tabular-nums">{pct(p.probability)}</div><div className="text-[10px] text-muted">calibrada {pct(p.calibratedProbability)}</div></div>
        <div><div className="text-muted">Mercado</div><div className="font-semibold tabular-nums">{pct(p.marketProbability)}</div><div className="text-[10px] text-muted">dif. {signedPct(p.marketGap)}</div></div>
        <div><div className="text-muted">Cuota</div><div className="font-semibold tabular-nums">{odds(p.executionOdds)}</div><div className="truncate text-[10px] text-muted">{p.executionBookmaker}</div></div>
        <div><div className="text-muted">EV</div><div className={`font-semibold tabular-nums ${p.ev > 0 ? 'text-good' : 'text-muted'}`}>{signedPct(p.ev)}</div><div className="text-[10px] text-muted">mín. {odds(p.minimumOdds)}</div></div>
      </div>
      <p className={`mt-3 text-[11px] ${nearMiss ? 'text-warn' : 'text-good'}`}>{p.reason}</p>
      {p.blend?.message && <p className="mt-2 text-[11px] text-muted">{p.blend.message}</p>}
      {p.calibration?.message && <div className="mt-2"><CalibrationNote message={p.calibration.message} /></div>}
      {!nearMiss && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <span className="text-muted">Stake {p.suggestedStake > 0 ? 'Kelly fraccional' : 'plano'}: <span className="text-text">{money(stake, currency)}</span></span>
          <button type="button" onClick={onSave} disabled={saved} className="text-accent hover:underline disabled:text-muted">
            {saved ? 'Guardada' : 'Registrar en Mis apuestas'}
          </button>
        </div>
      )}
    </Card>
  );
}

export function ValueView({ bets, currency }: { bets: BetsApi; currency: string }) {
  const [competition, setCompetition] = useState('');
  const [days, setDays] = useState('3');
  const [showNear, setShowNear] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.valueBets>> | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.valueBets(competition, Number(days), showNear));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [competition, days, showNear]);

  const save = async (p: Pick) => {
    try {
      await bets.addPick(p, p.suggestedStake > 0 ? p.suggestedStake : p.flatStake);
      setSaved(s => new Set(s).add(`${p.fixtureId}:${p.selection}`));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const r = result?.rules;

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-3 text-sm text-muted">
          LaLiga y Champions. Una apuesta solo se recomienda si el EV es de al menos {r ? Math.round(r.minEv * 100) : 5}%,
          la probabilidad calibrada no se aleja más de {r ? Math.round(r.maxMarketGap * 100) : 10} puntos del mercado sin margen,
          la cuota está entre {r ? r.minOdds.toFixed(2) : '1.50'} y {r ? r.maxOdds.toFixed(2) : '4.00'} y hay al menos {r?.minBookmakers ?? 3} casas.
          Máximo {r?.maxBetsPerJornada ?? 3} señales por jornada. Cada recomendación se registra automáticamente en el panel de rendimiento (paper trading).
        </p>
        <div className="space-y-3">
          <Chips options={COMPETITIONS.map(c => ({ value: c.code, label: c.name }))} value={competition} onChange={setCompetition} />
          <div className="flex flex-wrap items-center gap-3">
            <Chips options={[{ value: '1', label: 'Hoy' }, { value: '3', label: '3 días' }, { value: '5', label: '5 días' }]} value={days} onChange={setDays} />
            <label className="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" checked={showNear} onChange={e => setShowNear(e.target.checked)} />
              Ver también EV positivo bloqueado por las reglas
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
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
            <span>{result.analyzed} partidos analizados · {result.withOdds} con cuotas · {result.picks.length} recomendadas</span>
            {result.recorded > 0 && <span className="text-accent">{result.recorded} señales nuevas registradas</span>}
            <span>Cuota de ejecución: {result.execution.mode === 'fixed' ? result.execution.bookmaker : 'mejor cuota no atípica'}</span>
          </div>
          <Warnings items={result.warnings} />
          {result.picks.length === 0 ? (
            <Empty>Ninguna selección cumple todas las reglas. Es normal: el sistema prefiere no apostar a apostar sin ventaja.</Empty>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {result.picks.map(p => (
                <PickCard key={`${p.fixtureId}:${p.selection}`} p={p} currency={currency} onSave={() => save(p)} saved={saved.has(`${p.fixtureId}:${p.selection}`)} />
              ))}
            </div>
          )}
          {showNear && result.nearMisses.length > 0 && (
            <>
              <h3 className="pt-2 text-sm font-semibold text-muted">EV positivo, bloqueadas por las reglas</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {result.nearMisses.map(p => (
                  <PickCard key={`near:${p.fixtureId}:${p.selection}`} p={p} currency={currency} onSave={() => {}} saved nearMiss />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
