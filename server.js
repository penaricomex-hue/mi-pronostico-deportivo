const express = require('express');
const { matchModel, pct, implied, ev, confidence } = require('./engine');

const app = express();
const PORT = process.env.PORT || 3000;

const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY || '';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';

const FOOTBALL_DATA_BASE = 'https://api.football-data.org/v4';
const ODDS_BASE = 'https://api.the-odds-api.com/v4';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

const ODDS_SPORT_BY_COMPETITION = {
  PL: 'soccer_epl',
  PD: 'soccer_spain_la_liga',
  BL1: 'soccer_germany_bundesliga',
  SA: 'soccer_italy_serie_a',
  FL1: 'soccer_france_ligue_one',
  CL: 'soccer_uefa_champs_league',
  EL: 'soccer_uefa_europa_league'
};

function cacheGet(key) {
  const x = cache.get(key);

  if (!x || Date.now() - x.time > CACHE_TTL_MS) {
    return null;
  }

  return x.value;
}

function cacheSet(key, value) {
  cache.set(key, {
    time: Date.now(),
    value
  });
}

async function fetchJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  const text = await r.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!r.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      `HTTP ${r.status}`
    );
  }

  return {
    data,
    headers: r.headers
  };
}

async function footballData(path) {
  if (!FOOTBALL_DATA_KEY) {
    throw new Error('Falta FOOTBALL_DATA_KEY en Render');
  }

  const key = `fd:${path}`;
  const c = cacheGet(key);

  if (c) {
    return c;
  }

  const x = await fetchJson(
    FOOTBALL_DATA_BASE + path,
    {
      'X-Auth-Token': FOOTBALL_DATA_KEY
    }
  );

  cacheSet(key, x.data);

  return x.data;
}

async function oddsApi(path) {
  if (!ODDS_API_KEY) {
    throw new Error('Falta ODDS_API_KEY en Render');
  }

  const sep = path.includes('?') ? '&' : '?';
  const key = `odds:${path}`;
  const c = cacheGet(key);

  if (c) {
    return c;
  }

  const x = await fetchJson(
    ODDS_BASE +
    path +
    sep +
    'apiKey=' +
    encodeURIComponent(ODDS_API_KEY)
  );

  cacheSet(key, x.data);

  return x.data;
}

function dateOnly(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

function avg(a) {
  return a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : null;
}

function weightedAverage(values) {
  if (!values || !values.length) {
    return null;
  }

  let weightedSum = 0;
  let weightSum = 0;

  values.forEach((value, index) => {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
      return;
    }

    const weight = values.length - index;

    weightedSum += numericValue * weight;
    weightSum += weight;
  });

  return weightSum
    ? weightedSum / weightSum
    : null;
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/*
===========================================================
V7.2 - MODELO DE FUERZA DEL EQUIPO
===========================================================

Calculamos:

- GF general
- GC general
- GF como local
- GC como local
- GF como visitante
- GC como visitante
- forma reciente
- cantidad de partidos

La forma se representa:

Victoria = 1
Empate = 0.5
Derrota = 0

Solo usamos los últimos 10 partidos disponibles.
*/

function teamAverages(matches, teamId) {
  const games = (matches || [])
    .filter(x =>
      x.status === 'FINISHED' &&
      x.score?.fullTime &&
      x.homeTeam?.id &&
      x.awayTeam?.id
    )
    .slice(0, 10);

  const gf = [];
  const ga = [];

  const homeGF = [];
  const homeGA = [];

  const awayGF = [];
  const awayGA = [];

  const form = [];

  for (const g of games) {
    const isHome = g.homeTeam.id === teamId;

    const hg = Number(g.score.fullTime.home);
    const ag = Number(g.score.fullTime.away);

    if (!Number.isFinite(hg) || !Number.isFinite(ag)) {
      continue;
    }

    const scored = isHome ? hg : ag;
    const conceded = isHome ? ag : hg;

    gf.push(scored);
    ga.push(conceded);

    if (isHome) {
      homeGF.push(hg);
      homeGA.push(ag);
    } else {
      awayGF.push(ag);
      awayGA.push(hg);
    }

    if (scored > conceded) {
      form.push(1);
    } else if (scored === conceded) {
      form.push(0.5);
    } else {
      form.push(0);
    }
  }

  return {
    games: gf.length,

    gf: avg(gf),
    ga: avg(ga),

    homeGames: homeGF.length,
    homeGF: avg(homeGF),
    homeGA: avg(homeGA),

    awayGames: awayGF.length,
    awayGF: avg(awayGF),
    awayGA: avg(awayGA),

    form: avg(form)
  };
}

function bestOddsForMatch(events, home, away) {
  const hn = normalize(home);
  const an = normalize(away);

  const event = (events || []).find(e => {
    const eh = normalize(e.home_team);
    const ea = normalize(e.away_team);

    return (
      (eh === hn && ea === an) ||
      (
        (eh.includes(hn) || hn.includes(eh)) &&
        (ea.includes(an) || an.includes(ea))
      )
    );
  });

  if (!event) {
    return null;
  }

  const best = {
    h2h: {},
    totals: {},
    bookmakers: new Set()
  };

  for (const book of event.bookmakers || []) {
    for (const market of book.markets || []) {
      if (
        market.key !== 'h2h' &&
        market.key !== 'totals'
      ) {
        continue;
      }

      for (const outcome of market.outcomes || []) {
        const price = Number(outcome.price);

        if (!(price > 1)) {
          continue;
        }

        const k =
          `${outcome.name}|${
            market.key === 'totals'
              ? String(outcome.point)
              : ''
          }`;

        const bucket =
          market.key === 'h2h'
            ? best.h2h
            : best.totals;

        if (
          !bucket[k] ||
          price > bucket[k].price
        ) {
          bucket[k] = {
            name: outcome.name,
            price,
            point: outcome.point ?? null,
            bookmaker: book.title
          };
        }

        best.bookmakers.add(book.title);
      }
    }
  }

  best.bookmakers = [
    ...best.bookmakers
  ];

  return {
    event,
    ...best
  };
}

function oddsMarket(
  best,
  outcomeName,
  modelProbability
) {
  if (!best) {
    return null;
  }

  const row = Object
    .values(best.h2h || {})
    .find(
      x =>
        normalize(x.name) ===
        normalize(outcomeName)
    );

  if (!row) {
    return null;
  }

  return {
    outcome: row.name,
    odds: row.price,
    impliedProbability: pct(
      implied(row.price)
    ),
    ev: pct(
      ev(modelProbability, row.price)
    ),
    bookmaker: row.bookmaker
  };
}

async function getOddsForFixture(f) {
  if (!ODDS_API_KEY) {
    return {
      available: false,
      reason: 'ODDS_API_KEY no configurada'
    };
  }

  const sportKey =
    ODDS_SPORT_BY_COMPETITION[
      f.competition?.code
    ];

  if (!sportKey) {
    return {
      available: false,
      reason:
        `Sin mapeo de cuotas para ${
          f.competition?.code ||
          'esta competición'
        }`
    };
  }

  try {
    const events = await oddsApi(
      `/sports/${sportKey}/odds?regions=us,eu&markets=h2h,totals&oddsFormat=decimal`
    );

    const best = bestOddsForMatch(
      events,
      f.homeTeam.name,
      f.awayTeam.name
    );

    if (!best) {
      return {
        available: false,
        reason:
          'Las casas todavía no publican este partido o no hubo coincidencia de equipos',
        sportKey
      };
    }

    return {
      available: true,
      sportKey,
      eventId: best.event.id,
      bookmakers: best.bookmakers,
      h2h: best.h2h,
      totals: best.totals,
      commenceTime: best.event.commence_time
    };
  } catch (e) {
    return {
      available: false,
      reason: e.message,
      sportKey
    };
  }
}

app.get(
  '/api/status',
  (_, res) =>
    res.json({
      ok: true,
      footballDataConfigured:
        Boolean(FOOTBALL_DATA_KEY),
      oddsApiConfigured:
        Boolean(ODDS_API_KEY),
      provider:
        'football-data.org + The Odds API',
      cacheMinutes:
        CACHE_TTL_MS / 60000,
      modelVersion: 'V7.2'
    })
);

app.get(
  '/api/fixtures',
  async (req, res) => {
    try {
      const date =
        req.query.date ||
        new Date()
          .toISOString()
          .slice(0, 10);

      res.json(
        await footballData(
          `/matches?dateFrom=${encodeURIComponent(
            date
          )}&dateTo=${encodeURIComponent(date)}`
        )
      );
    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

app.get(
  '/api/analyze',
  async (req, res) => {
    const id = Number(req.query.id);

    if (!id) {
      return res.status(400).json({
        error: 'Falta match id'
      });
    }

    try {
      const md =
        await footballData(`/matches/${id}`);

      const f =
        md.match || md;

      if (!f?.id) {
        return res.status(404).json({
          error: 'Partido no encontrado'
        });
      }

      const homeId =
        f.homeTeam?.id;

      const awayId =
        f.awayTeam?.id;

      if (!homeId || !awayId) {
        throw new Error(
          'El partido no contiene IDs de equipos'
        );
      }

      /*
      -------------------------------------------------------
      V7.2
      Tomamos los últimos 180 días y hasta 10 partidos.
      -------------------------------------------------------
      */

      const end =
        dateOnly(f.utcDate);

      const start =
        new Date(
          new Date(
            end + 'T00:00:00Z'
          ).getTime() -
          180 * 86400000
        )
          .toISOString()
          .slice(0, 10);

      const [
        hm,
        am
      ] = await Promise.all([
        footballData(
          `/teams/${homeId}/matches?status=FINISHED&dateFrom=${start}&dateTo=${end}&limit=10`
        ),

        footballData(
          `/teams/${awayId}/matches?status=FINISHED&dateFrom=${start}&dateTo=${end}&limit=10`
        )
      ]);

      const ha =
        teamAverages(
          hm.matches,
          homeId
        );

      const aa =
        teamAverages(
          am.matches,
          awayId
        );

      /*
      =======================================================
      V7.2 - FUERZA OFENSIVA Y DEFENSIVA
      =======================================================
      */

      const homeAttack =
        weightedAverage([
          ha.homeGF,
          ha.gf,
          ha.gf
        ].filter(
          x => x != null
        )) ?? 1.35;

      const homeDefense =
        weightedAverage([
          ha.homeGA,
          ha.ga,
          ha.ga
        ].filter(
          x => x != null
        )) ?? 1.20;

      const awayAttack =
        weightedAverage([
          aa.awayGF,
          aa.gf,
          aa.gf
        ].filter(
          x => x != null
        )) ?? 1.10;

      const awayDefense =
        weightedAverage([
          aa.awayGA,
          aa.ga,
          aa.ga
        ].filter(
          x => x != null
        )) ?? 1.30;

      /*
      =======================================================
      V7.2 - EXPECTATIVA DE GOLES
      =======================================================
      */

      let homeXg =
        (homeAttack * 0.60) +
        (awayDefense * 0.40);

      let awayXg =
        (awayAttack * 0.60) +
        (homeDefense * 0.40);

      /*
      Ventaja de local.
      */

      homeXg *= 1.08;
      awayXg *= 0.94;

      /*
      =======================================================
      V7.2 - FORMA RECIENTE
      =======================================================
      */

      if (ha.form != null) {
        homeXg *=
          0.94 +
          (ha.form * 0.12);
      }

      if (aa.form != null) {
        awayXg *=
          0.94 +
          (aa.form * 0.12);
      }

      /*
      =======================================================
      V7.2 - PROTECCIÓN CONTRA VALORES EXTREMOS
      =======================================================
      */

      homeXg =
        Math.min(
          4.50,
          Math.max(
            0.20,
            homeXg
          )
        );

      awayXg =
        Math.min(
          4.50,
          Math.max(
            0.20,
            awayXg
          )
        );

      /*
      =======================================================
      V7.1 ENGINE
      Poisson + corrección de bajos marcadores
      =======================================================
      */

      const m =
        matchModel(
          homeXg,
          awayXg
        );

      /*
      =======================================================
      CUOTAS
      =======================================================
      */

      const odds =
        await getOddsForFixture(f);

      /*
      =======================================================
      MERCADOS
      =======================================================
      */

      const modelMarkets = [
        {
          market: '1X2',
          selection:
            f.homeTeam.name,
          probability:
            pct(m.homeWin),
          odds:
            oddsMarket(
              odds.available
                ? odds
                : null,
              f.homeTeam.name,
              m.homeWin
            )
        },

        {
          market: '1X2',
          selection: 'Empate',
          probability:
            pct(m.draw),
          odds:
            oddsMarket(
              odds.available
                ? odds
                : null,
              'Draw',
              m.draw
            )
        },

        {
          market: '1X2',
          selection:
            f.awayTeam.name,
          probability:
            pct(m.awayWin),
          odds:
            oddsMarket(
              odds.available
                ? odds
                : null,
              f.awayTeam.name,
              m.awayWin
            )
        },

        {
          market: 'Goles',
          selection:
            'Más de 2.5',
          probability:
            pct(m.over25)
        },

        {
          market: 'Goles',
          selection:
            'Menos de 2.5',
          probability:
            pct(m.under25)
        },

        {
          market: 'BTTS',
          selection:
            'Ambos marcan',
          probability:
            pct(m.btts)
        }
      ];

      /*
      =======================================================
      MEJOR VALOR
      =======================================================
      */

      const edges =
        modelMarkets
          .filter(
            x =>
              x.odds?.ev != null
          )
          .sort(
            (a, b) =>
              Number(b.odds.ev) -
              Number(a.odds.ev)
          );

      const top =
        edges[0] || null;

      /*
      =======================================================
      CONFIANZA
      =======================================================
      */

      const confidenceScore =
        confidence(
          top
            ? top.probability / 100
            : Math.max(
                m.homeWin,
                m.draw,
                m.awayWin
              ),
          ha.games + aa.games,
          top
            ? Number(top.odds.ev) / 100
            : 0
        );

      /*
      =======================================================
      RESPUESTA COMPLETA V7.2
      =======================================================
      */

      res.json({
        fixture: {
          id: f.id,
          date: f.utcDate,
          status: f.status,
          league:
            f.competition?.name,
          competitionCode:
            f.competition?.code,
          home:
            f.homeTeam.name,
          away:
            f.awayTeam.name
        },

        samples: {
          home: ha,
          away: aa
        },

        strength: {
          home: {
            attack:
              Number(homeAttack.toFixed(3)),
            defense:
              Number(homeDefense.toFixed(3)),
            form:
              ha.form != null
                ? Number(
                    ha.form.toFixed(3)
                  )
                : null
          },

          away: {
            attack:
              Number(awayAttack.toFixed(3)),
            defense:
              Number(awayDefense.toFixed(3)),
            form:
              aa.form != null
                ? Number(
                    aa.form.toFixed(3)
                  )
                : null
          }
        },

        xg: {
          home:
            Number(
              homeXg.toFixed(3)
            ),
          away:
            Number(
              awayXg.toFixed(3)
            )
        },

        model: {
          homeWin:
            pct(m.homeWin),
          draw:
            pct(m.draw),
          awayWin:
            pct(m.awayWin),
          over25:
            pct(m.over25),
          under25:
            pct(m.under25),
          btts:
            pct(m.btts)
        },

        markets:
          modelMarkets,

        bestValue:
          top,

        confidence:
          confidenceScore,

        odds,

        modelVersion:
          'V7.2',

        attribution:
          'Football data provided by the Football-Data.org API.'
      });

    } catch (e) {
      res.status(500).json({
        error: e.message
      });
    }
  }
);

/*
===========================================================
INTERFAZ WEB
===========================================================
*/

const html = `<!doctype html>
<html lang="es">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width,initial-scale=1,viewport-fit=cover"
>

<meta
  name="theme-color"
  content="#070b12"
>

<title>Mi Pronóstico Deportivo</title>

<style>

:root{
  --bg:#070b12;
  --panel:#101722;
  --panel2:#151e2c;
  --line:#223044;
  --text:#f7f9fc;
  --muted:#8e9aae;
  --accent:#39e58c;
  --accent2:#22c55e;
  --blue:#60a5fa;
  --danger:#fb7185;
  --gold:#fbbf24;
}

*{
  box-sizing:border-box;
}

body{
  margin:0;
  background:
    radial-gradient(
      circle at 50% -10%,
      #17304d 0,
      #0b111b 34%,
      var(--bg) 70%
    );
  color:var(--text);
  font-family:
    Inter,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
}

button,
input,
select{
  font:inherit;
}

.app{
  max-width:620px;
  margin:auto;
  min-height:100vh;
  padding-bottom:92px;
}

.top{
  padding:22px 18px 10px;
  display:flex;
  justify-content:space-between;
  align-items:center;
}

.brand{
  display:flex;
  gap:12px;
  align-items:center;
}

.logo{
  width:46px;
  height:46px;
  border-radius:15px;
  background:
    linear-gradient(
      135deg,
      #39e58c,
      #16875c
    );
  display:grid;
  place-items:center;
  font-size:24px;
  box-shadow:
    0 8px 28px #39e58c22;
}

.eyebrow{
  font-size:11px;
  letter-spacing:.14em;
  text-transform:uppercase;
  color:var(--muted);
  font-weight:800;
}

.brand h1{
  font-size:18px;
  margin:2px 0 0;
}

.live{
  font-size:11px;
  border:1px solid #2a6149;
  color:#8ff0bb;
  padding:7px 9px;
  border-radius:999px;
  background:#0c2018;
}

.screen{
  padding:8px 16px;
}

.hero{
  border:1px solid #29405a;
  background:
    linear-gradient(
      135deg,
      #132338,
      #0e1622 60%,
      #101b29
    );
  border-radius:24px;
  padding:20px;
  box-shadow:
    0 20px 50px #0005;
}

.hero h2{
  font-size:26px;
  line-height:1.05;
  margin:7px 0 9px;
}

.hero p{
  color:#a9b6c8;
  margin:0 0 16px;
  font-size:13px;
}

.datebar{
  display:flex;
  gap:9px;
}

.datebar input{
  flex:1;
  min-width:0;
  background:#0b121c;
  border:1px solid #2a3a50;
  color:#fff;
  border-radius:13px;
  padding:12px;
}

.btn{
  border:0;
  border-radius:13px;
  padding:12px 15px;
  background:var(--accent);
  color:#04130b;
  font-weight:900;
}

.section-head{
  display:flex;
  justify-content:space-between;
  align-items:center;
  margin:22px 2px 10px;
}

.section-head h3{
  margin:0;
  font-size:15px;
}

.section-head span{
  font-size:12px;
  color:var(--muted);
}

.games{
  display:grid;
  gap:10px;
}

.game{
  width:100%;
  text-align:left;
  border:1px solid var(--line);
  background:
    linear-gradient(
      180deg,
      #121a26,
      #0e151f
    );
  border-radius:18px;
  padding:15px;
  color:#fff;
  cursor:pointer;
}

.game:hover{
  border-color:#35506e;
}

.league{
  font-size:10px;
  color:#8190a6;
  text-transform:uppercase;
  letter-spacing:.1em;
  margin-bottom:9px;
}

.teams{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
}

.team{
  font-weight:850;
  font-size:14px;
  max-width:42%;
}

.vs{
  font-size:11px;
  color:#637188;
}

.state{
  font-size:11px;
  color:#8ca0b8;
  margin-top:9px;
}

.panel{
  border:1px solid var(--line);
  background:var(--panel);
  border-radius:20px;
  padding:16px;
  margin-top:12px;
}

.analysis-head{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:12px;
}

.analysis-head h2{
  font-size:20px;
  line-height:1.15;
  margin:0 0 5px;
}

.muted{
  color:var(--muted);
}

.tag{
  display:inline-flex;
  padding:6px 9px;
  border-radius:999px;
  background:#172334;
  border:1px solid #293b52;
  color:#a8b8cd;
  font-size:10px;
  font-weight:800;
}

.metrics{
  display:grid;
  grid-template-columns:
    repeat(3,1fr);
  gap:8px;
  margin:15px 0;
}

.metric{
  background:#0b121b;
  border:1px solid #1e2b3c;
  border-radius:14px;
  padding:12px;
}

.metric label{
  display:block;
  font-size:10px;
  color:#8493a8;
}

.metric strong{
  display:block;
  font-size:19px;
  margin-top:5px;
}

.metric.accent strong{
  color:var(--accent);
}

.valuebox{
  border:1px solid #2d6248;
  background:
    linear-gradient(
      135deg,
      #10241a,
      #0c1714
    );
  border-radius:16px;
  padding:14px;
  margin:12px 0;
}

.valuebox .big{
  font-size:20px;
  font-weight:900;
}

.valuebox .ev{
  color:var(--accent);
  font-weight:900;
  margin-top:5px;
}

.rows{
  display:grid;
  gap:7px;
}

.market{
  display:grid;
  grid-template-columns:
    1.3fr .7fr auto;
  gap:8px;
  align-items:center;
  background:#0b121b;
  border:1px solid #1b2939;
  border-radius:12px;
  padding:10px;
  font-size:12px;
}

.market b{
  font-size:13px;
}

.market .odd{
  color:#b9c6d7;
}

.market .evpos{
  color:var(--accent);
  font-weight:900;
}

.stats-grid{
  display:grid;
  grid-template-columns:
    repeat(2,1fr);
  gap:8px;
  margin-top:12px;
}

.stat-card{
  background:#0b121b;
  border:1px solid #1e2b3c;
  border-radius:14px;
  padding:12px;
}

.stat-card .title{
  font-size:10px;
  color:#8493a8;
  text-transform:uppercase;
  letter-spacing:.06em;
}

.stat-card strong{
  display:block;
  margin-top:5px;
  font-size:16px;
}

.form-good{
  color:var(--accent);
}

.form-mid{
  color:var(--gold);
}

.form-low{
  color:var(--danger);
}

.empty,
.error{
  padding:18px;
  text-align:center;
  border:1px dashed #2a394d;
  border-radius:17px;
  color:var(--muted);
  background:#0c131d;
}

.error{
  color:#ff9aaa;
  border-style:solid;
  border-color:#56303b;
}

.bottom{
  position:fixed;
  z-index:5;
  bottom:0;
  left:50%;
  transform:translateX(-50%);
  width:min(620px,100%);
  padding:
    9px
    14px
    calc(9px + env(safe-area-inset-bottom));
  background:#070b12ee;
  backdrop-filter:blur(18px);
  border-top:1px solid #1a2635;
  display:grid;
  grid-template-columns:
    repeat(3,1fr);
  gap:5px;
}

.nav{
  border:0;
  background:transparent;
  color:#6f7e92;
  padding:7px;
  border-radius:12px;
  font-size:10px;
}

.nav.active{
  background:#112219;
  color:var(--accent);
}

.nav span{
  display:block;
  font-size:19px;
  margin-bottom:3px;
}

.foot{
  text-align:center;
  color:#5f6d80;
  font-size:9px;
  margin:22px 0;
}

.spin{
  display:inline-block;
  width:13px;
  height:13px;
  border:2px solid #ffffff33;
  border-top-color:var(--accent);
  border-radius:50%;
  animation:spin .8s linear infinite;
  vertical-align:-2px;
}

@keyframes spin{
  to{
    transform:rotate(360deg);
  }
}

@media(min-width:621px){

  body{
    padding-bottom:1px;
  }

  .bottom{
    bottom:12px;
    border:1px solid #1c2a3b;
    border-radius:20px;
  }

  .screen{
    padding-left:18px;
    padding-right:18px;
  }
}

</style>

</head>

<body>

<div class="app">

<header class="top">

<div class="brand">

<div class="logo">
⚽
</div>

<div>

<div class="eyebrow">
SPORTS INTELLIGENCE
</div>

<h1>
Mi Pronóstico Deportivo
</h1>

</div>

</div>

<div
  id="apiState"
  class="live"
>
● V7.2
</div>

</header>

<main class="screen">

<section class="hero">

<div class="eyebrow">
ANÁLISIS ESTADÍSTICO
</div>

<h2>
Encuentra valor, no corazonadas.
</h2>

<p>
Comparamos el modelo estadístico con las cuotas disponibles para encontrar probabilidades y posibles oportunidades de valor.
</p>

<div class="datebar">

<input
  id="date"
  type="date"
>

<button
  class="btn"
  onclick="loadFixtures()"
>
Buscar
</button>

</div>

</section>

<div class="section-head">

<h3>
Partidos
</h3>

<span id="status">
Selecciona una fecha
</span>

</div>

<section
  id="games"
  class="games"
>

<div class="empty">
Pulsa <b>Buscar</b> para cargar los partidos.
</div>

</section>

<section id="out"></section>

<div class="foot">
Football data provided by the Football-Data.org API · Las probabilidades son estimaciones, no garantías.
</div>

</main>

<nav class="bottom">

<button class="nav active">
<span>⌂</span>
Inicio
</button>

<button
  class="nav"
  onclick="document.getElementById('games').scrollIntoView({behavior:'smooth'})"
>
<span>⚽</span>
Partidos
</button>

<button
  class="nav"
  onclick="document.getElementById('out').scrollIntoView({behavior:'smooth'})"
>
<span>◈</span>
Análisis
</button>

</nav>

</div>

<script>

const $ =
  id =>
    document.getElementById(id);

const now =
  new Date();

$('date').value =
  new Date(
    now -
    now.getTimezoneOffset() *
    60000
  )
    .toISOString()
    .slice(0,10);

function esc(s){

  return String(
    s ?? ''
  )
    .replace(
      /[&<>"']/g,
      m => ({
        '&':'&amp;',
        '<':'&lt;',
        '>':'&gt;',
        '"':'&quot;',
        "'":'&#39;'
      }[m])
    );
}

function odds(o){

  if(!o){

    return `
      <span class="muted">
        Sin cuota
      </span>
    `;
  }

  return `
    <span class="odd">
      ${o.odds}
    </span>

    <span class="muted">
      EV ${o.ev}%
    </span>
  `;
}

function formClass(form){

  if(form == null){
    return '';
  }

  if(form >= 0.65){
    return 'form-good';
  }

  if(form >= 0.45){
    return 'form-mid';
  }

  return 'form-low';
}

function formText(form){

  if(form == null){
    return 'Sin datos';
  }

  if(form >= 0.75){
    return 'Excelente';
  }

  if(form >= 0.60){
    return 'Buena';
  }

  if(form >= 0.45){
    return 'Regular';
  }

  if(form >= 0.30){
    return 'Baja';
  }

  return 'Muy baja';
}

async function loadFixtures(){

  const date =
    $('date').value;

  $('status').innerHTML =
    '<span class="spin"></span> Consultando';

  $('games').innerHTML =
    `
      <div class="empty">
        <span class="spin"></span>
        Cargando partidos...
      </div>
    `;

  $('out').innerHTML = '';

  try{

    const r =
      await fetch(
        '/api/fixtures?date=' +
        encodeURIComponent(date)
      );

    const j =
      await r.json();

    if(j.error){
      throw Error(j.error);
    }

    const games =
      (j.matches || [])
        .filter(
          x =>
            x.homeTeam?.name &&
            x.awayTeam?.name
        );

    $('status').textContent =
      games.length +
      ' partidos';

    if(!games.length){

      $('games').innerHTML =
        `
          <div class="empty">
            No hay partidos disponibles para esta fecha con la cobertura actual.
          </div>
        `;

      return;
    }

    $('games').innerHTML =
      games
        .map(
          x =>
            `
              <button
                class="game"
                onclick="analyze(${x.id})"
              >

                <div class="league">
                  ${esc(
                    x.competition?.name ||
                    'Fútbol'
                  )}
                </div>

                <div class="teams">

                  <div class="team">
                    ${esc(
                      x.homeTeam.name
                    )}
                  </div>

                  <div class="vs">
                    VS
                  </div>

                  <div
                    class="team"
                    style="text-align:right"
                  >
                    ${esc(
                      x.awayTeam.name
                    )}
                  </div>

                </div>

                <div class="state">
                  ${esc(
                    x.status ||
                    'PROGRAMADO'
                  )}
                  · Ver análisis →
                </div>

              </button>
            `
        )
        .join('');

  }catch(e){

    $('status').textContent =
      'Error';

    $('games').innerHTML =
      `
        <div class="error">
          ${esc(e.message)}
        </div>
      `;
  }
}

async function analyze(id){

  const out =
    $('out');

  out.innerHTML =
    `
      <div class="panel">

        <span class="spin"></span>

        Analizando forma, fuerza local/visitante, Poisson y cuotas...

      </div>
    `;

  out.scrollIntoView({
    behavior:'smooth',
    block:'start'
  });

  try{

    const r =
      await fetch(
        '/api/analyze?id=' +
        id
      );

    const j =
      await r.json();

    if(j.error){
      throw Error(j.error);
    }

    const m =
      j.model;

    const b =
      j.bestValue;

    const home =
      j.samples.home;

    const away =
      j.samples.away;

    const homeStrength =
      j.strength?.home;

    const awayStrength =
      j.strength?.away;

    const markets =
      j.markets
        .map(
          x =>
            `
              <div class="market">

                <div>

                  ${esc(x.market)}

                  <br>

                  <b>
                    ${esc(x.selection)}
                  </b>

                </div>

                <b>
                  ${x.probability}%
                </b>

                <div>
                  ${odds(x.odds)}
                </div>

              </div>
            `
        )
        .join('');

    const bestValueHtml =
      b
        ? `
          <div class="valuebox">

            <div class="eyebrow">
              MEJOR VALOR DETECTADO
            </div>

            <div class="big">
              ${esc(b.selection)}
              ·
              ${b.probability}%
            </div>

            <div class="ev">
              EV +${esc(b.odds.ev)}%
              · cuota ${esc(b.odds.odds)}
              · ${esc(b.odds.bookmaker)}
            </div>

          </div>
        `
        : `
          <div class="empty">
            No hay una cuota compatible para calcular valor en este partido.
          </div>
        `;

    const strengthHtml =
      `
        <div class="section-head">

          <h3>
            Fuerza de los equipos
          </h3>

          <span>
            V7.2
          </span>

        </div>

        <div class="stats-grid">

          <div class="stat-card">

            <div class="title">
              Ataque local
            </div>

            <strong>
              ${
                homeStrength?.attack != null
                  ? homeStrength.attack.toFixed(2)
                  : '—'
              }
            </strong>

          </div>

          <div class="stat-card">

            <div class="title">
              Defensa local
            </div>

            <strong>
              ${
                homeStrength?.defense != null
                  ? homeStrength.defense.toFixed(2)
                  : '—'
              }
            </strong>

          </div>

          <div class="stat-card">

            <div class="title">
              Ataque visitante
            </div>

            <strong>
              ${
                awayStrength?.attack != null
                  ? awayStrength.attack.toFixed(2)
                  : '—'
              }
            </strong>

          </div>

          <div class="stat-card">

            <div class="title">
              Defensa visitante
            </div>

            <strong>
              ${
                awayStrength?.defense != null
                  ? awayStrength.defense.toFixed(2)
                  : '—'
              }
            </strong>

          </div>

          <div class="stat-card">

            <div class="title">
              Forma local
            </div>

            <strong
              class="${formClass(
                home.form
              )}"
            >
              ${formText(
                home.form
              )}
            </strong>

          </div>

          <div class="stat-card">

            <div class="title">
              Forma visitante
            </div>

            <strong
              class="${formClass(
                away.form
              )}"
            >
              ${formText(
                away.form
              )}
            </strong>

          </div>

        </div>
      `;

    out.innerHTML =
      `
        <div class="panel">

          <div class="analysis-head">

            <div>

              <div class="eyebrow">
                ANÁLISIS DEL PARTIDO
              </div>

              <h2>

                ${esc(
                  j.fixture.home
                )}

                <br>

                <span class="muted">
                  vs
                </span>

                ${esc(
                  j.fixture.away
                )}

              </h2>

              <span class="tag">
                ${esc(
                  j.fixture.league ||
                  'Fútbol'
                )}
              </span>

            </div>

            <span class="tag">
              Confianza
              ${j.confidence}/99
            </span>

          </div>

          <div class="metrics">

            <div class="metric accent">

              <label>
                LOCAL
              </label>

              <strong>
                ${m.homeWin}%
              </strong>

            </div>

            <div class="metric">

              <label>
                EMPATE
              </label>

              <strong>
                ${m.draw}%
              </strong>

            </div>

            <div class="metric accent">

              <label>
                VISITANTE
              </label>

              <strong>
                ${m.awayWin}%
              </strong>

            </div>

            <div class="metric">

              <label>
                OVER 2.5
              </label>

              <strong>
                ${m.over25}%
              </strong>

            </div>

            <div class="metric">

              <label>
                UNDER 2.5
              </label>

              <strong>
                ${m.under25}%
              </strong>

            </div>

            <div class="metric">

              <label>
                BTTS
              </label>

              <strong>
                ${m.btts}%
              </strong>

            </div>

          </div>

          ${bestValueHtml}

          <div class="section-head">

            <h3>
              Mercados
            </h3>

            <span>
              Modelo vs mercado
            </span>

          </div>

          <div class="rows">
            ${markets}
          </div>

          ${strengthHtml}

          <div class="section-head">

            <h3>
              Base estadística
            </h3>

            <span>
              últimos 10
            </span>

          </div>

          <p
            class="muted"
            style="font-size:12px"
          >
            Local:
            ${home.games}
            partidos ·
            ${home.gf != null
              ? home.gf.toFixed(2)
              : '—'}
            GF /
            ${home.ga != null
              ? home.ga.toFixed(2)
              : '—'}
            GC
          </p>

          <p
            class="muted"
            style="font-size:12px"
          >
            Local específico:
            ${home.homeGames}
            partidos ·
            ${home.homeGF != null
              ? home.homeGF.toFixed(2)
              : '—'}
            GF /
            ${home.homeGA != null
              ? home.homeGA.toFixed(2)
              : '—'}
            GC
          </p>

          <p
            class="muted"
            style="font-size:12px"
          >
            Visitante:
            ${away.games}
            partidos ·
            ${away.gf != null
              ? away.gf.toFixed(2)
              : '—'}
            GF /
            ${away.ga != null
              ? away.ga.toFixed(2)
              : '—'}
            GC
          </p>

          <p
            class="muted"
            style="font-size:12px"
          >
            Visitante específico:
            ${away.awayGames}
            partidos ·
            ${away.awayGF != null
              ? away.awayGF.toFixed(2)
              : '—'}
            GF /
            ${away.awayGA != null
              ? away.awayGA.toFixed(2)
              : '—'}
            GC
          </p>

          <p
            class="muted"
            style="font-size:12px"
          >
            xG estimado:
            ${Number(
              j.xg.home
            ).toFixed(2)}
            —
            ${Number(
              j.xg.away
            ).toFixed(2)}
          </p>

          <p
            class="muted"
            style="font-size:10px"
          >
            Cuotas:
            ${
              j.odds.available
                ? j.odds.bookmakers.join(', ')
                : j.odds.reason
            }
          </p>

          <p
            class="muted"
            style="font-size:10px"
          >
            Modelo:
            ${j.modelVersion || 'V7.2'}
          </p>

        </div>
      `;

  }catch(e){

    out.innerHTML =
      `
        <div class="panel error">
          ${esc(e.message)}
        </div>
      `;
  }
}

loadFixtures();

</script>

</body>

</html>`;

app.get(
  '/',
  (_, res) =>
    res.type('html').send(html)
);

app.listen(
  PORT,
  () =>
    console.log(
      `Mi Pronóstico Deportivo en puerto ${PORT}`
    )
);
