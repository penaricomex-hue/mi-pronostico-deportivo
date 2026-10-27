/**
 * Informe por correo: acierto, crecimiento de la muestra y cómo se movió el criterio.
 * Solo fútbol. El destinatario es fijo (no sale del cuerpo de la petición).
 */
import { COMPETITION_NAMES } from '../competitions.js';
import { tagLabel } from './lessons.js';

const COMP_NAME = {
  la_liga: COMPETITION_NAMES?.PD || 'LaLiga',
  champions_league: COMPETITION_NAMES?.CL || 'Champions'
};

function pct(n, digits = 1) {
  return n == null || Number.isNaN(Number(n)) ? '—' : `${Number(n).toFixed(digits)}%`;
}

function money(n, currency) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${Number(n).toFixed(2)} ${currency || ''}`.trim();
}

export function renderReport(s) {
  const lines = [];
  lines.push('MK Bets — informe de fútbol');
  lines.push(`Para: ${s.to}`);
  lines.push(`Generado: ${s.generatedAt}`);
  lines.push('');
  lines.push('Solo LaLiga EA Sports y UEFA Champions League.');
  lines.push('');
  lines.push('Señales del modelo (30 días)');
  const sig = s.signals;
  if (!sig) lines.push('  Sin panel de señales.');
  else {
    lines.push(`  Resueltas: ${sig.resolved} de ${sig.signals} (pendientes ${sig.pending})`);
    lines.push(`  Acierto: ${pct(sig.hitRatePct)} · ROI: ${pct(sig.roiPct)} · beneficio: ${money(sig.profit, s.currency)}`);
    lines.push(`  CLV medio: ${pct(sig.avgClvPct, 2)} (${sig.clvSample} con cierre)`);
  }
  lines.push('');
  lines.push('Tus apuestas manuales (30 días)');
  const m = s.manual;
  if (!m) lines.push('  Sin base de datos.');
  else {
    lines.push(`  ${m.total} registradas · ${m.pending} pendientes · ${m.won} ganadas · ${m.lost} perdidas`);
    lines.push(`  Acierto: ${pct(m.hitRatePct)} · ROI: ${pct(m.roiPct)} · resultado: ${money(m.profit, m.currency || s.currency)}`);
    lines.push(`  Entraron en la calibración: ${s.learned ?? 0}`);
  }
  lines.push('');
  lines.push('Criterio que sale de lo que tú apuestas');
  if (!s.criteria?.groups?.length) {
    lines.push(`  Aún no hay resultados manuales suficientes. Hacen falta ${s.criteria?.minSample || 8} por mercado para mover el EV mínimo (±1 punto, entre 3% y 8%).`);
  } else {
    for (const g of s.criteria.groups) {
      const liga = COMP_NAME[g.competitionSlug] || g.competitionSlug;
      const move = g.minEvDelta === 0
        ? 'el EV mínimo no se mueve'
        : g.minEvDelta < 0
          ? 'el EV mínimo baja 1 punto (tus resultados acompañan)'
          : 'el EV mínimo sube 1 punto (tus resultados no acompañan)';
      const why = g.topTagLabel ? ` Motivo que más acertó: ${g.topTagLabel}.` : '';
      lines.push(`  ${liga} · ${g.groupLabel}: ${g.n} apuestas, acierto ${pct(g.hitPct)}, ROI ${pct(g.roiPct)}. ${move}.${why}`);
    }
  }
  lines.push('');
  lines.push('Calibración en vivo (muestras nuevas, incluida tu mano cuando hubo probabilidad del modelo)');
  const maps = s.calibration?.maps || {};
  const keys = Object.keys(maps);
  if (!keys.length) lines.push('  Sin mapas cargados.');
  else {
    for (const key of keys) {
      const map = maps[key];
      lines.push(`  ${key}: ${map.liveSamples} en vivo · ${map.samples} en el mapa · ${map.method}`);
    }
  }
  lines.push('');
  lines.push('Esto es un seguimiento de papel, no una promesa de ganancia.');
  return lines.join('\n');
}

export function createReportService({
  to,
  smtp = {},
  bets = null,
  signals = null,
  lessons = null,
  calibration = null,
  store = null,
  pool = null,
  currency = 'MXN',
  everyMs = 7 * 86400000,
  logger = console,
  mailer = null
} = {}) {
  function smtpReady() {
    return Boolean(smtp.host && smtp.user && smtp.pass);
  }

  async function snapshot() {
    const signalsPerf = signals ? await signals.performance({ days: 30 }).catch(() => null) : null;
    const manual = bets ? await bets.summary({ period: 'month' }).catch(() => null) : null;
    const criteria = lessons ? await lessons.criteria().catch(() => null) : null;
    let learned = null;
    if (pool) {
      try {
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM manual_outcomes');
        learned = rows[0]?.n ?? 0;
      } catch { learned = null; }
    }
    const data = {
      to,
      generatedAt: new Date().toISOString(),
      currency,
      signals: signalsPerf ? {
        signals: signalsPerf.totals?.signals,
        resolved: signalsPerf.totals?.resolved,
        pending: signalsPerf.totals?.pending,
        hitRatePct: signalsPerf.totals?.hitRatePct,
        roiPct: signalsPerf.totals?.yieldPct ?? signalsPerf.totals?.roiPct,
        profit: signalsPerf.totals?.profit,
        avgClvPct: signalsPerf.totals?.avgClvPct,
        clvSample: signalsPerf.totals?.clvSample
      } : null,
      manual,
      learned,
      criteria,
      calibration: calibration ? calibration.summary() : null
    };
    return { ...data, text: renderReport(data) };
  }

  async function deliver({ force = false } = {}) {
    const report = await snapshot();
    if (!force && store) {
      const last = await store.get('report:lastSent').catch(() => null);
      if (last && Date.now() - new Date(last).getTime() < everyMs) {
        return { sent: false, skipped: true, report };
      }
    }
    if (!smtpReady()) {
      return { sent: false, needsSmtp: true, report };
    }
    const transport = mailer || (await import('nodemailer')).default.createTransport({
      host: smtp.host,
      port: smtp.port || 465,
      secure: (smtp.port || 465) === 465,
      auth: { user: smtp.user, pass: smtp.pass }
    });
    await transport.sendMail({
      from: smtp.from || smtp.user,
      to,
      subject: 'MK Bets — cómo va el fútbol',
      text: report.text
    });
    if (store) await store.set('report:lastSent', new Date().toISOString(), 40 * 86400).catch(() => {});
    logger.log(`[reports] Informe enviado a ${to}`);
    return { sent: true, report };
  }

  return { snapshot, deliver, smtpReady, to };
}

export { tagLabel };
