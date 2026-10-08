import { useEffect, useState } from 'react';
import { api } from '../api';
import type { BacktestBetting, BacktestLeague, BandRow, ScoreMetrics } from '../types';
import { Badge, Card, Chips, COMPETITIONS, ErrorBox, MODEL_LEAGUES, SectionTitle, Spinner, Stat } from '../components/ui';
import { odds, seasonLabel, signedNum } from '../lib/format';

const MARKET_LABEL: Record<string, string> = { '1x2': '1X2', over_under: 'Más/Menos 2.5', btts: 'Ambos marcan', double_chance: 'Doble oportunidad', asian_handicap: 'Hándicap asiático' };
const RESULT_LABEL: Record<string, string> = { won: 'Ganada', lost: 'Perdida', void: 'Nula', half_won: 'Media ganada', half_lost: 'Media perdida' };

function MetricsTable({ m, hasMarket }: { m: BacktestLeague['test']['metrics']; hasMarket: boolean }) {
  const rows: Array<[string, ScoreMetrics]> = [
    ['Modelo original', m.model],
    ['Modelo calibrado', m.calibrated],
    ...(hasMarket ? ([['Mercado sin margen', m.market]] as Array<[string, ScoreMetrics]>) : []),
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
          <tr className="border-b border-line/60 text-muted">
            <td className="py-2">Ambos marcan (original → calibrado)</td>
            <td className="py-2 text-right" colSpan={2}>{m.bttsModel.brier ?? '—'} → {m.bttsCalibrated.brier ?? '—'}</td>
            <td className="py-2 text-right" colSpan={3}>log-loss {m.bttsModel.logLoss ?? '—'} → {m.bttsCalibrated.logLoss ?? '—'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Bands({ raw, cal }: { raw: BandRow[]; cal: BandRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[440px] text-sm tabular-nums">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
            <th className="py-2 font-medium">Rango</th>
            <th className="py-2 text-right font-medium">Original: predicho</th><th className="py-2 text-right font-medium">Real</th>
            <th className="py-2 text-right font-medium">Calibrado: predicho</th><th className="py-2 text-right font-medium">Real</th>
          </tr>
        </thead>
        <tbody>
          {raw.map((r, i) => (
            <tr key={r.range} className="border-b border-line/60">
              <td className="py-1.5">{r.range}</td>
              <td className="py-1.5 text-right">{r.predictedPct ?? '—'}% <span className="text-[10px] text-muted">({r.samples})</span></td>
              <td className={`py-1.5 text-right ${r.predictedPct != null && r.actualPct != null && Math.abs(r.predictedPct - r.actualPct) > 4 ? 'text-warn' : ''}`}>{r.actualPct ?? '—'}%</td>
              <td className="py-1.5 text-right">{cal[i]?.predictedPct ?? '—'}% <span className="text-[10px] text-muted">({cal[i]?.samples ?? 0})</span></td>
              <td className="py-1.5 text-right">{cal[i]?.actualPct ?? '—'}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BettingCard({ b, title, note }: { b: BacktestBetting; title: string; note: string }) {
  return (
    <Card>
      <SectionTitle>{title}</SectionTitle>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Señales" value={b.bets} hint={b.hitRatePct != null ? `Acierto ${b.hitRatePct}%` : undefined} />
        <Stat label="Yield" value={signedNum(b.yieldPct, 1, '%')} tone={(b.yieldPct ?? 0) >= 0 ? 'good' : 'bad'} hint={`${signedNum(b.profitUnits, 2)} u · EV medio ${signedNum(b.avgEvPct, 1, '%')}`} />
        <Stat label="CLV medio" value={signedNum(b.avgClvPct, 2, '%')} tone={(b.avgClvPct ?? 0) > 0 ? 'good' : 'bad'} hint={b.clvPositivePct != null ? `${b.clvPositivePct}% con CLV > 0` : undefined} />
        <Stat label="Caída máxima" value={`${b.maxDrawdownUnits} u`} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {Object.entries(b.byMarket).map(([k, v]) => (
          <Badge key={k} tone={v.profit >= 0 ? 'good' : 'bad'}>{MARKET_LABEL[k] || k}: {v.bets} · {signedNum(v.profit, 1)} u</Badge>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted">{note}</p>
    </Card>
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
  const r = data?.rules;
  return (
    <div className="space-y-4">
      <Chips options={COMPETITIONS.filter(c => MODEL_LEAGUES.includes(c.code)).map(c => ({ value: c.code, label: c.name }))} value={competition} onChange={setCompetition} />
      <ErrorBox error={error} />
      {!data && !error && <Spinner label="Cargando backtest…" />}
      {data && t && r && (
        <>
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Badge tone="accent">Walk-forward sin fuga de información</Badge>
              <Badge>Entrenamiento: {data.trainSeasons.map(seasonLabel).join(', ')}</Badge>
              <Badge>Prueba: {data.testSeasons.map(seasonLabel).join(', ')}</Badge>
              {Object.entries(data.calibrationMaps).map(([g, m]) => <Badge key={g}>{MARKET_LABEL[g] || g}: {m.method}</Badge>)}
            </div>
            <p className="text-sm text-muted">
              Cada partido se predice con un modelo ajustado solo con partidos anteriores (ξ = {data.xi}). La calibración se ajusta con las
              temporadas de entrenamiento y se mide en {t.matches} partidos de prueba que nunca vio. Reglas del motor: EV ≥ {Math.round(r.minEv * 100)}%,
              diferencia con el mercado ≤ {Math.round(r.maxMarketGap * 100)} pts, cuotas {r.minOdds.toFixed(2)}–{r.maxOdds.toFixed(2)}, máximo {r.maxBetsPerJornada} por jornada.
            </p>
          </Card>

          <Card>
            <SectionTitle aside={data.betting ? <Badge tone={t.verdicts.calibratedBrier === 'Mejor que el mercado' ? 'good' : 'warn'}>{t.verdicts.calibratedBrier}</Badge> : <Badge>Sin cuotas históricas</Badge>}>
              Precisión en prueba
            </SectionTitle>
            <MetricsTable m={t.metrics} hasMarket={Boolean(data.betting)} />
            <p className="mt-2 text-[11px] text-muted">En Brier, log-loss y RPS, más bajo es mejor. El mercado son las cuotas medias de apertura sin margen.</p>
          </Card>

          {data.betting && data.bettingBestPrice ? (
            <>
              <BettingCard b={data.betting} title="Motor de valor en prueba · cuota media" note="Escenario conservador: la cuota media del mercado, que casi cualquier casa ofrece. CLV contra la cuota justa de cierre." />
              <BettingCard b={data.bettingBestPrice} title="Mismo motor · mejor cuota del mercado" note="Escenario optimista: requiere tener cuenta en muchas casas. La diferencia con el escenario anterior es el valor de buscar la mejor cuota." />
            </>
          ) : (
            <Card>
              <p className="text-sm text-muted">
                No hay cuotas históricas gratuitas para la Champions, así que aquí solo se mide la precisión del modelo y su calibración.
                La rentabilidad y el CLV se medirán con las señales reales del panel de rendimiento.
              </p>
            </Card>
          )}

          <Card>
            <SectionTitle>Calibración en prueba (todas las selecciones)</SectionTitle>
            <Bands raw={t.calibration.model} cal={t.calibration.calibrated} />
            <p className="mt-2 text-[11px] text-muted">Entre paréntesis, número de predicciones. En amarillo, desviaciones de más de 4 puntos.</p>
          </Card>

          {data.betting && data.betting.recentBets.length > 0 && (
            <Card>
              <SectionTitle>Últimas señales del backtest (cuota media)</SectionTitle>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                      <th className="py-2 font-medium">Fecha</th><th className="py-2 font-medium">Partido</th><th className="py-2 font-medium">Selección</th>
                      <th className="py-2 text-right font-medium">Modelo → calibrada</th><th className="py-2 text-right font-medium">Mercado</th>
                      <th className="py-2 text-right font-medium">Cuota</th><th className="py-2 text-right font-medium">EV</th><th className="py-2 text-right font-medium">CLV</th><th className="py-2 text-right font-medium">Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.betting.recentBets.map(b => (
                      <tr key={`${b.date}${b.home}${b.selection}`} className="border-b border-line/60">
                        <td className="whitespace-nowrap py-1.5 pr-2">{b.date}</td>
                        <td className="py-1.5">{b.home} {b.score} {b.away}</td>
                        <td className="py-1.5">{b.label}</td>
                        <td className="py-1.5 text-right">{b.rawProbabilityPct}% → {b.probabilityPct}%</td>
                        <td className="py-1.5 text-right">{b.marketPct}%</td>
                        <td className="py-1.5 text-right">{odds(b.odds)}</td>
                        <td className="py-1.5 text-right">{signedNum(b.evPct, 1, '%')}</td>
                        <td className="py-1.5 text-right">{signedNum(b.clvPct, 1, '%')}</td>
                        <td className={`py-1.5 text-right ${b.result === 'won' ? 'text-good' : b.result === 'lost' ? 'text-bad' : ''}`}>{RESULT_LABEL[b.result] || b.result}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <p className="text-[11px] text-muted">
            Datos: football-data.co.uk (LaLiga, resultados y cuotas) y openfootball (Champions, resultados). Generado {new Date(data.generatedAt).toLocaleString('es-MX')} · {data.modelVersion}
          </p>
        </>
      )}
    </div>
  );
}
