import type { ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

export const COMPETITIONS: Array<{ code: string; name: string }> = [
  { code: '', name: 'Todas' },
  { code: 'PL', name: 'Premier League' },
  { code: 'PD', name: 'LaLiga' },
  { code: 'SA', name: 'Serie A' },
  { code: 'BL1', name: 'Bundesliga' },
  { code: 'FL1', name: 'Ligue 1' },
  { code: 'CL', name: 'Champions' },
  { code: 'EL', name: 'Europa League' }
];

export const MODEL_LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1'];

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`glass fade-in rounded-2xl p-4 sm:p-5 ${className}`}>{children}</div>;
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-display flex items-center gap-2 text-lg font-semibold uppercase tracking-wide text-text">
        <span className="h-4 w-1 rounded-full bg-accent" aria-hidden />
        {children}
      </h2>
      {aside}
    </div>
  );
}

type Tone = 'neutral' | 'good' | 'bad' | 'warn' | 'accent';
const toneClass: Record<Tone, string> = {
  neutral: 'border-line text-muted',
  good: 'border-good/40 text-good',
  bad: 'border-bad/40 text-bad',
  warn: 'border-warn/40 text-warn',
  accent: 'border-accent/50 text-accent'
};

export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${toneClass[tone]}`}>
      {children}
    </span>
  );
}

export function Spinner({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="glass fade-in flex flex-col items-center gap-3 rounded-2xl px-6 py-8 text-center">
      <img src="/img/vacio-balon.webp" alt="" width={120} height={120} className="h-28 w-28 object-contain opacity-90" loading="lazy" />
      <p className="max-w-sm text-sm text-muted">{children}</p>
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="rounded-2xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad" role="alert">
      {error}
    </div>
  );
}

export function Warnings({ items }: { items?: string[] }) {
  const list = [...new Set(items || [])];
  if (!list.length) return null;
  return (
    <ul className="space-y-1.5 rounded-2xl border border-warn/25 bg-warn/[0.07] px-4 py-3 text-xs leading-relaxed text-warn">
      {list.map(w => (
        <li key={w} className="flex gap-2">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{w}</span>
        </li>
      ))}
    </ul>
  );
}

export function Chips<T extends string>({ options, value, onChange }: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div className="no-scrollbar -mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="radiogroup">
      {options.map(o => (
        <button
          key={o.value || 'all'}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`shrink-0 whitespace-nowrap rounded-full border px-4 py-2 text-[13px] font-medium transition-colors ${
            value === o.value
              ? 'border-transparent bg-gradient-to-b from-accent to-accent-2 text-ink shadow-[0_6px_18px_-8px_rgba(255,160,70,0.8)]'
              : 'border-white/10 bg-white/[0.03] text-muted hover:border-accent/50 hover:text-text'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Crest({ src, name, size = 28 }: { src: string | null | undefined; name: string; size?: number }) {
  if (!src) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-[10px] font-semibold text-muted"
        style={{ width: size, height: size }}
        aria-hidden
      >
        {name.slice(0, 2).toUpperCase()}
      </span>
    );
  }
  return <img src={src} alt="" width={size} height={size} className="shrink-0 object-contain" loading="lazy" onError={e => ((e.target as HTMLImageElement).style.visibility = 'hidden')} />;
}

export function ProbRow({ label, model, market, final }: { label: string; model?: number | null; market?: number | null; final: number | null }) {
  const w = final != null ? Math.max(2, Math.round(final * 100)) : 0;
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
      <div className="text-sm">{label}</div>
      <div className="text-right text-sm font-semibold tabular-nums">{final != null ? `${(final * 100).toFixed(1)}%` : '—'}</div>
      <div className="col-span-2 h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div className="h-full rounded-full bg-gradient-to-r from-accent-2 to-accent" style={{ width: `${w}%` }} />
      </div>
      <div className="col-span-2 flex gap-4 text-[11px] text-muted tabular-nums">
        <span>Modelo: {model != null ? `${(model * 100).toFixed(1)}%` : '—'}</span>
        <span>Mercado: {market != null ? `${(market * 100).toFixed(1)}%` : '—'}</span>
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-black/25 px-3.5 py-3">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`font-display mt-0.5 text-2xl font-semibold tabular-nums ${tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : ''}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}
