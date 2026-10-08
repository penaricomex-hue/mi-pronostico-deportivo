#!/usr/bin/env node
/**
 * Descarga temporadas reales y genera data/history/<LIGA>.json
 *
 *   PD (LaLiga)     -> football-data.co.uk (resultados + cuotas apertura/máx/cierre)
 *   CL (Champions)  -> openfootball/champions-league (resultados, sin cuotas)
 *
 * v10 solo actualiza las competiciones activas. Los JSON de las ligas
 * desactivadas (PL, SA, BL1, FL1) se conservan intactos como histórico.
 *
 * Uso:
 *   npm run fetch-history                 # PD y CL, 2022-23 hasta la temporada actual
 *   node scripts/fetch-history.js 2021    # desde 2021-22
 *   node scripts/fetch-history.js 2022 PD # solo una competición
 */
import fs from 'fs';
import path from 'path';
import { createTeamRegistry } from '../server/lib/teams.js';
import { COUK_DIVISION, HISTORY_DIR, downloadSeason, dedupeMatches, seasonCode, SUPPORTED_MODEL_LEAGUES } from '../server/providers/history.js';

const firstYear = Number(process.argv[2]) || 2022;
const only = process.argv.slice(3).map(s => s.toUpperCase());
const leagues = only.length ? only.filter(l => SUPPORTED_MODEL_LEAGUES.includes(l)) : SUPPORTED_MODEL_LEAGUES;
const current = seasonCode();
const currentStart = 2000 + Number(current.slice(0, 2));

const seasons = [];
for (let y = firstYear; y <= currentStart; y++) {
  seasons.push(`${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`);
}

fs.mkdirSync(HISTORY_DIR, { recursive: true });
const teams = createTeamRegistry();
// En Champions, openfootball cambia de nombre entre temporadas: se unifica al canónico.
const canon = (league, name) => (league === 'CL' ? teams.resolve(name, 'CL')?.canonical || name : name);

for (const league of leagues) {
  let all = [];
  for (const season of seasons) {
    try {
      const rows = await downloadSeason(league, season);
      console.log(`${league} ${season}: ${rows.length} partidos`);
      all = all.concat(rows.map(r => ({ ...r, home: canon(league, r.home), away: canon(league, r.away) })));
    } catch (err) {
      console.error(`${league} ${season}: ERROR ${err.message}`);
      process.exitCode = 1;
    }
  }
  const matches = dedupeMatches(all);
  const payload = {
    source: league === 'CL' ? 'https://github.com/openfootball/champions-league' : 'https://www.football-data.co.uk/',
    league,
    division: COUK_DIVISION[league] || 'CL',
    seasons,
    generatedAt: new Date().toISOString(),
    count: matches.length,
    matches
  };
  fs.writeFileSync(path.join(HISTORY_DIR, `${league}.json`), JSON.stringify(payload));
  console.log(`=> ${league}: ${matches.length} partidos guardados`);
}
