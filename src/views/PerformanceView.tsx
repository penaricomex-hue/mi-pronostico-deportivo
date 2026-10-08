import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PerfAgg, Performance } from '../types';
import { Badge, Card, Chips, Empty, ErrorBox, SectionTitle, Spinner, Stat } from '../components/ui';
import { kickoffDate, money, odds, pct, signedNum, signedPct } from '../lib/format';

const STATUS_LABEL: Record<string, string> = { pending: 'Pendiente', won: 'Ganada', lost: 'Perdida', void: 'Nula', half_won: 'Media ganada', half_lost: 'Media perdida' };
const GROUP_LABEL: Record<string, string> = {
  la_liga_1x2: 'LaLiga · 1X2', la_liga_over_under: 'LaLiga · Más/Menos', la_liga_btts: 'LaLiga · Ambos marcan',
  champions_league_1x2: 'Champions · 1X2', champions_league_over_under: 'Champions · Más/Menos', champions_league_btts: 'Champions · Ambos marcan'
};

const SHORT: Record<string, string> = { 'LaLiga EA Sports': 'LaLiga', 'UEFA Champions League': 'Champions' };
const short = (n: string) => SHORT[n] || n;

const tone = (v: number | null | undefined) => (v == null ? undefined : v >= 0 ? 'good' : 'bad') as 'good' | 'bad' | undefined;

function AggRow({ label, a }: { label: string; a: PerfAgg }) {
  return (
    <tr className="border-b border-line/60">
      <td className="min-w-[150px] py-2 pr-2">{label}</td>
      <td className="py-2 pl-3 text-right">{a.signals}</td>
      <td className="py-2 pl-3 text-right">{a.resolved}</td>
      <td className="py-2 pl-3 text-right">{a.hitRatePct != null ? `${a.hitRatePct}%` : '—'}</td>
      <td className={`py-2 pl-3 text-right ${a.profit >= 0 ? 'text-good' : 'text-bad'}`}>{signedNum(a.profit, 0)}</td>
      <td className="py-2 pl-3 text-right">{signedNum(a.yieldPct, 1, '%')}</td>
      <td className="py-2 pl-3 text-right">{signedNum(a.avgEvPct, 1, '%')}</td>
      <td className={`py-2 pl-3 text-right ${(a.avgClvPct ?? 0) > 0 ? 'text-good' : a.avgClvPct != null ? 'text-bad' : ''}`}>{signedNum(a.avgClvPct, 1, '%')}</td>
      <td className="py-2 pl-3 text-right">{a.clvPositivePct != null ? `${a.clvPositivePct}%` : '—'}</td>
    </tr>
  );
}

function AggTable({ rows }: { rows: Array<{ label: string; a: PerfAgg }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm tabular-nums">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
            <th className="py-2 font-medium">Grupo</th>
            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Señales</th>
            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Resueltas</th>
            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Acierto</th>
            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Beneficio</th>
            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Yield</th>
            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">EV medio</th>
            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">CLV medio</th>
            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">CLV +</th>
          </tr>
        </thead>
        <tbody>{rows.map(r => <AggRow key={r.label} label={r.label} a={r.a} />)}</tbody>
      </table>
    </div>
  );
}

export function PerformanceView() {
  const [days, setDays] = useState('30');
  const [data, setData] = useState<Performance | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.performance(Number(days)).then(d => alive && setData(d)).catch(err => alive && setError((err as Error).message));
    return () => { alive = false; };
  }, [days]);

  const t = data?.totals;
  const k = data?.keyMetric;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Chips options={[{ value: '7', label: '7 días' }, { value: '30', label: '30 días' }, { value: '60', label: '60 días' }, { value: '90', label: '90 días' }]} value={days} onChange={setDays} />
        {data && <Badge tone={data.mode === 'paper' ? 'accent' : 'warn'}>{data.mode === 'paper' ? 'Paper trading (sin dinero real)' : 'Modo real'}</Badge>}
      </div>
      <ErrorBox error={error} />
      {!data && !error && <Spinner label="Cargando rendimiento…" />}

      {data && t && k && (
        <>
          <Card>
            <SectionTitle>La métrica clave</SectionTitle>
            <p className="mb-3 text-sm text-muted">{k.question} Si tomamos cuotas mejores que la de cierre de forma consistente (CLV positivo), hay ventaja real aunque el resultado a corto plazo sea negativo.</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="CLV medio" value={signedNum(k.avgClvPct, 2, '%')} tone={tone(k.avgClvPct)} hint={`${k.signalsWithClv} señales con cierre`} />
              <Stat label="Ganan al cierre" value={k.beatClosingPct != null ? `${k.beatClosingPct}%` : '—'} tone={k.beatClosingPct != null ? (k.beatClosingPct >= 50 ? 'good' : 'bad') : undefined} hint="% de señales con CLV > 0" />
              <div className="col-span-2 sm:col-span-1"><Stat label="Muestra" value={`${t.signals}`} hint={`${k.progressPct}% de 300 señales`} /></div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.06]" aria-label="Progreso hacia 300 señales">
              <div className="h-full rounded-full bg-gradient-to-r from-accent-2 to-accent" style={{ width: `${Math.max(2, k.progressPct)}%` }} />
            </div>
            <p className="mt-2 text-[11px] text-muted">{k.target}</p>
          </Card>

          {t.signals === 0 ? (
            <Empty>Aún no hay señales en este periodo. Se registran solas cuando el motor encuentra una apuesta con valor (escaneo automático cada pocas horas o al pulsar «Buscar valor»).</Empty>
          ) : (
            <>
              <Card>
                <SectionTitle>Resumen · últimos {data.days} días</SectionTitle>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Señales" value={t.signals} hint={`${t.resolved} resueltas · ${t.pending} pendientes`} />
                  <Stat label="Acierto" value={t.hitRatePct != null ? `${t.hitRatePct}%` : '—'} />
                  <Stat label="Beneficio neto" value={money(t.netProfit, data.currency)} tone={tone(t.netProfit)} hint={`Apostado ${money(t.settledStaked, data.currency)}`} />
                  <Stat label="Yield" value={signedNum(t.yieldPct, 1, '%')} tone={tone(t.yieldPct)} hint="Beneficio / apostado" />
                  <Stat label="ROI" value={signedNum(t.roiPct, 2, '%')} tone={tone(t.roiPct)} hint={`Sobre banca de ${money(data.bankroll, data.currency)}`} />
                  <Stat label="EV medio" value={signedNum(t.avgEvPct, 1, '%')} hint="Esperado al registrar" />
                  <Stat label="CLV medio" value={signedNum(t.avgClvPct, 2, '%')} tone={tone(t.avgClvPct)} />
                  <Stat label="CLV positivo" value={t.clvPositivePct != null ? `${t.clvPositivePct}%` : '—'} hint={`${t.clvSample} con cierre`} />
                </div>
              </Card>

              <Card>
                <SectionTitle>Por competición</SectionTitle>
                <AggTable rows={data.byCompetition.map(c => ({ label: c.competition, a: c }))} />
              </Card>

              <Card>
                <SectionTitle>Por mercado y competición</SectionTitle>
                <AggTable rows={data.byMarket.map(m => ({ label: `${short(m.competition)} · ${m.marketLabel}`, a: m }))} />
                <div className="mt-3 grid gap-3 sm:grid-cols-2 text-xs">
                  <div>
                    <div className="mb-1 font-semibold text-good">Mejores mercados</div>
                    {data.bestMarkets.length ? data.bestMarkets.map(m => <div key={`b${m.competition}${m.marketLabel}`} className="text-muted">{short(m.competition)} · {m.marketLabel}: {signedNum(m.yieldPct, 1, '%')} yield, CLV {signedNum(m.avgClvPct, 1, '%')}</div>)
                      : <div className="text-muted">Se necesita al menos {data.minSampleForRanking} señales resueltas por mercado.</div>}
                  </div>
                  <div>
                    <div className="mb-1 font-semibold text-bad">Peores mercados</div>
                    {data.worstMarkets.length ? data.worstMarkets.map(m => <div key={`w${m.competition}${m.marketLabel}`} className="text-muted">{short(m.competition)} · {m.marketLabel}: {signedNum(m.yieldPct, 1, '%')} yield, CLV {signedNum(m.avgClvPct, 1, '%')}</div>)
                      : <div className="text-muted">Hacen falta al menos 2 mercados con {data.minSampleForRanking}+ señales resueltas.</div>}
                  </div>
                </div>
              </Card>

              <Card>
                <SectionTitle>Casa de ejecución vs mercado promedio</SectionTitle>
                <div className="grid grid-cols-3 gap-2">
                  <Stat label="Cuota tomada" value={odds(data.execVsMarket.avgExecutionOdds)} />
                  <Stat label="Cuota media" value={odds(data.execVsMarket.avgMarketOdds)} />
                  <Stat label="Ventaja de precio" value={signedNum(data.execVsMarket.priceEdgePct, 2, '%')} tone={tone(data.execVsMarket.priceEdgePct)} />
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {data.execVsMarket.bookmakers.map(b => <Badge key={b.bookmaker}>{b.bookmaker}: {b.signals}</Badge>)}
                </div>
              </Card>
            </>
          )}

          <Card>
            <SectionTitle>Calibración</SectionTitle>
            {t.signals > 0 && (
              <div className="mb-4 overflow-x-auto">
                <div className="mb-1 text-xs text-muted">Señales resueltas: probabilidad que se usó frente a acierto real</div>
                <table className="w-full min-w-[420px] text-sm tabular-nums">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                      <th className="py-2 font-medium">Rango</th><th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Señales</th>
                      <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Modelo</th><th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Calibrada</th><th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Real</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.calibrationBands.map(b => (
                      <tr key={b.range} className="border-b border-line/60">
                        <td className="py-1.5">{b.range}</td><td className="py-1.5 text-right">{b.signals}</td>
                        <td className="py-1.5 text-right">{b.rawModelPct != null ? `${b.rawModelPct}%` : '—'}</td>
                        <td className="py-1.5 text-right">{b.predictedPct != null ? `${b.predictedPct}%` : '—'}</td>
                        <td className="py-1.5 text-right">{b.actualPct != null ? `${b.actualPct}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.modelCalibration && (
              <div className="overflow-x-auto">
                <div className="mb-1 text-xs text-muted">Mapas de calibración (histórico fuera de muestra + partidos reales liquidados): cuando el modelo dijo X, cuánto pasó</div>
                <table className="w-full min-w-[560px] text-sm tabular-nums">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                      <th className="py-2 font-medium">Mapa</th>
                      {['50–60%', '60–70%', '70–80%'].map(r => <th key={r} className="py-2 text-right font-medium">{r}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(data.modelCalibration).map(([key, rows]) => (
                      <tr key={key} className="border-b border-line/60">
                        <td className="py-1.5">{GROUP_LABEL[key] || key}</td>
                        {rows.map(r => (
                          <td key={r.range} className="py-1.5 text-right">
                            {r.actual != null ? pct(r.actual, 0) : '—'}
                            <span className="ml-1 text-[10px] text-muted">({r.samples})</span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {data.recent.length > 0 && (
            <Card>
              <SectionTitle>Últimas señales</SectionTitle>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                      <th className="py-2 font-medium">Partido</th><th className="py-2 font-medium">Selección</th><th className="py-2 font-medium">Casa</th>
                      <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Cuota</th><th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Cierre</th>
                      <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">EV</th><th className="whitespace-nowrap py-2 pl-3 text-right font-medium">CLV</th><th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map(s => (
                      <tr key={s.id} className="border-b border-line/60">
                        <td className="py-1.5">{s.home} {s.score ?? 'vs'} {s.away}<div className="text-[10px] text-muted">{s.competition} · {kickoffDate(s.kickoff)}</div></td>
                        <td className="py-1.5">{s.label}</td>
                        <td className="max-w-[100px] truncate py-1.5 text-muted">{s.bookmaker}</td>
                        <td className="py-1.5 text-right">{odds(s.odds)}</td>
                        <td className="py-1.5 text-right">{odds(s.closingOdds)}</td>
                        <td className="py-1.5 text-right">{signedPct(s.ev)}</td>
                        <td className={`py-1.5 text-right ${(s.clv ?? 0) > 0 ? 'text-good' : s.clv != null ? 'text-bad' : ''}`}>{signedPct(s.clv)}</td>
                        <td className={`py-1.5 text-right ${s.status.includes('won') ? 'text-good' : s.status.includes('lost') ? 'text-bad' : 'text-muted'}`}>{STATUS_LABEL[s.status] || s.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
