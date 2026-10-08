import { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { BetStatus } from '../types';
import { Badge, Card, Chips, Empty, ErrorBox, Stat } from '../components/ui';
import { kickoffDate, money, odds, signedNum } from '../lib/format';
import type { BetsApi } from '../hooks/useBets';

const STATUS_LABEL: Record<BetStatus, string> = { pending: 'Pendiente', won: 'Ganada', lost: 'Perdida', void: 'Anulada', half_won: 'Media ganada', half_lost: 'Media perdida' };
const STATUS_TONE: Record<BetStatus, 'neutral' | 'good' | 'bad' | 'warn'> = { pending: 'neutral', won: 'good', lost: 'bad', void: 'warn', half_won: 'good', half_lost: 'bad' };

export function BetsView({ bets, currency }: { bets: BetsApi; currency: string }) {
  const [filter, setFilter] = useState<'all' | BetStatus>('all');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = bets.bets.filter(b => filter === 'all' || b.status === filter);
  const stats = useMemo(() => {
    const settled = bets.bets.filter(b => ['won', 'lost', 'half_won', 'half_lost'].includes(b.status));
    const staked = settled.reduce((s, b) => s + b.stake, 0);
    const profit = settled.reduce((s, b) => s + (b.profit || 0), 0);
    const clv = bets.bets.filter(b => b.clvPct != null);
    return {
      staked, profit,
      roi: staked ? (100 * profit) / staked : null,
      hit: settled.length ? (100 * settled.filter(b => b.status === 'won' || b.status === 'half_won').length) / settled.length : null,
      clv: clv.length ? clv.reduce((s, b) => s + (b.clvPct || 0), 0) / clv.length : null,
      clvN: clv.length,
      pending: bets.bets.filter(b => b.status === 'pending').length
    };
  }, [bets.bets]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (err) { setError((err as Error).message); }
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-muted">
            {bets.mode === 'server' ? 'Guardadas en el servidor (PostgreSQL), con liquidación automática.' : 'Guardadas solo en este navegador. Configura DATABASE_URL para liquidación automática y CLV.'}
          </div>
          {bets.mode === 'server' && (
            <button type="button" className="rounded-lg border border-line px-3 py-1.5 text-xs hover:border-accent"
              onClick={() => run(async () => { const r = await bets.autoSettle(); setMessage(`${r.settled} de ${r.checked} apuestas liquidadas.`); })}>
              Liquidar terminadas
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Pendientes" value={stats.pending} />
          <Stat label="Apostado" value={money(stats.staked, currency)} />
          <Stat label="Resultado" value={money(stats.profit, currency)} tone={stats.profit >= 0 ? 'good' : 'bad'} />
          <Stat label="ROI" value={signedNum(stats.roi, 1, '%')} hint={stats.hit != null ? `Acierto ${stats.hit.toFixed(1)}%` : undefined} />
          <Stat label="CLV medio" value={signedNum(stats.clv, 2, '%')} hint={stats.clvN ? `${stats.clvN} con cierre` : 'Sin cuotas de cierre'} />
        </div>
      </Card>

      {message && <div className="text-xs text-good">{message}</div>}
      <ErrorBox error={error || bets.error} />

      <Chips
        options={[{ value: 'all', label: 'Todas' }, { value: 'pending', label: 'Pendientes' }, { value: 'won', label: 'Ganadas' }, { value: 'lost', label: 'Perdidas' }, { value: 'void', label: 'Anuladas' }]}
        value={filter}
        onChange={v => setFilter(v as typeof filter)}
      />

      {list.length === 0 ? <Empty>No hay apuestas en esta vista.</Empty> : (
        <ul className="space-y-2">
          {list.map(b => (
            <li key={b.id}>
              <Card className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">{b.home} vs {b.away}</div>
                    <div className="text-xs text-muted">{b.label} @ {odds(b.odds)} · {kickoffDate(b.kickoff || b.matchDate)} · {money(b.stake, b.currency || currency)}</div>
                    {b.legs && <div className="mt-1 text-[11px] text-muted">{b.legs.map(l => `${l.home}-${l.away}: ${l.label}${l.status && l.status !== 'pending' ? ` (${STATUS_LABEL[l.status]})` : ''}`).join(' · ')}</div>}
                    {b.clvPct != null && <div className="text-[11px] text-muted">Cierre {odds(b.closingOdds)} · CLV {signedNum(b.clvPct, 1, '%')}</div>}
                  </div>
                  <div className="flex items-center gap-2">
                    {b.score && <span className="text-xs tabular-nums text-muted">{b.score}</span>}
                    <Badge tone={STATUS_TONE[b.status]}>{STATUS_LABEL[b.status]}</Badge>
                    {b.profit != null && b.status !== 'pending' && <span className={`text-xs tabular-nums ${b.profit >= 0 ? 'text-good' : 'text-bad'}`}>{money(b.profit, b.currency || currency)}</span>}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
                  {(['won', 'lost', 'void', 'pending'] as BetStatus[]).filter(s => s !== b.status).map(s => (
                    <button key={s} type="button" className="text-muted hover:text-accent" onClick={() => run(() => bets.settle(b.id, s))}>
                      Marcar {STATUS_LABEL[s].toLowerCase()}
                    </button>
                  ))}
                  <button type="button" className="ml-auto text-muted hover:text-bad" aria-label="Eliminar apuesta" onClick={() => run(() => bets.remove(b.id))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
