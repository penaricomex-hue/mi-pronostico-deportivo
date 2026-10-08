import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Status } from '../types';
import { Badge, Card, Chips, COMPETITIONS, ErrorBox, MODEL_LEAGUES, SectionTitle, Spinner } from '../components/ui';

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return <Badge tone={ok ? 'good' : 'warn'}>{label}: {ok ? 'sí' : 'no'}</Badge>;
}

export function StatusView({ status, error }: { status: Status | null; error: string | null }) {
  const [league, setLeague] = useState('PD');
  const [ratings, setRatings] = useState<Awaited<ReturnType<typeof api.ratings>> | null>(null);
  const [ratingsError, setRatingsError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRatings(null);
    setRatingsError(null);
    api.ratings(league).then(r => alive && setRatings(r)).catch(err => alive && setRatingsError((err as Error).message));
    return () => { alive = false; };
  }, [league]);

  return (
    <div className="space-y-4">
      <ErrorBox error={error} />
      {!status && !error && <Spinner />}
      {status && (
        <Card>
          <SectionTitle>Configuración</SectionTitle>
          <div className="flex flex-wrap gap-2">
            <Flag ok={status.config.footballDataConfigured} label="football-data.org" />
            <Flag ok={status.config.oddsApiConfigured} label="The Odds API" />
            <Flag ok={status.config.databaseConfigured} label="PostgreSQL" />
            <Flag ok={status.persistentStore} label="Caché persistente" />
            <Flag ok={status.config.bigBallsConfigured} label="Big Balls" />
            <Flag ok={status.config.trackClosingOdds} label="Cuota de cierre" />
          </div>
          <div className="mt-3 grid gap-1 text-xs text-muted sm:grid-cols-2">
            <div>Modelo: {status.modelVersion} · {status.modelName}</div>
            <div>Bankroll {status.config.bankroll} {status.config.currency} · Kelly ×{status.config.kellyFraction} · tope {(status.config.maxStakePct * 100).toFixed(1)}%</div>
            <div>The Odds API: {status.providers.oddsApi.remaining ?? '?'} créditos restantes · hoy {status.providers.oddsApi.todayUsed}/{status.providers.oddsApi.dailyBudget}</div>
            <div>football-data.org: {status.providers.footballData.calls} llamadas · {status.providers.footballData.limiter.usedInWindow}/{status.providers.footballData.limiter.limit} en el último minuto</div>
          </div>
          {status.providers.oddsApi.blocked && <div className="mt-2 text-xs text-warn">{status.providers.oddsApi.blockedReason}</div>}
          {status.unresolvedTeams.length > 0 && (
            <div className="mt-2 text-xs text-warn">Equipos sin resolver (añadir a data/teams.json): {status.unresolvedTeams.join(', ')}</div>
          )}
        </Card>
      )}

      <Card>
        <SectionTitle>Fuerza de los equipos (modelo actual)</SectionTitle>
        <Chips options={COMPETITIONS.filter(c => MODEL_LEAGUES.includes(c.code)).map(c => ({ value: c.code, label: c.name }))} value={league} onChange={setLeague} />
        <ErrorBox error={ratingsError} />
        {!ratings && !ratingsError && <Spinner />}
        {ratings && (
          <>
            <div className="mt-3 text-xs text-muted">
              {ratings.matches} partidos · ventaja local ×{ratings.homeAdvantage} · ρ = {ratings.rho} · actualizado al {ratings.asOf}
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[380px] text-sm tabular-nums">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase text-muted">
                    <th className="py-2 font-medium">#</th><th className="py-2 font-medium">Equipo</th>
                    <th className="py-2 text-right font-medium" title="Multiplicador de goles a favor (1 = promedio)">Ataque</th>
                    <th className="py-2 text-right font-medium" title="Multiplicador de goles en contra (más bajo es mejor)">Defensa</th>
                    <th className="py-2 text-right font-medium">Partidos efectivos</th>
                  </tr>
                </thead>
                <tbody>
                  {ratings.teams.map((t, i) => (
                    <tr key={t.name} className="border-b border-line/60">
                      <td className="py-1.5 text-muted">{i + 1}</td>
                      <td className="py-1.5">{t.name}</td>
                      <td className="py-1.5 text-right">{t.attack.toFixed(2)}</td>
                      <td className="py-1.5 text-right">{t.defense.toFixed(2)}</td>
                      <td className="py-1.5 text-right text-muted">{t.effectiveMatches}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </Card>

      <Card>
        <SectionTitle>Cómo funciona</SectionTitle>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted">
          <li>Un modelo Dixon-Coles se ajusta con 3 temporadas reales de cada liga, dando más peso a los partidos recientes.</li>
          <li>Sus probabilidades se mezclan con las del mercado (cuotas sin margen). El peso de cada fuente se aprende en el backtest.</li>
          <li>Una selección es "valor" solo si la mejor cuota supera la probabilidad final con EV ≥ 2%, hay al menos 3 casas, la cuota no es atípica y la liga demostró ventaja fuera de muestra.</li>
          <li>El stake sugerido es Kelly fraccional sobre tu bankroll, con tope por apuesta.</li>
          <li>Mide tu ventaja con el CLV (cuota tomada frente a la de cierre), no solo con el ROI de pocas apuestas.</li>
        </ol>
        <p className="mt-3 text-xs text-muted">Herramienta de análisis estadístico. No garantiza resultados. Apuesta con responsabilidad.</p>
      </Card>
    </div>
  );
}
