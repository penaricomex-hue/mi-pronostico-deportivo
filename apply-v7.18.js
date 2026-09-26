const fs = require('fs');
const file = process.argv[2] || 'server.js';
if (!fs.existsSync(file)) { console.error(`No existe ${file}`); process.exit(1); }
let s = fs.readFileSync(file, 'utf8');
fs.copyFileSync(file, `${file}.backup-v7.17`);

const oldBlock = `  const toStr = addDaysToDateStr(todayStr, 14);
  const cacheKey = \`favorites-fixtures:\${teams.join('|')}:\${todayStr}\`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const data = await footballData(\`/matches?dateFrom=\${todayStr}&dateTo=\${toStr}\`);
    const matches = Array.isArray(data?.matches) ? data.matches : [];`;

const newBlock = `  const cacheKey = \`favorites-fixtures:\${teams.join('|')}:\${todayStr}\`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    // Football-Data.org limita las consultas a ventanas de máximo 10 días.
    const matches = [];
    for (let offset = 0; offset <= 14; offset += 10) {
      const from = addDaysToDateStr(todayStr, offset);
      const to = addDaysToDateStr(todayStr, Math.min(offset + 9, 14));
      const data = await footballData(\`/matches?dateFrom=\${from}&dateTo=\${to}\`);
      if (Array.isArray(data?.matches)) matches.push(...data.matches);
    }`;

if (!s.includes(oldBlock)) { console.error('No encontré el bloque favorites esperado.'); process.exit(2); }
s = s.replace(oldBlock, newBlock);
if (!s.includes("const CACHE_MINUTES = 1440; // 24 horas")) { console.error('No encontré CACHE_MINUTES.'); process.exit(3); }
s = s.replace("const CACHE_MINUTES = 1440; // 24 horas", "const CACHE_MINUTES = 30; // V7.18");
if (!s.includes("const MODEL_VERSION = 'V7.17.0';")) { console.error('No encontré MODEL_VERSION.'); process.exit(4); }
s = s.replace("const MODEL_VERSION = 'V7.17.0';", "const MODEL_VERSION = 'V7.18.0';");
s = s.replace("FRONTEND - RENDER PAGE (V7.17.0)", "FRONTEND - RENDER PAGE (V7.18.0)");
s = s.replace("MK Bets V7.17.0 - Pronósticos Deportivos", "MK Bets V7.18.0 - Pronósticos Deportivos");
fs.writeFileSync(file, s, 'utf8');
console.log('V7.18 aplicado correctamente.');
