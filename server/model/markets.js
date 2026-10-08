/**
 * Mercados habilitados y sus probabilidades.
 *
 *   1x2             home | draw | away
 *   double_chance   dc_1x | dc_12 | dc_x2
 *   over_under      over25 | under25           (solo línea 2.5)
 *   btts            btts_yes | btts_no
 *   asian_handicap  ah_home@L | ah_away@L      (L = línea del propio equipo)
 *
 * Probabilidades del modelo: salen de la matriz de marcadores Dixon-Coles.
 * Probabilidades de mercado: consenso de varias casas SIN margen (devig por casa
 * y promedio). La doble oportunidad se deriva del 1X2 sin margen.
 */
import { devig } from './market.js';

export const MARKETS = ['1x2', 'double_chance', 'over_under', 'btts', 'asian_handicap'];

export const MARKET_LABELS = {
  '1x2': '1X2',
  double_chance: 'Doble oportunidad',
  over_under: 'Más/Menos 2.5',
  btts: 'Ambos anotan',
  asian_handicap: 'Hándicap asiático'
};

export const FIXED_SELECTIONS = {
  '1x2': ['home', 'draw', 'away'],
  double_chance: ['dc_1x', 'dc_12', 'dc_x2'],
  over_under: ['over25', 'under25'],
  btts: ['btts_yes', 'btts_no']
};

const BASE_LABELS = {
  home: 'Gana local', draw: 'Empate', away: 'Gana visitante',
  dc_1x: 'Local o empate (1X)', dc_12: 'Local o visitante (12)', dc_x2: 'Empate o visitante (X2)',
  over25: 'Más de 2.5 goles', under25: 'Menos de 2.5 goles',
  btts_yes: 'Ambos anotan: Sí', btts_no: 'Ambos anotan: No'
};

/** Grupo de calibración (por competición y mercado). */
export const CALIBRATION_GROUP = {
  '1x2': '1x2',
  double_chance: 'double_chance',
  over_under: 'over_under',
  btts: 'btts',
  asian_handicap: 'asian_handicap'
};

export function fmtLine(x) {
  const v = Math.round(Number(x) * 4) / 4;
  if (!Number.isFinite(v)) return null;
  if (v === 0) return '0';
  return v > 0 ? `+${v}` : String(v);
}

export function ahSelection(side, line) {
  return `ah_${side}@${fmtLine(line)}`;
}

export function parseAh(selection) {
  const m = String(selection).match(/^ah_(home|away)@([+-]?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { side: m[1], line: Number(m[2]) };
}

export function marketOf(selection) {
  if (parseAh(selection)) return 'asian_handicap';
  for (const [m, sels] of Object.entries(FIXED_SELECTIONS)) if (sels.includes(selection)) return m;
  return null;
}

export function selectionLabel(selection) {
  const ah = parseAh(selection);
  if (ah) return `Hándicap ${ah.side === 'home' ? 'local' : 'visitante'} ${fmtLine(ah.line)}`;
  return BASE_LABELS[selection] || selection;
}

/** Equivalente al cambiar local por visitante (cuando The Odds API invierte el partido). */
export function swapSelection(selection) {
  const ah = parseAh(selection);
  if (ah) return ahSelection(ah.side === 'home' ? 'away' : 'home', ah.line);
  return { home: 'away', away: 'home', dc_1x: 'dc_x2', dc_x2: 'dc_1x' }[selection] || selection;
}

/** ¿La línea es entera, media o de cuarto? Las de cuarto se dividen en dos apuestas. */
function subLines(line) {
  const q = Math.round(line * 4);
  if (q % 2 === 0) return [line];
  return [line - 0.25, line + 0.25];
}

/**
 * Hándicap asiático desde la matriz. Devuelve:
 *   a = fracción esperada del stake que gana
 *   b = fracción esperada del stake que pierde
 *   probability = a / (a + b)  (probabilidad "justa" excluyendo devoluciones)
 *   stakeAtRisk = a + b       (parte del stake que no se devuelve)
 */
export function asianHandicapFromMatrix(matrix, side, line) {
  let a = 0, b = 0;
  const parts = subLines(line);
  for (let h = 0; h < matrix.length; h++) {
    for (let g = 0; g < matrix[h].length; g++) {
      const p = matrix[h][g];
      if (!p) continue;
      const diff = side === 'home' ? h - g : g - h;
      for (const l of parts) {
        const d = diff + l;
        if (d > 0) a += p / parts.length;
        else if (d < 0) b += p / parts.length;
      }
    }
  }
  const risk = a + b;
  return { a, b, probability: risk > 0 ? a / risk : null, stakeAtRisk: risk };
}

/** Probabilidades del modelo para todos los mercados fijos. */
export function modelFixedProbabilities(matrix) {
  let home = 0, draw = 0, away = 0, over = 0, btts = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const p = matrix[h][a];
      if (h > a) home += p; else if (h === a) draw += p; else away += p;
      if (h + a >= 3) over += p;
      if (h >= 1 && a >= 1) btts += p;
    }
  }
  return {
    home, draw, away,
    dc_1x: home + draw, dc_12: home + away, dc_x2: draw + away,
    over25: over, under25: 1 - over,
    btts_yes: btts, btts_no: 1 - btts
  };
}

/** Pares de selecciones complementarias para quitar el margen. */
export function devigGroups(selections) {
  const groups = [['home', 'draw', 'away'], ['over25', 'under25'], ['btts_yes', 'btts_no']];
  const ahLines = new Set();
  for (const s of selections) {
    const ah = parseAh(s);
    if (ah && ah.side === 'home') ahLines.add(ah.line);
  }
  for (const l of ahLines) groups.push([ahSelection('home', l), ahSelection('away', -l)]);
  return groups;
}

/**
 * Consenso de mercado sin margen a partir de las cuotas por casa.
 * @param {Array<{bookmaker:string, prices:Record<string,number>}>} books
 * @param {{excludeBookmakers?: string[]}} opts  (Caliente MX nunca entra en el consenso)
 * @returns {{probs: Record<string,number>, books: Record<string,number>}}
 */
export function marketConsensus(books, { excludeBookmakers = ['caliente_mx'] } = {}) {
  const usable = books.filter(b => !excludeBookmakers.includes(b.bookmaker));
  const allSels = new Set(usable.flatMap(b => Object.keys(b.prices || {})));
  const probs = {};
  const counts = {};
  for (const keys of devigGroups([...allSels])) {
    const acc = keys.map(() => 0);
    let n = 0;
    for (const b of usable) {
      const odds = keys.map(k => b.prices?.[k]);
      if (odds.some(o => !(o > 1))) continue;
      const dv = devig(odds);
      if (!dv) continue;
      dv.probs.forEach((p, i) => { acc[i] += p; });
      n++;
    }
    if (!n) continue;
    keys.forEach((k, i) => { probs[k] = acc[i] / n; counts[k] = n; });
  }
  if (probs.home != null) {
    probs.dc_1x = probs.home + probs.draw;
    probs.dc_12 = probs.home + probs.away;
    probs.dc_x2 = probs.draw + probs.away;
    counts.dc_1x = counts.dc_12 = counts.dc_x2 = counts.home;
  }
  return { probs, books: counts };
}

/** Cuota media (con margen) del mercado para una selección; referencia para comparar con Caliente. */
export function averageOdds(books, selection, { excludeBookmakers = ['caliente_mx'] } = {}) {
  const v = books.filter(b => !excludeBookmakers.includes(b.bookmaker)).map(b => b.prices?.[selection]).filter(o => o > 1);
  if (!v.length) return null;
  return v.reduce((s, o) => s + o, 0) / v.length;
}

/** Resultado de una selección con el marcador final. Devuelve 'won' | 'lost' | 'void' | 'half_won' | 'half_lost'. */
export function settleSelection(selection, hg, ag) {
  if (!Number.isFinite(hg) || !Number.isFinite(ag)) return null;
  const t = hg + ag;
  const ah = parseAh(selection);
  if (ah) {
    const diff = ah.side === 'home' ? hg - ag : ag - hg;
    const parts = subLines(ah.line).map(l => Math.sign(diff + l));
    const score = parts.reduce((s, x) => s + x, 0) / parts.length; // 1, 0.5, 0, -0.5, -1
    if (score === 1) return 'won';
    if (score === -1) return 'lost';
    if (score === 0) return 'void';
    return score > 0 ? 'half_won' : 'half_lost';
  }
  switch (selection) {
    case 'home': return hg > ag ? 'won' : 'lost';
    case 'draw': return hg === ag ? 'won' : 'lost';
    case 'away': return ag > hg ? 'won' : 'lost';
    case 'dc_1x': return hg >= ag ? 'won' : 'lost';
    case 'dc_12': return hg !== ag ? 'won' : 'lost';
    case 'dc_x2': return ag >= hg ? 'won' : 'lost';
    case 'over25': return t >= 3 ? 'won' : 'lost';
    case 'under25': return t < 3 ? 'won' : 'lost';
    case 'btts_yes': return hg > 0 && ag > 0 ? 'won' : 'lost';
    case 'btts_no': return hg === 0 || ag === 0 ? 'won' : 'lost';
    default: return null;
  }
}

/** Beneficio por unidad de stake según el resultado. */
export function profitPerUnit(result, odds) {
  const o = Number(odds);
  switch (result) {
    case 'won': return o - 1;
    case 'half_won': return (o - 1) / 2;
    case 'void': return 0;
    case 'half_lost': return -0.5;
    case 'lost': return -1;
    default: return 0;
  }
}
