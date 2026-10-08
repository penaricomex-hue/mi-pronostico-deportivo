// Verifica la sintaxis de todos los archivos JavaScript del servidor, scripts y tests.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const roots = ['server', 'scripts', 'tests', 'server.js'];
const files = [];
function walk(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
  else if (p.endsWith('.js')) files.push(p);
}
roots.forEach(walk);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`Error de sintaxis en ${f}:\n${err.stderr?.toString() || err.message}`);
  }
}
console.log(`${files.length - failed}/${files.length} archivos JS sin errores de sintaxis.`);
process.exit(failed ? 1 : 0);
