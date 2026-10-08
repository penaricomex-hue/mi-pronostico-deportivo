import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import type { Analysis, Fixture, Pick, SelectionEval } from '../types';
import { Badge, Card, Crest, ErrorBox, ProbRow, Spinner, Warnings } from '../components/ui';
import { kickoffDate, kickoffTime, money, odds, pct, signedPct } from '../lib/format';
import type { BetsApi } from '../hooks/useBets';

function toPick(a: Analysis, s: SelectionEval): Pick {
  return {
    fixtureId: a.id, competitionCode: a.competitionCode, competition: a.competition, kickoff: a.kickoff,
    home: a.home, away: a.away, homeCrest: a.homeCrest, awayCrest: a.awayCrest, selection: s.selection,
    market: s.market, label: s.label, probability: s.probability, fairOdds: s.fairOdds, bestOdds: s.bestOdds,
    bestBookmaker: s.bestBookmaker, referenceOdds: s.referenceOdds, bookmakerCount: s.bookmakerCount, ev: s.ev,
    suggestedStake: s.suggestedStake, flatStake: s.flatStake, validated: s.isValue, reasons: s.reasons,
    dataQuality: a.dataQuality
  };
}

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
      setSaved(s.selection);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Card className="relative">
      <button type="button" onClick={onClose} className="absolute right-3 top-3 rounded p-1 text-muted hover:text-text" aria-label="Cerrar análisis">
        <X className="h-4 w-4" />
      </button>

      <div className="mb-4 flex items-center justify-center gap-4 pr-6">
        <div className="flex flex-1 items-center justify-end gap-2 text-right">
          <span className="font-semibold">{fixture.home}</span>
          <Crest src={fixture.homeCrest} name={fixture.home} size={36} />
        </div>
        <div className="text-center text-xs text-muted">
          <div>{kickoffDate(fixture.kickoff)}</div>
          <div className="font-semibold text-text">{kickoffTime(fixture.kickoff)}</div>
        </div>
        <div className="flex flex-1 items-center gap-2">
          <Crest src={fixture.awayCrest} name={fixture.away} size={36} />
          <span className="font-semibold">{fixture.away}</span>
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
            <Badge tone={data.league.valueEnabled ? 'good' : 'neutral'} title="Según el backtest fuera de muestra">
              {data.league.valueEnabled ? 'Liga con ventaja validada' : 'Liga sin ventaja validada'}
            </Badge>
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
              Probabilidad final = {Math.round(data.weights.w1x2 * 100)}% modelo + {100 - Math.round(data.weights.w1x2 * 100)}% mercado (1X2), peso aprendido en el backtest.
            </div>
            <ProbRow label="Gana local" model={data.probabilities.model?.home} market={data.probabilities.market?.home} final={data.probabilities.final.home} />
            <ProbRow label="Empate" model={data.probabilities.model?.draw} market={data.probabilities.market?.draw} final={data.probabilities.final.draw} />
            <ProbRow label="Gana visitante" model={data.probabilities.model?.away} market={data.probabilities.market?.away} final={data.probabilities.final.away} />
            <ProbRow label="Más de 2.5 goles" model={data.probabilities.model?.over25} market={data.probabilities.market?.over25} final={data.probabilities.final.over25} />
          </div>

          {data.selections.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                    <th className="py-2 font-medium">Mercado</th>
                    <th className="py-2 text-right font-medium">Prob.</th>
                    <th className="py-2 text-right font-medium">Cuota justa</th>
                    <th className="py-2 text-right font-medium">Mejor cuota</th>
                    <th className="py-2 text-right font-medium">EV</th>
                    <th className="py-2 pl-3 font-medium">Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {data.selections.map(s => (
                    <tr key={s.selection} className="border-b border-line/60 align-top">
                      <td className="py-2">{s.label}</td>
                      <td className="py-2 text-right tabular-nums">{pct(s.probability)}</td>
                      <td className="py-2 text-right tabular-nums">{odds(s.fairOdds)}</td>
                      <td className="py-2 text-right tabular-nums">
                        {odds(s.bestOdds)}
                        <div className="text-[10px] text-muted">{s.bestBookmaker}</div>
                      </td>
                      <td className={`py-2 text-right tabular-nums ${s.ev > 0 ? 'text-good' : 'text-muted'}`}>{signedPct(s.ev)}</td>
                      <td className="py-2 pl-3">
                        {s.isValue ? (
                          <div className="space-y-1">
                            <Badge tone="good">Valor</Badge>
                            <div className="text-[11px] text-muted">Stake: {money(s.suggestedStake, data.currency)}</div>
                          </div>
                        ) : (
                          <div className="text-[11px] text-muted">{s.reasons.join(' · ')}</div>
                        )}
                        <button
                          type="button"
                          onClick={() => save(s)}
                          disabled={saved === s.selection}
                          className="mt-1 text-[11px] text-accent hover:underline disabled:text-muted"
                        >
                          {saved === s.selection ? 'Guardada' : 'Simular apuesta'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
