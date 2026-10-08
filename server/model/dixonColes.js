/**
 * Ajuste Dixon-Coles por máxima verosimilitud ponderada en el tiempo.
 *
 *   log λ(local)     = c + γ + ataque[local] + defensa[visitante]
 *   log μ(visitante) = c +     ataque[visitante] + defensa[local]
 *
 * - Cada partido pesa exp(-ξ · días transcurridos) (decaimiento temporal).
 * - Penalización L2 (ridge) hacia un prior: 0 para equipos con historial en la
 *   liga y un prior de "recién ascendido" para equipos nuevos. Esto sustituye la
 *   restricción Σataque = 0 y estabiliza equipos con pocos partidos.
 * - ρ (correlación de marcadores bajos) se estima por búsqueda en rejilla con
 *   λ y μ fijos.
 *
 * Sustituye al cálculo anterior que multiplicaba GF × (GF/1.35), contando dos
 * veces la misma señal.
 */
import { clamp, dixonColesTau } from './poisson.js';

const DAY_MS = 86400000;

export const DEFAULT_FIT_OPTIONS = {
  xi: 0.0019,            // decaimiento por día (vida media ≈ 365 días)
  maxAgeDays: 1100,      // ~3 temporadas
  ridge: 3.0,            // fuerza del prior, en "partidos equivalentes"
  promotedPrior: { att: -0.22, def: 0.18 },
  iterations: 500,
  learningRate: 0.06,
  tolerance: 1e-7
};

function toTime(date) {
  return new Date(`${String(date).slice(0, 10)}T12:00:00Z`).getTime();
}

/**
 * @param {Array<{date:string, home:string, away:string, hg:number, ag:number}>} matches
 * @param {object} opts { asOf: 'YYYY-MM-DD' (excluyente), warmStart, ...DEFAULT_FIT_OPTIONS }
 */
export function fitDixonColes(matches, opts = {}) {
  const o = { ...DEFAULT_FIT_OPTIONS, ...opts };
  const asOfTime = o.asOf ? toTime(o.asOf) : Date.now();

  const rows = [];
  for (const m of matches) {
    const t = toTime(m.date);
    if (!(t < asOfTime)) continue;
    const ageDays = (asOfTime - t) / DAY_MS;
    if (ageDays > o.maxAgeDays) continue;
    if (!Number.isFinite(m.hg) || !Number.isFinite(m.ag)) continue;
    rows.push({ home: m.home, away: m.away, hg: m.hg, ag: m.ag, w: Math.exp(-o.xi * ageDays), t });
  }

  if (rows.length < 30) {
    return { ok: false, reason: 'Historial insuficiente', nMatches: rows.length };
  }

  // Equipos "veteranos": aparecen en el primer tercio del historial disponible.
  const firstTime = Math.min(...rows.map(r => r.t));
  const lastTime = Math.max(...rows.map(r => r.t));
  const seasonCut = lastTime - 300 * DAY_MS; // partidos de la temporada más reciente
  const teams = new Map();
  for (const r of rows) {
    for (const name of [r.home, r.away]) {
      if (!teams.has(name)) teams.set(name, { first: r.t, last: r.t, weight: 0, n: 0 });
      const info = teams.get(name);
      info.first = Math.min(info.first, r.t);
      info.last = Math.max(info.last, r.t);
      info.weight += r.w;
      info.n += 1;
    }
  }

  const names = [...teams.keys()];
  const idx = new Map(names.map((n, i) => [n, i]));
  const T = names.length;

  const priorAtt = new Float64Array(T);
  const priorDef = new Float64Array(T);
  names.forEach((n, i) => {
    const info = teams.get(n);
    const isNew = info.first > seasonCut && info.first - firstTime > 200 * DAY_MS;
    if (isNew) {
      priorAtt[i] = o.promotedPrior.att;
      priorDef[i] = o.promotedPrior.def;
    }
  });

  const totalW = rows.reduce((s, r) => s + r.w, 0);
  const avgGoals = rows.reduce((s, r) => s + r.w * (r.hg + r.ag), 0) / (2 * totalW);

  const att = new Float64Array(T);
  const def = new Float64Array(T);
  let c = Math.log(Math.max(avgGoals, 0.3));
  let gamma = 0.2;

  const ws = o.warmStart;
  if (ws?.teams) {
    names.forEach((n, i) => {
      if (ws.teams[n]) { att[i] = ws.teams[n].att; def[i] = ws.teams[n].def; }
      else { att[i] = priorAtt[i]; def[i] = priorDef[i]; }
    });
    if (Number.isFinite(ws.intercept)) c = ws.intercept;
    if (Number.isFinite(ws.homeAdvantage)) gamma = ws.homeAdvantage;
  } else {
    att.set(priorAtt);
    def.set(priorDef);
  }

  const H = rows.map(r => idx.get(r.home));
  const A = rows.map(r => idx.get(r.away));

  // Adam sobre la log-verosimilitud Poisson ponderada (normalizada por el peso total).
  const P = 2 * T + 2;
  const m1 = new Float64Array(P);
  const m2 = new Float64Array(P);
  const g = new Float64Array(P);
  const b1 = 0.9, b2 = 0.999, eps = 1e-8;
  const ridgeScale = o.ridge / Math.max(totalW, 1);
  let prevLL = -Infinity;
  const iterations = ws ? Math.min(o.iterations, 200) : o.iterations;

  for (let it = 1; it <= iterations; it++) {
    g.fill(0);
    let ll = 0;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      const h = H[k], a = A[k];
      const logL = c + gamma + att[h] + def[a];
      const logM = c + att[a] + def[h];
      const lam = Math.exp(logL);
      const mu = Math.exp(logM);
      ll += r.w * (r.hg * logL - lam + r.ag * logM - mu);
      const dL = r.w * (r.hg - lam);
      const dM = r.w * (r.ag - mu);
      g[0] += dL + dM;          // c
      g[1] += dL;               // gamma
      g[2 + h] += dL;           // att local
      g[2 + T + a] += dL;       // def visitante
      g[2 + a] += dM;           // att visitante
      g[2 + T + h] += dM;       // def local
    }
    for (let i = 0; i < P; i++) g[i] /= totalW;
    for (let i = 0; i < T; i++) {
      g[2 + i] -= ridgeScale * (att[i] - priorAtt[i]);
      g[2 + T + i] -= ridgeScale * (def[i] - priorDef[i]);
      ll -= 0.5 * o.ridge * ((att[i] - priorAtt[i]) ** 2 + (def[i] - priorDef[i]) ** 2);
    }

    const lr = o.learningRate;
    for (let i = 0; i < P; i++) {
      m1[i] = b1 * m1[i] + (1 - b1) * g[i];
      m2[i] = b2 * m2[i] + (1 - b2) * g[i] * g[i];
      const step = lr * (m1[i] / (1 - b1 ** it)) / (Math.sqrt(m2[i] / (1 - b2 ** it)) + eps);
      if (i === 0) c += step;
      else if (i === 1) gamma += step;
      else if (i < 2 + T) att[i - 2] += step;
      else def[i - 2 - T] += step;
    }

    const llNorm = ll / totalW;
    if (Math.abs(llNorm - prevLL) < o.tolerance && it > 50) break;
    prevLL = llNorm;
  }

  // ρ por rejilla (λ, μ fijos)
  let bestRho = 0, bestRhoLL = -Infinity;
  for (let step = -20; step <= 10; step++) {
    const rho = step / 100;
    let s = 0;
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      if (r.hg > 1 || r.ag > 1) continue;
      const lam = Math.exp(c + gamma + att[H[k]] + def[A[k]]);
      const mu = Math.exp(c + att[A[k]] + def[H[k]]);
      const tau = dixonColesTau(r.hg, r.ag, lam, mu, rho);
      s += r.w * Math.log(Math.max(tau, 1e-9));
    }
    if (s > bestRhoLL) { bestRhoLL = s; bestRho = rho; }
  }

  const teamParams = {};
  names.forEach((n, i) => {
    teamParams[n] = {
      att: att[i],
      def: def[i],
      matches: teams.get(n).n,
      effectiveMatches: Number(teams.get(n).weight.toFixed(1)),
      lastMatch: new Date(teams.get(n).last).toISOString().slice(0, 10),
      // Jugó en los últimos 150 días del historial: sigue en la liga.
      active: lastTime - teams.get(n).last <= 150 * DAY_MS
    };
  });

  return {
    ok: true,
    asOf: o.asOf || new Date().toISOString().slice(0, 10),
    nMatches: rows.length,
    intercept: c,
    homeAdvantage: gamma,
    homeAdvantageFactor: Math.exp(gamma),
    rho: bestRho,
    avgGoalsPerTeam: avgGoals,
    promotedPrior: o.promotedPrior,
    teams: teamParams
  };
}

/** Goles esperados de un partido con un modelo ajustado. */
export function expectedGoals(model, home, away) {
  const warnings = [];
  const getTeam = (name) => {
    const t = model.teams[name];
    if (t) return t;
    warnings.push(`Equipo sin historial en el modelo: ${name}; se usa el prior de recién ascendido.`);
    return { att: model.promotedPrior.att, def: model.promotedPrior.def, matches: 0, effectiveMatches: 0 };
  };
  const h = getTeam(home);
  const a = getTeam(away);
  const lambda = clamp(Math.exp(model.intercept + model.homeAdvantage + h.att + a.def), 0.1, 5);
  const mu = clamp(Math.exp(model.intercept + a.att + h.def), 0.1, 5);
  return {
    lambda,
    mu,
    rho: model.rho,
    homeSample: h.effectiveMatches,
    awaySample: a.effectiveMatches,
    warnings
  };
}
