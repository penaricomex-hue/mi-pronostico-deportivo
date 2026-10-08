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
  return <div className={`rounded-xl border border-line bg-panel p-4 ${className}`}>{children}</div>;
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{children}</h2>
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
  return <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{children}</div>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="rounded-xl border border-bad/40 bg-bad/10 px-4 py-3 text-sm text-bad" role="alert">
      {error}
    </div>
  );
}

export function Warnings({ items }: { items?: string[] }) {
  const list = [...new Set(items || [])];
  if (!list.length) return null;
  return (
    <ul className="space-y-1 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-xs text-warn">
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
    <div className="flex flex-wrap gap-1.5" role="radiogroup">
      {options.map(o => (
        <button
          key={o.value || 'all'}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-full border px-3 py-1 text-xs transition-colors ${
            value === o.value ? 'border-accent bg-accent text-ink font-semibold' : 'border-line text-muted hover:border-accent/60 hover:text-text'
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
        className="inline-flex shrink-0 items-center justify-center rounded-full bg-line text-[10px] font-semibold text-muted"
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
      <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-accent" style={{ width: `${w}%` }} />
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
    <div className="rounded-lg border border-line bg-ink/40 px-3 py-2">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : ''}`}>{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}
