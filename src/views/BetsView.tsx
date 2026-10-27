import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { BetStatus, Fixture, UserCriterion } from '../types';
import { Badge, Card, Chips, Empty, ErrorBox, Stat } from '../components/ui';
import { kickoffDate, money, odds, signedNum } from '../lib/format';
import type { BetsApi } from '../hooks/useBets';
import { api } from '../api';

const STATUS_LABEL: Record<BetStatus, string> = { pending: 'Pendiente', won: 'Ganada', lost: 'Perdida', void: 'Anulada', half_won: 'Media ganada', half_lost: 'Media perdida' };
const STATUS_TONE: Record<BetStatus, 'neutral' | 'good' | 'bad' | 'warn'> = { pending: 'neutral', won: 'good', lost: 'bad', void: 'warn', half_won: 'good', half_lost: 'bad' };

const PICKS: Array<{ value: string; label: string }> = [
  { value: 'home', label: 'Gana local' },
  { value: 'draw', label: 'Empate' },
  { value: 'away', label: 'Gana visitante' },
  { value: 'dc_1x', label: 'Local o empate' },
  { value: 'dc_x2', label: 'Empate o visitante' },
  { value: 'dc_12', label: 'Local o visitante' },
  { value: 'over25', label: 'Más de 2.5' },
  { value: 'under25', label: 'Menos de 2.5' },
  { value: 'btts_yes', label: 'Ambos anotan' },
  { value: 'btts_no', label: 'No ambos' },
  { value: 'ah_home', label: 'Hándicap local' },
  { value: 'ah_away', label: 'Hándicap visitante' }
];

const TAGS = [
  { id: 'forma', label: 'Forma reciente' },
  { id: 'bajas', label: 'Bajas o alineación' },
  { id: 'cuota', label: 'La cuota me parece alta' },
  { id: 'goles', label: 'Goles' },
  { id: 'localia', label: 'Localía' },
  { id: 'rival', label: 'El rival llega peor' },
  { id: 'contexto', label: 'Calendario o motivación' }
];

function todayLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

const field = 'w-full rounded-lg border border-line bg-black/20 px-3 py-2 text-sm';

export function BetsView({ bets, currency, defaultStake = 100 }: { bets: BetsApi; currency: string; defaultStake?: number }) {
  const [filter, setFilter] = useState<'all' | BetStatus>('all');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [competition, setCompetition] = useState('PD');
  const [date, setDate] = useState(todayLocal);
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [fixtureId, setFixtureId] = useState('');
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [kickoff, setKickoff] = useState(`${todayLocal()}T21:00`);
  const [selection, setSelection] = useState('home');
  const [line, setLine] = useState('-0.5');
  const [price, setPrice] = useState('1.90');
  const [stake, setStake] = useState(String(defaultStake));
  const [reason, setReason] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<UserCriterion[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.bets.criteria().then(r => setCriteria(r.groups)).catch(() => {});
  }, [bets.bets]);

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

  const loadFixtures = () => run(async () => {
    const r = await api.fixtures(date, competition);
    setFixtures(r.fixtures);
    setMessage(r.fixtures.length ? `${r.fixtures.length} partidos de fútbol.` : 'No hay partidos ese día.');
  });

  const chooseFixture = (id: string) => {
    setFixtureId(id);
    const f = fixtures.find(x => x.id === id);
    if (!f) return;
    setHome(f.home);
    setAway(f.away);
    const local = new Date(new Date(f.kickoff).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    setKickoff(local);
  };

  const submit = () => run(async () => {
    if (reason.trim().length < 8) throw new Error('Escribe por qué crees en esta apuesta.');
    setBusy(true);
    try {
      await bets.addManual({
        fixtureId: fixtureId || null,
        competition,
        kickoff: new Date(kickoff).toISOString(),
        home: home.trim(),
        away: away.trim(),
        selection,
        odds: Number(price),
        stake: Number(stake),
        line: selection.startsWith('ah_') ? Number(line) : null,
        reason: reason.trim(),
        tags
      });
      setReason('');
      setTags([]);
      setMessage('Apuesta guardada. Cuando se liquide, entra en el criterio del modelo.');
    } finally {
      setBusy(false);
    }
  });

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="mb-1 text-sm font-semibold">Registrar apuesta de fútbol</h3>
        <p className="mb-3 text-xs text-muted">Solo LaLiga y Champions. El motivo se guarda y, al conocer el resultado, ajusta el criterio con el que la app propone apuestas. No mueve el umbral hasta que haya al menos 8 resultados en ese mercado.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-muted">Competición
            <select className={field} value={competition} onChange={e => setCompetition(e.target.value)}>
              <option value="PD">LaLiga</option>
              <option value="CL">Champions</option>
            </select>
          </label>
          <label className="text-xs text-muted">Día
            <input className={field} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </label>
          <div className="sm:col-span-2 flex flex-wrap items-end gap-2">
            <button type="button" className="rounded-lg border border-line px-3 py-2 text-xs hover:border-accent" onClick={loadFixtures}>Cargar partidos</button>
            {fixtures.length > 0 && (
              <select className={`${field} min-w-0 flex-1`} value={fixtureId} onChange={e => chooseFixture(e.target.value)}>
                <option value="">Elegir partido…</option>
                {fixtures.map(f => <option key={f.id} value={f.id}>{f.home} vs {f.away}</option>)}
              </select>
            )}
          </div>
          <label className="text-xs text-muted">Local
            <input className={field} value={home} onChange={e => setHome(e.target.value)} placeholder="Equipo local" />
          </label>
          <label className="text-xs text-muted">Visitante
            <input className={field} value={away} onChange={e => setAway(e.target.value)} placeholder="Equipo visitante" />
          </label>
          <label className="text-xs text-muted">Inicio
            <input className={field} type="datetime-local" value={kickoff} onChange={e => setKickoff(e.target.value)} />
          </label>
          <label className="text-xs text-muted">Selección
            <select className={field} value={selection} onChange={e => setSelection(e.target.value)}>
              {PICKS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          {selection.startsWith('ah_') && (
            <label className="text-xs text-muted">Línea del local
              <input className={field} value={line} onChange={e => setLine(e.target.value)} inputMode="decimal" />
            </label>
          )}
          <label className="text-xs text-muted">Cuota
            <input className={field} value={price} onChange={e => setPrice(e.target.value)} inputMode="decimal" />
          </label>
          <label className="text-xs text-muted">Stake ({currency})
            <input className={field} value={stake} onChange={e => setStake(e.target.value)} inputMode="decimal" />
          </label>
        </div>
        <div className="mt-3">
          <div className="mb-1 text-xs text-muted">¿Por qué la haces?</div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {TAGS.map(t => {
              const on = tags.includes(t.id);
              return (
                <button key={t.id} type="button" onClick={() => setTags(on ? tags.filter(x => x !== t.id) : [...tags, t.id])}
                  className={`rounded-full border px-2.5 py-1 text-[11px] ${on ? 'border-accent text-accent' : 'border-line text-muted'}`}>
                  {t.label}
                </button>
              );
            })}
          </div>
          <textarea className={field} rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Por ejemplo: el local llega mejor y la cuota no lo refleja." />
        </div>
        <button type="button" disabled={busy} onClick={submit} className="mt-3 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-ink disabled:opacity-60">
          Guardar y enseñar a la app
        </button>
      </Card>

      {criteria.length > 0 && (
        <Card>
          <h3 className="mb-2 text-sm font-semibold">Lo que ya aprendió de ti</h3>
          <ul className="space-y-1 text-xs text-muted">
            {criteria.map(g => (
              <li key={g.key}>
                {g.groupLabel}: {g.n} apuestas, acierto {g.hitPct}%
                {g.minEvDelta === 0 ? ' · aún no mueve el umbral' : g.minEvDelta < 0 ? ' · afloja el EV mínimo 1 punto' : ' · aprieta el EV mínimo 1 punto'}
                {g.topTagLabel ? ` · mejor motivo: ${g.topTagLabel}` : ''}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm text-muted">
            {bets.mode === 'server' ? 'Guardadas en el servidor. Si eliges el partido de la lista, la app compara tu apuesta con el modelo.' : 'Guardadas solo en este navegador. Sin base de datos no hay aprendizaje ni correo.'}
          </div>
          <div className="flex gap-2">
            <button type="button" className="rounded-lg border border-line px-3 py-1.5 text-xs hover:border-accent"
              onClick={() => run(async () => { const r = await api.reports.latest(); setReport(r.text); })}>
              Ver informe
            </button>
            <button type="button" className="rounded-lg border border-line px-3 py-1.5 text-xs hover:border-accent"
              onClick={() => run(async () => { const r = await api.reports.send(); setMessage(`Informe enviado a ${r.to}.`); })}>
              Enviar correo
            </button>
            {bets.mode === 'server' && (
              <button type="button" className="rounded-lg border border-line px-3 py-1.5 text-xs hover:border-accent"
                onClick={() => run(async () => { const r = await bets.autoSettle(); setMessage(`${r.settled} de ${r.checked} apuestas liquidadas.`); })}>
                Liquidar terminadas
              </button>
            )}
          </div>
        </div>
        {report && <pre className="mb-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-line p-3 text-[11px] text-muted">{report}</pre>}
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
                    {b.reason && <div className="mt-1 text-[11px] text-muted">Por qué: {b.reason}</div>}
                    {b.source === 'manual' && <div className="text-[11px] text-accent">{b.learnedAt ? 'Ya entró en el criterio' : 'Manual · enseña al liquidarse'}</div>}
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
