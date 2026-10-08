export function pct(p: number | null | undefined, digits = 1): string {
  if (p == null || !Number.isFinite(p)) return '—';
  return `${(p * 100).toFixed(digits)}%`;
}

export function signedPct(p: number | null | undefined, digits = 1): string {
  if (p == null || !Number.isFinite(p)) return '—';
  const v = p * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
}

export function signedNum(v: number | null | undefined, digits = 1, suffix = ''): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`;
}

export function odds(o: number | null | undefined): string {
  if (o == null || !Number.isFinite(o)) return '—';
  return o.toFixed(2);
}

export function money(v: number | null | undefined, currency = 'MXN'): string {
  if (v == null || !Number.isFinite(v)) return '—';
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${v.toFixed(2)} ${currency}`;
  }
}

export function kickoffTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
}

export function kickoffDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
}

export function localToday(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function seasonLabel(code: string): string {
  return `20${code.slice(0, 2)}-${code.slice(2)}`;
}
