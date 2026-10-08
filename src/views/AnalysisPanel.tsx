import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import type { Analysis, Fixture, Pick, SelectionEval } from '../types';
import { Badge, Card, Crest, ErrorBox, ProbRow, Spinner, Warnings } from '../components/ui';
import { CalibrationNote } from './ValueView';
import { kickoffDate, kickoffTime, money, odds, pct, signedPct } from '../lib/format';
import type { BetsApi } from '../hooks/useBets';

function toPick(a: Analysis, s: SelectionEval): Pick {
  return {
    ...s,
    fixtureId: a.id, matchId: a.matchId, competitionCode: a.competitionCode, competitionSlug: a.competitionSlug,
    competition: a.competition, kickoff: a.kickoff, home: a.home, away: a.away, homeCrest: a.homeCrest, awayCrest: a.awayCrest,
    oddsCapturedAt: a.odds.capturedAt, dataQuality: a.dataQuality
  };
}

const MARKET_ORDER = ['1x2', 'double_chance', 'over_under', 'btts', 'asian_handicap'] as const;
const MARKET_LABEL: Record<string, string> = {
  '1x2': '1X2', double_chance: 'Doble oportunidad', over_under: 'Más/Menos 2.5', btts: 'Ambos marcan', asian_handicap: 'Hándicap asiático'
};

export function AnalysisPanel({ fixture, date, onClose, bets }: { fixture: Fixture; date: string; onClose: () => void; bets: BetsApi }) {
  const [data, setData] = useState<Analysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.analyze(fixture, date)
      .then(r => alive && setData(r.analysis))
      .catch(err => alive && setError((err as Error).message));
    return () => { alive = false; };
  }, [fixture, date]);

  const save = async (s: SelectionEval) => {
    if (!data) return;
    const stake = s.suggestedStake > 0 ? s.suggestedStake : s.flatStake;
    try {
      await bets.addPick(toPick(data, s), stake);
      setSaved(`${s.selection}:${s.line}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

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
            <Badge tone="neutral" title="Casa cuya cuota se usa para calcular el EV">
              Ejecución: {data.odds.executionMode === 'fixed' ? data.odds.executionBookmaker : 'mejor cuota no atípica'}
            </Badge>
            {data.bestValue ? <Badge tone="good">Apuesta con valor</Badge> : <Badge tone="neutral">Sin recomendación</Badge>}
          </div>

          {data.xg && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-line px-2 py-2"><div className="text-[11px] text-muted">Goles esperados local</div><div className="text-lg font-semibold tabular-nums">{data.xg.home.toFixed(2)}</div></div>
              <div className="rounded-lg border border-line px-2 py-2"><div className="text-[11px] text-muted">Marcador más probable</div><div className="text-lg font-semibold tabular-nums">{data.mostLikelyScore ? `${data.mostLikelyScore.home}-${data.mostLikelyScore.away}` : '—'}</div></div>
              <div className="rounded-lg border border-line px-2 py-2"><div className="text-[11px] text-muted">Goles esperados visitante</div><div className="text-lg font-semibold tabular-nums">{data.xg.away.toFixed(2)}</div></div>
            </div>
          )}

          <div className="space-y-3">
            <div className="text-xs text-muted">
              Barra = probabilidad calibrada (lo que históricamente ha pasado cuando el modelo dijo eso). Debajo: modelo original y mercado sin margen.
            </div>
            <ProbRow label="Gana local" model={data.probabilities.model?.home} market={data.probabilities.market?.home} final={data.probabilities.calibrated?.home ?? null} />
            <ProbRow label="Empate" model={data.probabilities.model?.draw} market={data.probabilities.market?.draw} final={data.probabilities.calibrated?.draw ?? null} />
            <ProbRow label="Gana visitante" model={data.probabilities.model?.away} market={data.probabilities.market?.away} final={data.probabilities.calibrated?.away ?? null} />
            <ProbRow label="Más de 2.5 goles" model={data.probabilities.model?.over25} market={data.probabilities.market?.over25} final={data.probabilities.calibrated?.over25 ?? null} />
            <ProbRow label="Ambos marcan" model={data.probabilities.model?.btts_yes} market={data.probabilities.market?.btts_yes} final={data.probabilities.calibrated?.btts_yes ?? null} />
          </div>

          {data.selections.length > 0 && (
            <div className="space-y-4">
              {MARKET_ORDER.map(mk => {
                const rows = data.selections.filter(s => s.market === mk);
                if (!rows.length) return null;
                return (
                  <div key={mk}>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{MARKET_LABEL[mk]}</div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead>
                          <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                            <th className="py-2 font-medium">Selección</th>
                            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium" title="Probabilidad de decisión: mezcla modelo + mercado">Prob.</th>
                            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Mercado</th>
                            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Cuota</th>
                            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">Mín.</th>
                            <th className="whitespace-nowrap py-2 pl-3 text-right font-medium">EV</th>
                            <th className="py-2 pl-3 font-medium">Decisión</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map(s => {
                            const key = `${s.selection}:${s.line}`;
                            return (
                              <tr key={key} className="border-b border-line/60 align-top">
                                <td className="py-2.5 pr-2">
                                  <div className="whitespace-nowrap">{s.label}</div>
                                  {(s.blend?.message || (s.calibration?.message && s.selection !== 'ah_home' && s.selection !== 'ah_away')) && (
                                    <details className="mt-1 text-[11px] text-muted">
                                      <summary className="cursor-pointer select-none">Calibración y mezcla</summary>
                                      {s.calibration?.message && s.selection !== 'ah_home' && s.selection !== 'ah_away' && <div className="mt-1 max-w-xs"><CalibrationNote message={s.calibration.message} /></div>}
                                      {s.blend?.message && <div className="mt-1 max-w-xs">{s.blend.message}</div>}
                                    </details>
                                  )}
                                </td>
                                <td className="whitespace-nowrap py-2.5 pl-3 text-right tabular-nums">
                                  {pct(s.probability)}
                                  <div className="text-[10px] text-muted">calibrada {pct(s.calibratedProbability)}</div>
                                  <div className="text-[10px] text-muted">modelo {pct(s.modelProbability)}</div>
                                  {s.pushProbability ? <div className="text-[10px] text-muted">nula {pct(s.pushProbability)}</div> : null}
                                </td>
                                <td className="whitespace-nowrap py-2.5 pl-3 text-right tabular-nums">
                                  {pct(s.marketProbability)}
                                  <div className={`text-[10px] ${s.marketGap != null && Math.abs(s.marketGap) > 0.1 ? 'text-warn' : 'text-muted'}`}>dif. {signedPct(s.marketGap)}</div>
                                </td>
                                <td className="whitespace-nowrap py-2.5 pl-3 text-right tabular-nums">
                                  {odds(s.executionOdds)}
                                  <div className="max-w-[90px] truncate text-[10px] text-muted">{s.executionBookmaker}</div>
                                </td>
                                <td className="whitespace-nowrap py-2.5 pl-3 text-right tabular-nums text-muted">{odds(s.minimumOdds)}</td>
                                <td className={`whitespace-nowrap py-2.5 pl-3 text-right tabular-nums ${s.ev > 0 ? 'text-good' : 'text-muted'}`}>{signedPct(s.ev)}</td>
                                <td className="py-2.5 pl-3">
                                  {s.recommended ? (
                                    <div className="space-y-1">
                                      <Badge tone="good">{s.reason}</Badge>
                                      <div className="text-[11px] text-muted">Stake: {money(s.suggestedStake, data.currency)}</div>
                                      <button type="button" onClick={() => save(s)} disabled={saved === key}
                                        className="text-[11px] text-accent hover:underline disabled:text-muted">
                                        {saved === key ? 'Guardada' : 'Registrar en Mis apuestas'}
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="max-w-[220px] text-[11px] text-muted">{s.reason}</div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
              <p className="text-[11px] text-muted">
                EV = probabilidad calibrada × cuota − 1. «Mín.» es la cuota mínima para alcanzar el EV exigido.
              </p>
            </div>
          )}

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
