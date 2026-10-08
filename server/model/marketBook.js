/**
 * Libro de mercado de un partido a partir de las cuotas de varias casas:
 *   - Probabilidad de mercado SIN margen (consenso: se quita el margen de cada
 *     casa y se promedian las probabilidades).
 *   - Cuota de ejecución por selección: la de EXECUTION_BOOKMAKER si está
 *     configurada; si no, la mejor cuota NO atípica disponible.
 *   - Cuota media de mercado (mediana) para comparar ejecución vs mercado.
 */
import { devig, median, isOutlierPrice } from './market.js';
import { FIXED_SELECTIONS } from './markets.js';

const GROUPS = {
  '1x2': ['home', 'draw', 'away'],
  over_under: ['over25', 'under25'],
  btts: ['btts_yes', 'btts_no'],
  double_chance: ['dc_1x', 'dc_x2', 'dc_12']
};

function norm(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isBookmaker(book, wanted) {
  if (!wanted) return false;
  const w = norm(wanted);
  return norm(book.bookmaker) === w || norm(book.key) === w;
}

/** Consenso sin margen de un grupo de selecciones. Doble oportunidad suma 2. */
function consensusGroup(books, keys, total = 1) {
  const acc = keys.map(() => 0);
  let n = 0;
  for (const b of books) {
    const odds = keys.map(k => b.prices?.[k]);
    if (odds.some(o => !(o > 1))) continue;
    const dv = devig(odds);
    if (!dv) continue;
    dv.probs.forEach((p, i) => { acc[i] += p * total; });
    n++;
  }
  if (!n) return null;
  return { probs: Object.fromEntries(keys.map((k, i) => [k, acc[i] / n])), count: n };
}

/**
 * Elige la cuota de ejecución.
 * @param {Array<{bookmaker:string, key?:string, odds:number}>} entries
 */
export function executionPrice(entries, { executionBookmaker = '' } = {}) {
  const valid = entries.filter(e => e.odds > 1).sort((a, b) => b.odds - a.odds);
  if (!valid.length) return { odds: null, bookmaker: null, mode: executionBookmaker ? 'fixed' : 'best', median: null, count: 0 };
  const med = median(valid.map(v => v.odds));
  if (executionBookmaker) {
    const hit = valid.find(e => isBookmaker(e, executionBookmaker));
    return { odds: hit ? hit.odds : null, bookmaker: hit ? hit.bookmaker : executionBookmaker, mode: 'fixed', median: med, count: valid.length };
  }
  // Mejor cuota que no sea atípica (precio desactualizado o error que la casa anula)
  for (let i = 0; i < valid.length; i++) {
    const next = valid.slice(i + 1).find(v => v.odds < valid[i].odds)?.odds ?? null;
    if (!isOutlierPrice(valid[i].odds, med, next)) {
      return { odds: valid[i].odds, bookmaker: valid[i].bookmaker, mode: 'best', median: med, count: valid.length, skippedOutliers: i };
    }
  }
  return { odds: null, bookmaker: null, mode: 'best', median: med, count: valid.length };
}

/** Línea principal de hándicap: la que ofrecen más casas (empate: la más equilibrada). */
export function mainAhLine(books) {
  const counts = new Map();
  for (const b of books) for (const [line, p] of Object.entries(b.ah || {})) {
    if (p.home > 1 && p.away > 1) counts.set(line, (counts.get(line) || 0) + 1);
  }
  if (!counts.size) return null;
  let best = null;
  for (const [line, c] of counts) {
    const balance = Math.abs(median(books.map(b => b.ah?.[line]?.home).filter(Boolean)) - median(books.map(b => b.ah?.[line]?.away).filter(Boolean)));
    if (!best || c > best.c || (c === best.c && balance < best.balance)) best = { line, c, balance };
  }
  return Number(best.line);
}

/**
 * @param {Array} books [{ bookmaker, key, prices, ah }]
 * @param {{executionBookmaker?:string}} opts
 */
export function buildMarketBook(books, { executionBookmaker = '' } = {}) {
  const fair = {};
  const counts = {};
  for (const [g, keys] of Object.entries(GROUPS)) {
    const c = consensusGroup(books, keys, g === 'double_chance' ? 2 : 1);
    if (!c) continue;
    Object.assign(fair, c.probs);
    for (const k of keys) counts[k] = c.count;
  }
  // Doble oportunidad derivada del 1X2 si no hay casas con ese mercado
  if (fair.dc_1x == null && fair.home != null) {
    fair.dc_1x = fair.home + fair.draw; fair.dc_x2 = fair.draw + fair.away; fair.dc_12 = fair.home + fair.away;
    for (const k of GROUPS.double_chance) counts[k] = counts.home;
  }

  const prices = {};
  for (const sel of FIXED_SELECTIONS) {
    const entries = books.map(b => ({ bookmaker: b.bookmaker, key: b.key, odds: b.prices?.[sel] })).filter(e => e.odds > 1);
    if (!entries.length) continue;
    prices[sel] = { ...executionPrice(entries, { executionBookmaker }), fairCount: counts[sel] || 0 };
  }

  let ah = null;
  const line = mainAhLine(books);
  if (line != null) {
    const key = String(line);
    const sideBooks = books.filter(b => b.ah?.[key]?.home > 1 && b.ah?.[key]?.away > 1);
    const pseudo = sideBooks.map(b => ({ prices: { ah_home: b.ah[key].home, ah_away: b.ah[key].away } }));
    const c = consensusGroup(pseudo, ['ah_home', 'ah_away']);
    const entriesH = sideBooks.map(b => ({ bookmaker: b.bookmaker, key: b.key, odds: b.ah[key].home }));
    const entriesA = sideBooks.map(b => ({ bookmaker: b.bookmaker, key: b.key, odds: b.ah[key].away }));
    ah = {
      line,
      fair: c ? c.probs : null,
      prices: {
        ah_home: { ...executionPrice(entriesH, { executionBookmaker }), fairCount: c?.count || 0 },
        ah_away: { ...executionPrice(entriesA, { executionBookmaker }), fairCount: c?.count || 0 }
      }
    };
  }

  return { bookmakers: books.length, fair, prices, ah, executionMode: executionBookmaker ? 'fixed' : 'best', executionBookmaker: executionBookmaker || null };
}

/** Filas planas para guardar en bookmaker_odds. Hándicap: solo la línea principal. */
export function oddsRows(books, mainLine = null) {
  const marketOf = sel => (sel === 'home' || sel === 'draw' || sel === 'away') ? '1x2'
    : sel.startsWith('dc_') ? 'double_chance'
    : sel.startsWith('btts') ? 'btts'
    : 'over_under';
  const rows = [];
  for (const b of books) {
    const bookmaker = String(b.bookmaker || b.key || '').slice(0, 50);
    for (const sel of FIXED_SELECTIONS) {
      const o = b.prices?.[sel];
      if (!(o > 1)) continue;
      const market = marketOf(sel);
      rows.push({ bookmaker, market, selection: sel, line: market === 'over_under' ? 2.5 : 0, odds: o });
    }
    if (mainLine != null) {
      const p = b.ah?.[String(mainLine)];
      if (p?.home > 1) rows.push({ bookmaker, market: 'asian_handicap', selection: 'ah_home', line: mainLine, odds: p.home });
      if (p?.away > 1) rows.push({ bookmaker, market: 'asian_handicap', selection: 'ah_away', line: mainLine, odds: p.away });
    }
  }
  return rows;
}
