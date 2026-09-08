const express = require('express');
const { matchModel, pct } = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY || '';
const API_BASE = 'https://v3.football.api-sports.io';

async function api(path) {
  if (!API_KEY) throw new Error('API_FOOTBALL_KEY no configurada');
  const r = await fetch(API_BASE + path, { headers: { 'x-apisports-key': API_KEY } });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || `API error ${r.status}`);
  return data;
}

app.get('/api/status', (_, res) => res.json({ ok: true, apiConfigured: Boolean(API_KEY) }));

app.get('/api/fixtures', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const data = await api(`/fixtures?date=${encodeURIComponent(date)}`);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function avg(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : null; }

app.get('/api/analyze', async (req, res) => {
  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ error: 'Falta fixture id' });
  try {
    const fixtureData = await api(`/fixtures?id=${id}`);
    const f = fixtureData.response?.[0];
    if (!f) return res.status(404).json({ error: 'Partido no encontrado' });
    const homeId = f.teams.home.id, awayId = f.teams.away.id;
    const [homeLast, awayLast] = await Promise.all([
      api(`/fixtures?team=${homeId}&last=5`),
      api(`/fixtures?team=${awayId}&last=5`)
    ]);

    function teamAverages(data, teamId) {
      const games = (data.response || []).filter(x => x.fixture?.status?.short === 'FT');
      const gf = [], ga = [];
      for (const g of games) {
        const isHome = g.teams.home.id === teamId;
        gf.push(isHome ? (g.goals.home ?? 0) : (g.goals.away ?? 0));
        ga.push(isHome ? (g.goals.away ?? 0) : (g.goals.home ?? 0));
      }
      return { games: games.length, gf: avg(gf), ga: avg(ga) };
    }

    const ha = teamAverages(homeLast, homeId);
    const aa = teamAverages(awayLast, awayId);
    const homeXg = Math.max(0.15, ((ha.gf ?? 1.2) + (aa.ga ?? 1.2)) / 2);
    const awayXg = Math.max(0.15, ((aa.gf ?? 1.0) + (ha.ga ?? 1.2)) / 2);
    const m = matchModel(homeXg, awayXg);

    let benchmark = null;
    try {
      const p = await api(`/predictions?fixture=${id}`);
      const pr = p.response?.[0]?.predictions;
      if (pr) benchmark = { winner: pr.winner?.name || null, advice: pr.advice || null, percent: pr.percent || null };
    } catch (_) {}

    res.json({
      fixture: { id, date: f.fixture.date, league: f.league.name, home: f.teams.home.name, away: f.teams.away.name },
      samples: { home: ha, away: aa },
      xg: { home: homeXg, away: awayXg },
      model: { homeWin: pct(m.homeWin), draw: pct(m.draw), awayWin: pct(m.awayWin), over25: pct(m.over25), btts: pct(m.btts) },
      benchmark
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mi Pronóstico Deportivo</title><style>body{font-family:system-ui;margin:0;background:#101114;color:#eee}main{max-width:900px;margin:auto;padding:18px}.card{background:#1a1c21;border:1px solid #30333b;border-radius:14px;padding:16px;margin:12px 0}button{background:#7c3aed;color:white;border:0;border-radius:10px;padding:11px 14px;font-weight:700}input{background:#0e0f12;color:#fff;border:1px solid #444;border-radius:8px;padding:10px}select{background:#0e0f12;color:#fff;border:1px solid #444;border-radius:8px;padding:10px;width:100%}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.metric{background:#111318;padding:12px;border-radius:10px}.muted{color:#9da3af}.good{font-size:20px;font-weight:800}.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}</style></head><body><main><h1>⚽ Mi Pronóstico Deportivo</h1><p class="muted">Modelo estadístico personal. Las probabilidades son estimaciones, no garantías.</p><div class="card"><div class="row"><label>Fecha <input id="date" type="date"></label><button onclick="loadFixtures()">Buscar partidos</button></div><p id="status" class="muted"></p><select id="games" onchange="this.value&&analyze(this.value)"><option value="">Selecciona un partido</option></select></div><div id="out"></div></main><script>const d=new Date();document.getElementById('date').value=new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,10);async function loadFixtures(){const s=document.getElementById('status');s.textContent='Consultando...';try{const date=document.getElementById('date').value;const r=await fetch('/api/fixtures?date='+date);const j=await r.json();if(j.error)throw Error(j.error);const sel=document.getElementById('games');sel.innerHTML='<option value="">Selecciona un partido</option>';for(const x of (j.response||[])){if(!x.teams?.home||!x.teams?.away)continue;const o=document.createElement('option');o.value=x.fixture.id;o.textContent=x.teams.home.name+' vs '+x.teams.away.name+' — '+x.league.name;sel.appendChild(o)}s.textContent=(j.response||[]).length+' partidos encontrados.'}catch(e){s.textContent='Error: '+e.message}}async function analyze(id){const out=document.getElementById('out');out.innerHTML='<div class="card">Analizando últimos partidos y calculando probabilidades...</div>';try{const r=await fetch('/api/analyze?id='+id);const j=await r.json();if(j.error)throw Error(j.error);const m=j.model;out.innerHTML='<div class="card"><h2>'+j.fixture.home+' vs '+j.fixture.away+'</h2><p class="muted">'+j.fixture.league+'</p><div class="grid"><div class="metric">Local<strong class="good"> '+m.homeWin+'%</strong></div><div class="metric">Empate<strong class="good"> '+m.draw+'%</strong></div><div class="metric">Visitante<strong class="good"> '+m.awayWin+'%</strong></div><div class="metric">Más de 2.5<strong class="good"> '+m.over25+'%</strong></div><div class="metric">Ambos marcan<strong class="good"> '+m.btts+'%</strong></div></div><h3>Base estadística</h3><p>Últimos '+j.samples.home.games+' del local: '+(j.samples.home.gf??'—')+' goles a favor / '+(j.samples.home.ga??'—')+' en contra por partido.</p><p>Últimos '+j.samples.away.games+' del visitante: '+(j.samples.away.gf??'—')+' goles a favor / '+(j.samples.away.ga??'—')+' en contra por partido.</p><p>Goles esperados estimados: '+j.xg.home.toFixed(2)+' — '+j.xg.away.toFixed(2)+'</p>'+(j.benchmark?'<h3>Referencia externa</h3><p>'+ (j.benchmark.winner||'Sin ganador')+' · '+(j.benchmark.advice||'')+'</p>':'')+'<p class="muted">Importante: una muestra de 5 partidos es pequeña. No es una garantía de resultado.</p></div>'}catch(e){out.innerHTML='<div class="card">Error: '+e.message+'</div>'}}</script></body></html>`;

app.get('/', (_, res) => res.type('html').send(html));
app.listen(PORT, () => console.log(`Mi Pronóstico Deportivo: puerto ${PORT}`));
