/** Escudo de MK Bets: monograma M+K que comparten el trazo central, dentro de un escudo. */
export function LogoMark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 64 72" width={size} height={(size * 72) / 64} className={className} role="img" aria-label="MK Bets">
      <defs>
        <linearGradient id="mk-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd08f" />
          <stop offset="1" stopColor="#ff8f3d" />
        </linearGradient>
        <linearGradient id="mk-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#141d28" />
          <stop offset="1" stopColor="#070b10" />
        </linearGradient>
      </defs>
      <path d="M32 3 L59 11 V34 C59 51.5 47 63.5 32 69 C17 63.5 5 51.5 5 34 V11 Z" fill="url(#mk-fill)" stroke="url(#mk-gold)" strokeWidth="3.5" strokeLinejoin="round" />
      <g fill="none" stroke="url(#mk-gold)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="15,48 15,24 24.5,37 34,24 34,48" />
        <line x1="34" y1="37" x2="49" y2="24" />
        <line x1="34" y1="37" x2="49" y2="48" />
      </g>
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-bold uppercase leading-none tracking-wide ${className}`}>
      MK <span className="text-accent">Bets</span>
    </span>
  );
}
