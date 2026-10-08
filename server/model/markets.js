/**
 * Mercados habilitados en v10 y su relación con la matriz de marcadores.
 *
 *   1x2              home, draw, away
 *   double_chance    dc_1x, dc_x2, dc_12
 *   over_under       over25, under25            (línea 2.5)
 *   btts             btts_yes, btts_no
 *   asian_handicap   ah_home, ah_away           (línea principal; solo .0 y .5)
 *
 * El hándicap asiático se expresa SIEMPRE con la línea del local (p. ej. -0.5
 * significa local -0.5 / visitante +0.5).
 */

export const MARKETS = {
  '1x2': { label: '1X2', selections: ['home', 'draw', 'away'], calibrationGroup: '1x2' },
  double_chance: { label: 'Doble oportunidad', selections: ['dc_1x', 'dc_x2', 'dc_12'], calibrationGroup: '1x2' },
  over_under: { label: 'Más/Menos 2.5', selections: ['over25', 'under25'], calibrationGroup: 'over_under' },
  btts: { label: 'Ambos anotan', selections: ['btts_yes', 'btts_no'], calibrationGroup: 'btts' },
  asian_handicap: { label: 'Hándicap asiático', selections: ['ah_home', 'ah_away'], calibrationGroup: null }
};

export const ENABLED_MARKETS = Object.keys(MARKETS);

export const SELECTION_MARKET = Object.fromEntries(
  Object.entries(MARKETS).flatMap(([m, def]) => def.selections.map(s => [s, m]))
);

export const SELECTIONS = Object.keys(SELECTION_MARKET);

/** Selecciones con precio "simple" (sin línea). */
export const FIXED_SELECTIONS = SELECTIONS.filter(s => !s.startsWith('ah_'));

export function formatLine(line) {
  const n = Number(line);
  if (!Number.isFinite(n)) return '';
  return n > 0 ? `+${n}` : n === 0 ? '0' : String(n);
}

export function selectionLabel(selection, line = null, names = {}) {
  const home = names.home || 'Local';
  const away = names.away || 'Visitante';
  switch (selection) {
    case 'home': return 'Gana local';
    case 'draw': return 'Empate';
    case 'away': return 'Gana visitante';
    case 'dc_1x': return 'Local o empate (1X)';
    case 'dc_x2': return 'Empate o visitante (X2)';
    case 'dc_12': return 'Local o visitante (12)';
    case 'over25': return 'Más de 2.5 goles';
    case 'under25': return 'Menos de 2.5 goles';
    case 'btts_yes': return 'Ambos anotan: sí';
    case 'btts_no': return 'Ambos anotan: no';
    case 'ah_home': return `Hándicap ${home} ${formatLine(line)}`;
    case 'ah_away': return `Hándicap ${away} ${formatLine(-Number(line))}`;
    default: return selection;
  }
}

/** Solo líneas enteras o de medio gol (se descartan las de cuarto: .25 / .75). */
export function isSupportedAhLine(line) {
  const n = Number(line);
  return Number.isFinite(n) && Math.abs(n) <= 3 && Number.isInteger(n * 2);
}

/**
 * Probabilidades de hándicap asiático para el LOCAL con línea `line`.
 * margen = goles local − goles visitante + line.
 * @returns {{ win:number, push:number, lose:number }}
 */
export function asianHandicapFromMatrix(matrix, line) {
  let win = 0, push = 0, lose = 0;
  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix[h].length; a++) {
      const d = h - a + Number(line);
      const p = matrix[h][a];
      if (d > 1e-9) win += p;
      else if (d < -1e-9) lose += p;
      else push += p;
    }
  }
  return { win, push, lose };
}

/**
 * Probabilidad de una selección de hándicap condicionada a que no haya push,
 * más la probabilidad de push (para el EV real).
 */
export function ahSelectionProbability(matrix, selection, line) {
  const r = asianHandicapFromMatrix(matrix, line);
  const win = selection === 'ah_home' ? r.win : r.lose;
  const lose = selection === 'ah_home' ? r.lose : r.win;
  const decided = win + lose;
  return { probability: decided > 0 ? win / decided : null, push: r.push, win, lose };
}

/** Probabilidades de todas las selecciones fijas a partir de 1X2, O/U y BTTS. */
export function expandProbabilities(p) {
  if (!p) return null;
  const out = { ...p };
  if (p.home != null && p.draw != null && p.away != null) {
    out.dc_1x = p.home + p.draw;
    out.dc_x2 = p.draw + p.away;
    out.dc_12 = p.home + p.away;
  }
  if (p.over25 != null && p.under25 == null) out.under25 = 1 - p.over25;
  if (p.btts != null && p.btts_yes == null) out.btts_yes = p.btts;
  if (out.btts_yes != null && out.btts_no == null) out.btts_no = 1 - out.btts_yes;
  return out;
}

/**
 * Resultado de una selección.
 * @returns {'won'|'lost'|'void'|'half_won'|'half_lost'|null}
 */
export function settleSelection(selection, line, homeGoals, awayGoals) {
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;
  const total = homeGoals + awayGoals;
  const both = homeGoals > 0 && awayGoals > 0;
  switch (selection) {
    case 'home': return homeGoals > awayGoals ? 'won' : 'lost';
    case 'draw': return homeGoals === awayGoals ? 'won' : 'lost';
    case 'away': return awayGoals > homeGoals ? 'won' : 'lost';
    case 'dc_1x': return homeGoals >= awayGoals ? 'won' : 'lost';
    case 'dc_x2': return awayGoals >= homeGoals ? 'won' : 'lost';
    case 'dc_12': return homeGoals !== awayGoals ? 'won' : 'lost';
    case 'over25': return total >= 3 ? 'won' : 'lost';
    case 'under25': return total < 3 ? 'won' : 'lost';
    case 'btts_yes': return both ? 'won' : 'lost';
    case 'btts_no': return both ? 'lost' : 'won';
    case 'ah_home':
    case 'ah_away': {
      const l = Number(line);
      if (!Number.isFinite(l)) return null;
      const sign = selection === 'ah_home' ? 1 : -1;
      // Línea de cuarto: mitad del stake a cada línea vecina.
      const parts = Number.isInteger(l * 2) ? [l] : [l - 0.25, l + 0.25];
      const res = parts.map(pl => {
        const d = sign * (homeGoals - awayGoals + pl);
        return d > 0 ? 1 : d < 0 ? -1 : 0;
      });
      const s = res.reduce((a, b) => a + b, 0) / res.length;
      if (s === 1) return 'won';
      if (s === -1) return 'lost';
      if (s === 0.5) return 'half_won';
      if (s === -0.5) return 'half_lost';
      return 'void';
    }
    default: return null;
  }
}

/** Ganancia neta por unidad apostada. */
export function profitMultiplier(status, odds) {
  const o = Number(odds) || 0;
  switch (status) {
    case 'won': return o - 1;
    case 'half_won': return (o - 1) / 2;
    case 'half_lost': return -0.5;
    case 'lost': return -1;
    default: return 0;
  }
}

/** Para tasas de acierto: ganadas cuentan 1, medias 0.5, nulas no cuentan. */
export function hitValue(status) {
  if (status === 'won') return 1;
  if (status === 'half_won') return 0.5;
  if (status === 'half_lost') return 0;
  if (status === 'lost') return 0;
  return null;
}
