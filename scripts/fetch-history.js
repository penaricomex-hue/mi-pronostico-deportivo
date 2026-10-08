#!/usr/bin/env node
/**
 * Descarga temporadas reales de football-data.co.uk y genera data/history/<LIGA>.json
 *
 * Uso:
 *   npm run fetch-history                 # 2022-23 hasta la temporada actual
 *   node scripts/fetch-history.js 2021    # desde 2021-22
 */
import fs from 'fs';
import path from 'path';
import {
  COUK_DIVISION, HISTORY_DIR, downloadSeason, dedupeMatches, seasonCode
} from '../server/providers/history.js';

const firstYear = Number(process.argv[2]) || 2022;
const current = seasonCode();
const currentStart = 2000 + Number(current.slice(0, 2));

const seasons = [];
for (let y = firstYear; y <= currentStart; y++) {
  seasons.push(`${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`);
}

fs.mkdirSync(HISTORY_DIR, { recursive: true });

for (const league of Object.keys(COUK_DIVISION)) {
  let all = [];
  for (const season of seasons) {
    try {
      const rows = await downloadSeason(league, season);
      console.log(`${league} ${season}: ${rows.length} partidos`);
      all = all.concat(rows);
    } catch (err) {
      console.error(`${league} ${season}: ERROR ${err.message}`);
      process.exitCode = 1;
    }
  }
  const matches = dedupeMatches(all);
  const payload = {
    source: 'https://www.football-data.co.uk/',
    league,
    division: COUK_DIVISION[league],
    seasons,
    generatedAt: new Date().toISOString(),
    count: matches.length,
    matches
  };
  fs.writeFileSync(path.join(HISTORY_DIR, `${league}.json`), JSON.stringify(payload));
  console.log(`=> ${league}: ${matches.length} partidos guardados`);
}
