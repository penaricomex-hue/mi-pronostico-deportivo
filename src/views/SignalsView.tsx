import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { CalienteCheck, Signal, SignalCandidate, SignalsPreview } from '../types';
import { Badge, Card, Chips, COMPETITIONS, Empty, ErrorBox, Spinner, Warnings } from '../components/ui';
import { kickoffDate, kickoffTime, money, odds, pct, signedPct } from '../lib/format';

function localDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function CandidateCard({ c, currency }: { c: SignalCandidate; currency: string }) {
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-muted">
        <span>{c.competition} · {kickoffDate(c.kickoff)} {kickoffTime(c.kickoff)}</span>
        <Badge tone="good">Jugable en Caliente</Badge>
      </div>
      <div className="mb-3 text-sm font-semibold">{c.home} <span className="text-muted">vs</span> {c.away}</div>
      <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-5">
        <div><div className="text-muted">Selección</div><div className="font-semibold">{c.label}</div></div>
        <div><div className="text-muted">Modelo</div><div className="font-semibold tabular-nums">{pct(c.modelProbability)}</div></div>
        <div><div className="text-muted">Mercado</div><div className="font-semibold tabular-nums">{pct(c.marketProbability)}</div></div>
        <div><div className="text-muted">Caliente MX</div><div className="font-semibold tabular-nums">{odds(c.caliente?.odds)}</div></div>
        <div><div className="text-muted">EV</div><div className="font-semibold text-good tabular-nums">{signedPct(c.ev)}</div></div>
      </div>
      {c.calibration && c.calibration.method !== 'identity' && <p className="mt-2 text-[11px] text-muted">{c.calibration.text}</p>}
      <div className="mt-2 text-[11px] text-muted">Stake sugerido: {money(c.suggestedStake > 0 ? c.suggestedStake : c.flatStake, currency)} · {c.matchdayKey}</div>
    </Card>
  );
}

function CheckRow({ c, onSaved }: { c: CalienteCheck; onSaved: () => void }) {
  const [v, setV] = useState('');
  const [state, setState] = useState<string | null>(null);
  const save = async () => {
    const o = Number(v.replace(',', '.'));
    if (!(o > 1)) { setState('Cuota no válida'); return; }
    try {
      await api.caliente.save({ fixtureId: c.fixtureId, date: localDate(c.kickoff), competition: c.competitionCode, entries: [{ selection: c.selection, odds: o }] });
      setState(o >= c.minCalienteOdds ? 'Guardada: alcanza el mínimo' : 'Guardada: no alcanza el mínimo');
      onSaved();
    } catch (err) {
      setState((err as Error).message);
    }
  };
  return (
    <tr className="border-b border-line/60 align-top">
      <td className="py-2 pr-2 text-[13px]">
        <div className="font-medium">{c.home} vs {c.away}</div>
        <div className="text-[11px] text-muted">{c.competition} · {kickoffDate(c.kickoff)} {kickoffTime(c.kickoff)}</div>
      </td>
      <td className="whitespace-nowrap py-2 pl-3 text-[13px]">{c.label}</td>
      <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{pct(c.modelProbability)}<div className="text-[10px] text-muted">mercado {pct(c.marketProbability)}</div></td>
      <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{odds(c.marketAvgOdds)}</td>
      <td className="whitespace-nowrap py-2 pl-3 text-right font-semibold tabular-nums text-accent">≥ {odds(c.minCalienteOdds)}</td>
      <td className="py-2 pl-3">
        <div className="flex items-center gap-2">
          <input inputMode="decimal" value={v} onChange={e => setV(e.target.value)} placeholder="cuota" aria-label={`Cuota de Caliente MX para ${c.label}`}
            className="w-20 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-right text-sm tabular-nums focus:border-accent focus:outline-none" />
          <button type="button" onClick={save} className="text-[12px] text-accent hover:underline">Guardar</button>
        </div>
        {state && <div className="mt-1 text-[11px] text-muted">{state}</div>}
      </td>
    </tr>
  );
}

const STATUS_LABEL: Record<Signal['status'], string> = { pending: 'Pendiente', won: 'Ganada', lost: 'Perdida', void: 'Devuelta', half_won: 'Media ganada', half_lost: 'Media perdida' };

export function SignalsView({ currency }: { currency: string }) {
  const [competition, setCompetition] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SignalsPreview | null>(null);
  const [signals, setSignals] = useState<Signal[] | null>(null);
  const [genMsg, setGenMsg] = useState<string | null>(null);

  const loadSignals = useCallback(() => {
    api.signals.list(30).then(r => setSignals(r.signals)).catch(() => setSignals([]));
  }, []);

  const scan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPreview(await api.signals.preview(competition, 4));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [competition]);

  useEffect(() => { scan(); loadSignals(); }, [scan, loadSignals]);

  const generate = async () => {
    setGenMsg(null);
    try {
      const r = await api.signals.generate();
      setGenMsg(r.created ? `${r.created} señal(es) registradas en paper trading.` : 'No hay señales nuevas que registrar (o ya se alcanzó el tope por jornada).');
      loadSignals();
    } catch (err) {
      setGenMsg((err as Error).message);
    }
  };

  const rules = preview?.rules;

  return (
    <div className="space-y-4">
      <Card>
        <div className="space-y-3">
          <Chips options={COMPETITIONS.map(c => ({ value: c.code, label: c.name }))} value={competition} onChange={setCompetition} />
          {rules && (
            <div className="flex flex-wrap gap-2">
              <Badge tone="accent">EV ≥ {Math.round(rules.minEv * 100)}% en Caliente MX</Badge>
              <Badge>Modelo − mercado ≤ {Math.round(rules.maxMarketGap * 100)} pts</Badge>
              <Badge>Cuotas {rules.minOdds.toFixed(2)}–{rules.maxOdds.toFixed(2)}</Badge>
              <Badge>Máx. {rules.maxBetsPerMatchday} por jornada</Badge>
              <Badge tone="warn">Paper trading</Badge>
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={scan} disabled={loading} className="rounded-full border border-white/10 px-4 py-2 text-[13px] text-text hover:border-accent/50 disabled:opacity-60">
              {loading ? 'Analizando…' : 'Actualizar'}
            </button>
            <button type="button" onClick={generate} className="rounded-full bg-gradient-to-b from-accent to-accent-2 px-4 py-2 text-[13px] font-semibold text-ink">
              Registrar señales ahora
            </button>
          </div>
          {genMsg && <div className="text-xs text-muted">{genMsg}</div>}
        </div>
      </Card>

      <ErrorBox error={error} />
      {loading && !preview && <Spinner label="Evaluando LaLiga y Champions contra Caliente MX…" />}

      {preview && (
        <>
          <h3 className="font-display px-1 text-lg font-semibold uppercase tracking-wide">Jugables ahora ({preview.recommended.length})</h3>
          {preview.recommended.length ? (
            <div className="grid gap-3 md:grid-cols-2">{preview.recommended.map(c => <CandidateCard key={`${c.fixtureId}:${c.selection}`} c={c} currency={currency} />)}</div>
          ) : (
            <Empty>Ninguna selección cumple las reglas con las cuotas de Caliente MX registradas. Revisa la lista de abajo y captura las cuotas que veas en Caliente.</Empty>
          )}
          {preview.capped.length > 0 && (
            <p className="px-1 text-[11px] text-muted">{preview.capped.length} candidata(s) descartadas por el tope por jornada o por tener ya otra señal en el mismo partido.</p>
          )}

          <Card>
            <h3 className="font-display mb-1 text-base font-semibold uppercase tracking-wide">Revisa en Caliente MX</h3>
            <p className="mb-3 text-[12px] text-muted">El modelo y el mercado coinciden lo suficiente; solo falta saber si Caliente paga la cuota mínima para EV ≥ 5%. Ninguna API pública publica sus cuotas, así que se capturan aquí con la hora exacta.</p>
            {preview.toCheckInCaliente.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                      <th className="py-2 font-medium">Partido</th>
                      <th className="py-2 pl-3 font-medium">Selección</th>
                      <th className="py-2 pl-3 text-right font-medium">Modelo</th>
                      <th className="py-2 pl-3 text-right font-medium">Cuota media</th>
                      <th className="py-2 pl-3 text-right font-medium">Mínimo Caliente</th>
                      <th className="py-2 pl-3 font-medium">Cuota en Caliente</th>
                    </tr>
                  </thead>
                  <tbody>{preview.toCheckInCaliente.map(c => <CheckRow key={`${c.fixtureId}:${c.selection}`} c={c} onSaved={scan} />)}</tbody>
                </table>
              </div>
            ) : <p className="text-sm text-muted">Nada pendiente de revisar.</p>}
          </Card>
          <Warnings items={preview.warnings} />
        </>
      )}

      <Card>
        <h3 className="font-display mb-3 text-base font-semibold uppercase tracking-wide">Señales registradas (30 días)</h3>
        {!signals ? <Spinner /> : signals.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                  <th className="py-2 font-medium">Partido</th>
                  <th className="py-2 pl-3 font-medium">Selección</th>
                  <th className="py-2 pl-3 text-right font-medium">Caliente</th>
                  <th className="py-2 pl-3 text-right font-medium">EV</th>
                  <th className="py-2 pl-3 text-right font-medium">CLV</th>
                  <th className="py-2 pl-3 font-medium">Resultado</th>
                </tr>
              </thead>
              <tbody>
                {signals.map(s => (
                  <tr key={s.id} className="border-b border-line/60">
                    <td className="py-2 pr-2 text-[13px]">{s.home} vs {s.away}<div className="text-[11px] text-muted">{s.competition} · {kickoffDate(s.kickoff)}</div></td>
                    <td className="py-2 pl-3 text-[13px]">{s.label}</td>
                    <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums">{odds(s.calienteOdds)}{s.closingCalienteOdds ? <div className="text-[10px] text-muted">cierre {odds(s.closingCalienteOdds)}</div> : null}</td>
                    <td className="whitespace-nowrap py-2 pl-3 text-right tabular-nums text-good">{signedPct(s.ev)}</td>
                    <td className={`whitespace-nowrap py-2 pl-3 text-right tabular-nums ${s.clv != null ? (s.clv > 0 ? 'text-good' : 'text-bad') : 'text-muted'}`}>{signedPct(s.clv)}</td>
                    <td className="py-2 pl-3 text-[12px]">{STATUS_LABEL[s.status]}{s.score ? ` (${s.score})` : ''}{s.profit != null ? <div className="text-[11px] text-muted">{money(s.profit, s.currency)}</div> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-muted">Aún no hay señales registradas. Se registran solas cada hora mientras el servicio está activo, o con el botón “Registrar señales ahora”.</p>}
      </Card>
    </div>
  );
}
