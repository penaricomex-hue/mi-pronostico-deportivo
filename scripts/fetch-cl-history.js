#!/usr/bin/env node
/**
 * Descarga el historial de la UEFA Champions League desde football-data.org
 * y lo guarda en data/history/CL.json con el mismo formato que las ligas.
 *
 * football-data.co.uk no publica la Champions, así que este historial no
 * trae cuotas: sirve para ajustar el modelo y la calibración, no para medir ROI.
 *
 * Uso: FOOTBALL_DATA_TOKEN=... node scripts/fetch-cl-history.js 2023 2024 2025
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeFdHistoryMatch } from '../server/providers/history.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '..', 'data', 'history', 'CL.json');
const token = process.env.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_API_KEY;
if (!token) {
  console.error('Falta FOOTBALL_DATA_TOKEN.');
  process.exit(1);
}

const seasons = process.argv.slice(2).length ? process.argv.slice(2).map(Number) : [2023, 2024, 2025];
const all = [];
for (const s of seasons) {
  const res = await fetch(`https://api.football-data.org/v4/competitions/CL/matches?season=${s}`, { headers: { 'X-Auth-Token': token } });
  if (!res.ok) { console.warn(`Temporada ${s}: HTTP ${res.status}`); continue; }
  const data = await res.json();
  const rows = (data.matches || []).map(normalizeFdHistoryMatch).filter(Boolean);
  console.log(`Temporada ${s}: ${rows.length} partidos terminados`);
  all.push(...rows);
  await new Promise(r => setTimeout(r, 6500)); // 10 llamadas/minuto
}
all.sort((a, b) => a.date.localeCompare(b.date));
fs.writeFileSync(OUT, JSON.stringify({ league: 'CL', source: 'football-data.org', generatedAt: new Date().toISOString(), matches: all }));
console.log(`Guardado ${OUT} (${all.length} partidos)`);
