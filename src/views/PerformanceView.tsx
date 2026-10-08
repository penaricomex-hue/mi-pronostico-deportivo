import { useEffect, useState } from 'react';
import { api } from '../api';
import type { PerfGroup, Performance } from '../types';
import { Badge, Card, Chips, Empty, ErrorBox, Spinner, Stat } from '../components/ui';
import { money, signedNum } from '../lib/format';

const PERIODS = [
  { value: '7', label: '7 días' },
  { value: '30', label: '30 días' },
  { value: '60', label: '60 días' },
  { value: '90', label: '90 días' }
];

const num = (v: number | null | undefined, d = 1, s = '%') => (v == null ? '—' : `${v.toFixed(d)}${s}`);
const tone = (v: number | null | undefined) => (v == null ? undefined : v > 0 ? 'good' as const : v < 0 ? 'bad' as const : undefined);

function GroupTable({ rows, currency }: { rows: PerfGroup[]; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
            <th className="py-2 font-medium">Competición</th>
            <th className="py-2 pl-3 font-medium">Mercado</th>
            <th className="py-2 pl-3 text-right font-medium">Señales</th>
            <th className="py-2 pl-3 text-right font-medium">Acierto</th>
            <th className="py-2 pl-3 text-right font-medium">Ganancia</th>
            <th className="py-2 pl-3 text-right font-medium">Yield</th>
            <th className="py-2 pl-3 text-right font-medium">EV medio</th>
            <th className="py-2 pl-3 text-right font-medium">CLV medio</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(g => (
            <tr key={g.key} className="border-b border-line/60">
              <td className="py-2 pr-2">{g.competition}</td>
              <td className="py-2 pl-3">{g.marketLabel}</td>
              <td className="py-2 pl-3 text-right tabular-nums">{g.signals}<span className="text-[10px] text-muted"> ({g.settled})</span></td>
              <td className="py-2 pl-3 text-right tabular-nums">{num(g.hitRatePct)}</td>
              <td className={`py-2 pl-3 text-right tabular-nums ${g.profit != null && g.profit > 0 ? 'text-good' : g.profit != null && g.profit < 0 ? 'text-bad' : ''}`}>{money(g.profit, currency)}</td>
              <td className="py-2 pl-3 text-right tabular-nums">{signedNum(g.yieldPct, 1, '%')}</td>
              <td className="py-2 pl-3 text-right tabular-nums">{signedNum(g.avgEvPct, 1, '%')}</td>
              <td className={`py-2 pl-3 text-right tabular-nums ${g.avgClvPct != null && g.avgClvPct > 0 ? 'text-good' : g.avgClvPct != null ? 'text-bad' : ''}`}>{signedNum(g.avgClvPct, 1, '%')}</td>
            </tr>
          ))}
        </tbody>
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
    setError(null);
    api.performance(Number(days)).then(d => alive && setData(d)).catch(err => alive && setError((err as Error).message));
    return () => { alive = false; };
  }, [days]);

  const t = data?.totals;

  return (
    <div className="space-y-4">
      <Chips options={PERIODS} value={days} onChange={setDays} />
      <ErrorBox error={error} />
      {!data && !error && <Spinner />}
      {data && t && (
        <>
          <Card className="border-accent/30">
            <div className="text-[11px] uppercase tracking-wide text-muted">La métrica que importa</div>
            <p className="mt-1 text-sm font-semibold">{data.keyQuestion.text}</p>
            <p className="mt-2 text-sm text-muted">{data.keyQuestion.verdict}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="warn">{data.mode === 'paper' ? 'Paper trading (sin dinero real)' : 'Dinero real'}</Badge>
              <Badge>Meta: 300–500 señales</Badge>
            </div>
          </Card>

          {t.signals === 0 ? (
            <Empty>Aún no hay señales en este periodo. El panel se llena cuando el motor registra apuestas jugables en Caliente MX.</Empty>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                <Stat label="Señales" value={t.signals} hint={`${t.settled} resueltas · ${t.pending} pendientes`} />
                <Stat label="Acierto" value={num(t.hitRatePct)} hint={`${t.won} ganadas · ${t.lost} perdidas`} />
                <Stat label="Ganancia neta" value={money(t.profit, data.currency)} tone={tone(t.profit)} />
                <Stat label="Yield" value={signedNum(t.yieldPct, 1, '%')} tone={tone(t.yieldPct)} hint={`ROI sobre banca: ${signedNum(t.roiPct, 2, '%')}`} />
                <Stat label="EV medio tomado" value={signedNum(t.avgEvPct, 1, '%')} />
                <Stat label="CLV medio" value={signedNum(t.avgClvPct, 1, '%')} tone={tone(t.avgClvPct)} hint={`${t.clvSample} con cierre`} />
                <Stat label="CLV positivo" value={num(t.clvPositivePct)} />
                <Stat label="Caliente vs mercado" value={signedNum(data.calienteVsMarket.avgPremiumPct, 1, '%')} hint="Prima media de cuota" />
              </div>

              <Card>
                <h3 className="font-display mb-3 text-base font-semibold uppercase tracking-wide">Por competición y mercado</h3>
                <GroupTable rows={data.byCompetitionMarket} currency={data.currency} />
              </Card>

              <div className="grid gap-3 md:grid-cols-2">
                <Card>
                  <h3 className="font-display mb-3 text-base font-semibold uppercase tracking-wide">Calibración por rangos</h3>
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-line text-left text-[11px] uppercase text-muted"><th className="py-2 font-medium">Rango</th><th className="py-2 text-right font-medium">Señales</th><th className="py-2 text-right font-medium">Dijo (calibrado)</th><th className="py-2 text-right font-medium">Ganó</th></tr></thead>
                    <tbody>
                      {data.calibration.map(c => (
                        <tr key={c.range} className="border-b border-line/60">
                          <td className="py-2">{c.range}</td>
                          <td className="py-2 text-right tabular-nums">{c.signals}</td>
                          <td className="py-2 text-right tabular-nums">{num(c.predictedPct)}{c.rawPredictedPct != null && <div className="text-[10px] text-muted">orig. {num(c.rawPredictedPct)}</div>}</td>
                          <td className="py-2 text-right tabular-nums">{num(c.actualPct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
                <Card>
                  <h3 className="font-display mb-3 text-base font-semibold uppercase tracking-wide">Caliente MX vs mercado promedio</h3>
                  <ul className="space-y-1.5 text-sm">
                    <li className="flex justify-between"><span className="text-muted">Cuota media Caliente</span><span className="tabular-nums">{data.calienteVsMarket.avgCalienteOdds?.toFixed(2) ?? '—'}</span></li>
                    <li className="flex justify-between"><span className="text-muted">Cuota media del mercado</span><span className="tabular-nums">{data.calienteVsMarket.avgMarketOdds?.toFixed(2) ?? '—'}</span></li>
                    <li className="flex justify-between"><span className="text-muted">Caliente paga más que el promedio</span><span className="tabular-nums">{num(data.calienteVsMarket.betterThanMarketPct)}</span></li>
                    <li className="flex justify-between"><span className="text-muted">Cuota tomada &gt; cierre de Caliente</span><span className="tabular-nums">{num(data.calienteVsMarket.beatCalienteClosePct)}</span></li>
                  </ul>
                </Card>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <Card>
                  <h3 className="font-display mb-2 text-base font-semibold uppercase tracking-wide">Mejores mercados</h3>
                  <ul className="space-y-1 text-sm">{data.bestMarkets.map(g => <li key={g.key} className="flex justify-between"><span>{g.competition} · {g.marketLabel}</span><span className="tabular-nums">{signedNum(g.yieldPct, 1, '%')}</span></li>)}</ul>
                </Card>
                <Card>
                  <h3 className="font-display mb-2 text-base font-semibold uppercase tracking-wide">Peores mercados</h3>
                  <ul className="space-y-1 text-sm">{data.worstMarkets.map(g => <li key={g.key} className="flex justify-between"><span>{g.competition} · {g.marketLabel}</span><span className="tabular-nums">{signedNum(g.yieldPct, 1, '%')}</span></li>)}</ul>
                </Card>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
