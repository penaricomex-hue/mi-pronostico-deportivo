import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BacktestLeague, ScoreMetrics } from '../types';
import { Badge, Card, Chips, COMPETITIONS, ErrorBox, MODEL_LEAGUES, SectionTitle, Spinner, Stat } from '../components/ui';
import { odds, seasonLabel, signedNum } from '../lib/format';

const OUTCOME_LABEL: Record<string, string> = { home: 'Local', draw: 'Empate', away: 'Visitante', over25: 'Más de 2.5' };

function MetricsTable({ m }: { m: Record<'model' | 'blended' | 'market' | 'uniform', ScoreMetrics> }) {
  const rows: Array<[string, ScoreMetrics]> = [
    ['Modelo propio', m.model],
    ['Final (mezcla)', m.blended],
    ['Mercado (cuotas)', m.market],
    ['Azar (33/33/33)', m.uniform]
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[480px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
            <th className="py-2 font-medium">Predicción</th>
            <th className="py-2 text-right font-medium" title="Más bajo es mejor">Brier</th>
            <th className="py-2 text-right font-medium" title="Más bajo es mejor">Log-loss</th>
            <th className="py-2 text-right font-medium" title="Más bajo es mejor">RPS</th>
            <th className="py-2 text-right font-medium">Acierto 1X2</th>
            <th className="py-2 text-right font-medium" title="Más bajo es mejor">Brier O/U</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map(([label, r]) => (
            <tr key={label} className="border-b border-line/60">
              <td className="py-2">{label}</td>
              <td className="py-2 text-right">{r.brier ?? '—'}</td>
              <td className="py-2 text-right">{r.logLoss ?? '—'}</td>
              <td className="py-2 text-right">{r.rps ?? '—'}</td>
              <td className="py-2 text-right">{r.accuracyPct != null ? `${r.accuracyPct}%` : '—'}</td>
              <td className="py-2 text-right">{r.brierOU ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BacktestView() {
  const [competition, setCompetition] = useState('PD');
  const [data, setData] = useState<BacktestLeague | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.backtest(competition).then(d => alive && setData(d)).catch(err => alive && setError((err as Error).message));
    return () => { alive = false; };
  }, [competition]);

  const t = data?.test;
  return (
    <div className="space-y-4">
      <Chips options={COMPETITIONS.filter(c => MODEL_LEAGUES.includes(c.code)).map(c => ({ value: c.code, label: c.name }))} value={competition} onChange={setCompetition} />
      <ErrorBox error={error} />
      {!data && !error && <Spinner label="Cargando backtest…" />}
      {data && t && (
        <>
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone="accent">Walk-forward sin fuga de información</Badge>
              <Badge>Entrenamiento: {data.trainSeasons.map(seasonLabel).join(', ')}</Badge>
              <Badge>Prueba: {data.testSeasons.map(seasonLabel).join(', ')}</Badge>
              {data.valueEnabled ? <Badge tone="good">Valor habilitado</Badge> : <Badge tone="warn">Valor deshabilitado</Badge>}
            </div>
            <p className="text-sm text-muted">
              Cada partido se predice con un modelo ajustado solo con partidos anteriores. Los pesos de mezcla y el decaimiento temporal
              (ξ = {data.xi}) se eligieron en entrenamiento y se miden aquí en {t.matches} partidos de prueba que el ajuste nunca vio.
              Peso del modelo en la probabilidad final: {Math.round(data.weights.w1x2 * 100)}% en 1X2 y {Math.round(data.weights.wOU * 100)}% en goles.
            </p>
            <p className="mt-2 text-xs text-muted">{data.valueRule}.</p>
          </Card>

          <Card>
            <SectionTitle aside={<Badge tone={t.verdicts.modelBrier === 'Mejor que el mercado' ? 'good' : 'warn'}>{t.verdicts.modelBrier}</Badge>}>
              Precisión en prueba
            </SectionTitle>
            <MetricsTable m={t.metrics} />
            <p className="mt-2 text-[11px] text-muted">En Brier, log-loss y RPS, más bajo es mejor. El mercado son las cuotas medias de apertura sin margen.</p>
          </Card>

          <Card>
            <SectionTitle>Estrategia de valor en prueba (stake plano de 1 unidad)</SectionTitle>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Apuestas" value={t.betting.bets} hint={t.betting.hitRatePct != null ? `Acierto ${t.betting.hitRatePct}%` : undefined} />
              <Stat label="ROI" value={signedNum(t.betting.roiPct, 1, '%')} tone={(t.betting.roiPct ?? 0) >= 0 ? 'good' : 'bad'} hint={`${signedNum(t.betting.profitUnits, 2)} u`} />
              <Stat label="CLV medio" value={signedNum(t.betting.avgClvPct, 2, '%')} tone={(t.betting.avgClvPct ?? 0) > 0 ? 'good' : 'bad'} hint={t.betting.clvPositivePct != null ? `${t.betting.clvPositivePct}% con CLV > 0` : undefined} />
              <Stat label="Caída máxima" value={`${t.betting.maxDrawdownUnits} u`} />
            </div>
            <p className="mt-2 text-[11px] text-muted">
              CLV = cuota tomada frente a la cuota justa de cierre. Es el indicador más estable de ventaja real; con pocas apuestas el ROI es sobre todo ruido.
            </p>
          </Card>

          {data.engine ? (
            <Card className="border-accent/30">
              <SectionTitle aside={<Badge tone="accent">Nuevo enfoque</Badge>}>Motor de valor calibrado (reglas de Caliente MX)</SectionTitle>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Señales" value={data.engine.bets} hint={data.engine.hitRatePct != null ? `Acierto ${data.engine.hitRatePct}%` : undefined} />
                <Stat label="Yield" value={signedNum(data.engine.yieldPct, 1, '%')} tone={(data.engine.yieldPct ?? 0) >= 0 ? 'good' : 'bad'} hint={`${signedNum(data.engine.profitUnits, 2)} u`} />
                <Stat label="CLV medio" value={signedNum(data.engine.avgClvPct, 2, '%')} tone={(data.engine.avgClvPct ?? 0) > 0 ? 'good' : 'bad'} hint={data.engine.clvPositivePct != null ? `${data.engine.clvPositivePct}% con CLV > 0` : undefined} />
                <Stat label="Mercados" value={Object.keys(data.engine.byMarket).length} hint={Object.entries(data.engine.byMarket).map(([k, v]) => `${k}: ${signedNum(v.yieldPct, 1, '%')}`).join(' · ')} />
              </div>
              <p className="mt-2 text-[11px] text-muted">
                EV ≥ 5%, modelo − mercado ≤ 10 pts, cuotas 1.50–4.00, máx. 3 por jornada, probabilidad calibrada con temporadas de entrenamiento.
                Cuota de ejecución: {data.engine.proxy.toLowerCase()}. Por eso el CLV parte con el margen de la casa en contra.
              </p>
            </Card>
          ) : (
            <Card>
              <p className="text-sm text-muted">La Champions no tiene cuotas históricas públicas: aquí se mide la precisión del modelo; el ROI y el CLV se medirán con las señales reales en Caliente MX (panel Rendimiento).</p>
            </Card>
          )}

          <Card>
            <SectionTitle>Calibración (probabilidad final)</SectionTitle>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm tabular-nums">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                    <th className="py-2 font-medium">Resultado</th><th className="py-2 font-medium">Rango</th>
                    <th className="py-2 text-right font-medium">Partidos</th><th className="py-2 text-right font-medium">Predicho</th>
                    <th className="py-2 text-right font-medium">Real</th><th className="py-2 text-right font-medium">Diferencia</th>
                  </tr>
                </thead>
                <tbody>
                  {t.calibration.map(c => (
                    <tr key={`${c.outcome}-${c.range}`} className="border-b border-line/60">
                      <td className="py-1.5">{OUTCOME_LABEL[c.outcome] || c.outcome}</td>
                      <td className="py-1.5">{c.range}</td>
                      <td className="py-1.5 text-right">{c.matches}</td>
                      <td className="py-1.5 text-right">{c.predictedPct}%</td>
                      <td className="py-1.5 text-right">{c.actualPct}%</td>
                      <td className={`py-1.5 text-right ${Math.abs(c.gapPts) > 8 ? 'text-warn' : ''}`}>{signedNum(c.gapPts, 1, ' pts')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {t.betting.recentBets.length > 0 && (
            <Card>
              <SectionTitle>Últimas apuestas simuladas del backtest</SectionTitle>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                      <th className="py-2 font-medium">Fecha</th><th className="py-2 font-medium">Partido</th><th className="py-2 font-medium">Selección</th>
                      <th className="py-2 text-right font-medium">Cuota</th><th className="py-2 text-right font-medium">EV</th><th className="py-2 text-right font-medium">CLV</th><th className="py-2 text-right font-medium">Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.betting.recentBets.map(b => (
                      <tr key={`${b.date}${b.home}${b.selection}`} className="border-b border-line/60">
                        <td className="py-1.5">{b.date}</td>
                        <td className="py-1.5">{b.home} {b.score} {b.away}</td>
                        <td className="py-1.5">{b.label}</td>
                        <td className="py-1.5 text-right">{odds(b.odds)}</td>
                        <td className="py-1.5 text-right">{signedNum(b.evPct, 1, '%')}</td>
                        <td className="py-1.5 text-right">{signedNum(b.clvPct, 1, '%')}</td>
                        <td className={`py-1.5 text-right ${b.result === 'won' ? 'text-good' : 'text-bad'}`}>{b.result === 'won' ? 'Ganada' : 'Perdida'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <p className="text-[11px] text-muted">Datos: {competition === 'CL' ? 'football-data.org (resultados de Champions, sin cuotas)' : 'football-data.co.uk (resultados y cuotas reales)'}. Generado {new Date(data.generatedAt).toLocaleString('es-MX')} · {data.modelVersion}</p>
        </>
      )}
    </div>
  );
}
