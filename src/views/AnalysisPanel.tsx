import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import type { Analysis, EngineSelection, Fixture } from '../types';
import { Badge, Card, Crest, ErrorBox, Spinner, Warnings } from '../components/ui';
import { kickoffDate, kickoffTime, money, odds, pct, signedPct } from '../lib/format';
import type { BetsApi } from '../hooks/useBets';

const MARKET_ORDER = ['1x2', 'double_chance', 'over_under', 'btts', 'asian_handicap'] as const;

/** Solo líneas de hándicap con mercado suficiente o con cuota de Caliente. */
function visible(e: EngineSelection) {
  if (e.market !== 'asian_handicap') return true;
  return e.marketBooks >= 3 || Boolean(e.caliente);
}

function localDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function EngineTable({ data, onSaved }: { data: Analysis; onSaved: () => void }) {
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const rows = useMemo(() => data.engine.filter(visible), [data]);
  const started = new Date(data.kickoff).getTime() <= Date.now();

  const save = async () => {
    const entries = Object.entries(inputs)
      .map(([selection, v]) => ({ selection, odds: Number(String(v).replace(',', '.')) }))
      .filter(e => e.odds > 1);
    if (!entries.length) { setMsg('Escribe al menos una cuota de Caliente MX mayor que 1.'); return; }
    setBusy(true);
    setMsg(null);
    try {
      await api.caliente.save({ fixtureId: data.id, date: localDate(data.kickoff), competition: data.competitionCode, entries });
      setInputs({});
      setMsg(`${entries.length} cuota(s) de Caliente MX guardadas con la hora de captura.`);
      onSaved();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {MARKET_ORDER.map(m => {
        const list = rows.filter(r => r.market === m);
        if (!list.length) return null;
        return (
          <div key={m} className="overflow-x-auto">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{list[0].marketLabel}</div>
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                  <th className="py-2 font-medium">Selección</th>
                  <th className="whitespace-nowrap py-2 pl-3 text-right font-medium" title="Probabilidad original → calibrada">Modelo</th>
                  <th className="whitespace-nowrap py-2 pl-3 text-right font-medium" title="Consenso sin margen (sin Caliente)">Mercado</th>
                  <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Cuota media</th>
                  <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Caliente MX</th>
                  <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">EV</th>
                  <th className="py-2 pl-3 font-medium">Estado</th>
                </tr>
              </thead>
              <tbody>
                {list.map(e => (
                  <tr key={e.selection} className={`border-b border-line/60 align-top ${e.recommended ? 'bg-good/[0.06]' : ''}`}>
                    <td className="py-2 pr-2">
                      <div className="whitespace-nowrap">{e.label}</div>
                      {e.calibration && e.calibration.method !== 'identity' && Math.abs(e.calibration.raw - e.calibration.calibrated) >= 0.01 && (
                        <div className="max-w-[260px] text-[10px] leading-snug text-muted">{e.calibration.text}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">
                      {pct(e.modelProbability)}
                      {e.modelRaw != null && e.modelProbability != null && Math.abs(e.modelRaw - e.modelProbability) >= 0.005 && (
                        <div className="text-[10px] text-muted">orig. {pct(e.modelRaw)}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">
                      {pct(e.marketProbability)}
                      {e.marketBooks > 0 && <div className="text-[10px] text-muted">{e.marketBooks} casas</div>}
                    </td>
                    <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{odds(e.marketAvgOdds)}</td>
                    <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">
                      {e.caliente?.odds ? (
                        <div>
                          <span className="font-semibold">{odds(e.caliente.odds)}</span>
                          <div className="text-[10px] text-muted">
                            {e.caliente.capturedAt ? new Date(e.caliente.capturedAt).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}
                            {e.caliente.opening && e.caliente.opening !== e.caliente.odds ? ` · apertura ${odds(e.caliente.opening)}` : ''}
                          </div>
                        </div>
                      ) : null}
                      {!started && (
                        <input
                          inputMode="decimal"
                          aria-label={`Cuota de Caliente MX para ${e.label}`}
                          placeholder={e.minCalienteOdds ? `≥ ${odds(e.minCalienteOdds)}` : 'cuota'}
                          value={inputs[e.selection] ?? ''}
                          onChange={ev => setInputs(s => ({ ...s, [e.selection]: ev.target.value }))}
                          className="mt-1 w-20 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-right text-sm tabular-nums focus:border-accent focus:outline-none"
                        />
                      )}
                    </td>
                    <td className={`whitespace-nowrap py-2 pl-3 text-right tabular-nums ${e.ev != null && e.ev > 0 ? 'text-good' : 'text-muted'}`}>{signedPct(e.ev)}</td>
                    <td className="py-2 pl-3">
                      {e.recommended ? (
                        <div className="space-y-1">
                          <Badge tone="good">Jugable en Caliente</Badge>
                          <div className="text-[11px] text-muted">Stake: {money(e.suggestedStake > 0 ? e.suggestedStake : e.flatStake, data.currency)}</div>
                        </div>
                      ) : (
                        <div className="text-[11px] text-muted">{e.reason}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {!started && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={busy}
            className="rounded-full bg-gradient-to-b from-accent to-accent-2 px-4 py-2 text-[13px] font-semibold text-ink disabled:opacity-60">
            {busy ? 'Guardando…' : 'Guardar cuotas de Caliente MX'}
          </button>
          <span className="text-[11px] text-muted">El marcador “≥” indica la cuota mínima de Caliente para EV ≥ {Math.round(data.engineRules.minEv * 100)}%.</span>
        </div>
      )}
      {msg && <div className="text-xs text-muted" role="status">{msg}</div>}
    </div>
  );
}

export function AnalysisPanel({ fixture, date, onClose }: { fixture: Fixture; date: string; onClose: () => void; bets?: BetsApi }) {
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    if (!reload) setData(null);
    setError(null);
    api.analyze(fixture, date)
      .then(r => alive && setData(r.analysis))
      .catch(err => alive && setError((err as Error).message));
    return () => { alive = false; };
  }, [fixture, date, reload]);

  return (
    <Card className="relative">
      <button type="button" onClick={onClose} className="absolute right-3 top-3 rounded-full bg-white/[0.06] p-2 text-muted hover:text-text" aria-label="Cerrar análisis">
        <X className="h-4 w-4" />
      </button>

      <div className="mb-5 grid grid-cols-[1fr_auto_1fr] items-start gap-3 px-6 pt-1">
        <div className="flex flex-col items-center gap-2 text-center">
          <Crest src={fixture.homeCrest} name={fixture.home} size={48} />
          <span className="font-display text-lg font-semibold leading-tight">{fixture.home}</span>
        </div>
        <div className="pt-2 text-center">
          <div className="font-display text-2xl font-bold leading-none tabular-nums">{kickoffTime(fixture.kickoff)}</div>
          <div className="mt-1.5 text-[11px] uppercase tracking-wide text-muted">{kickoffDate(fixture.kickoff)}</div>
        </div>
        <div className="flex flex-col items-center gap-2 text-center">
          <Crest src={fixture.awayCrest} name={fixture.away} size={48} />
          <span className="font-display text-lg font-semibold leading-tight">{fixture.away}</span>
        </div>
      </div>

      <ErrorBox error={error} />
      {!data && !error && <Spinner label="Analizando partido…" />}

      {data && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {data.modelAvailable ? <Badge tone="accent">Modelo Dixon-Coles</Badge> : <Badge tone="warn">Sin modelo propio</Badge>}
            {data.dataQuality && <Badge tone={data.dataQuality === 'alta' ? 'good' : data.dataQuality === 'media' ? 'neutral' : 'warn'}>Datos: {data.dataQuality}</Badge>}
            {data.odds.available ? <Badge>{data.odds.bookmakers} casas</Badge> : <Badge tone="warn">Sin cuotas</Badge>}
            {data.engine.some(e => e.caliente) ? <Badge tone="accent">Con cuotas de Caliente MX</Badge> : <Badge tone="warn">Sin cuotas de Caliente MX</Badge>}
          </div>

          {data.xg && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-line px-2 py-2"><div className="text-[11px] text-muted">Goles esperados local</div><div className="text-lg font-semibold tabular-nums">{data.xg.home.toFixed(2)}</div></div>
              <div className="rounded-lg border border-line px-2 py-2"><div className="text-[11px] text-muted">Marcador más probable</div><div className="text-lg font-semibold tabular-nums">{data.mostLikelyScore ? `${data.mostLikelyScore.home}-${data.mostLikelyScore.away}` : '—'}</div></div>
              <div className="rounded-lg border border-line px-2 py-2"><div className="text-[11px] text-muted">Goles esperados visitante</div><div className="text-lg font-semibold tabular-nums">{data.xg.away.toFixed(2)}</div></div>
            </div>
          )}

          {data.recommended.length > 0 && (
            <div className="rounded-xl border border-good/40 bg-good/[0.08] px-4 py-3 text-sm">
              <div className="font-semibold text-good">Jugable en Caliente MX</div>
              <ul className="mt-1 space-y-0.5 text-[13px]">
                {data.recommended.map(r => (
                  <li key={r.selection}>{r.label} a {odds(r.caliente?.odds)} · EV {signedPct(r.ev)} · modelo {pct(r.modelProbability)} vs mercado {pct(r.marketProbability)}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-xs leading-relaxed text-muted">
            Regla: se recomienda solo si la cuota REAL de Caliente MX da EV ≥ {Math.round(data.engineRules.minEv * 100)}%, el modelo no se aleja más de {Math.round(data.engineRules.maxMarketGap * 100)} pts del mercado sin margen y la cuota está entre {data.engineRules.minOdds.toFixed(2)} y {data.engineRules.maxOdds.toFixed(2)}.
          </div>

          <EngineTable data={data} onSaved={() => setReload(x => x + 1)} />

          {data.secondOpinion && (
            <div className="rounded-lg border border-line px-3 py-2 text-xs text-muted">
              Segunda opinión ({data.secondOpinion.source}, solo informativa): local {pct(data.secondOpinion.home, 0)}, empate {pct(data.secondOpinion.draw, 0)}, visitante {pct(data.secondOpinion.away, 0)}.
            </div>
          )}

          {data.injuries && (data.injuries.home.length > 0 || data.injuries.away.length > 0) && (
            <div className="grid grid-cols-2 gap-3 text-xs">
              {(['home', 'away'] as const).map(side => (
                <div key={side}>
                  <div className="mb-1 font-semibold">Bajas {side === 'home' ? data.home : data.away}</div>
                  <ul className="space-y-0.5 text-muted">
                    {data.injuries![side].slice(0, 8).map(i => <li key={i.player}>{i.player}{i.position ? ` (${i.position})` : ''}</li>)}
                    {!data.injuries![side].length && <li>Sin bajas reportadas</li>}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <Warnings items={data.warnings} />
        </div>
      )}
    </Card>
  );
}
