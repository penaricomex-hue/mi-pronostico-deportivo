import fs from 'fs';
import { ENGINE_VERSION } from '../engine.js';

console.log('--- Verificación de Integridad y Versionado ---');

// 1. Leer package.json
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
console.log(`- package.json version: ${pkg.version}`);

// 2. Comprobar engine.js
console.log(`- engine.js version: ${ENGINE_VERSION}`);
if (pkg.version !== ENGINE_VERSION) {
  console.error(`ERROR: package.json (${pkg.version}) y engine.js (${ENGINE_VERSION}) difieren.`);
  process.exit(1);
}

// 3. Comprobar server.js
const serverCode = fs.readFileSync('server.js', 'utf8');
const match = serverCode.match(/const MODEL_VERSION\s*=\s*['"]V?([^'"]+)['"]/);
if (!match) {
  console.error('ERROR: No se encontró MODEL_VERSION en server.js');
  process.exit(1);
}
const serverVersion = match[1];
console.log(`- server.js MODEL_VERSION: ${serverVersion}`);

if (serverVersion !== pkg.version) {
  console.error(`ERROR: server.js (${serverVersion}) y package.json (${pkg.version}) difieren.`);
  process.exit(1);
}

// 4. Comprobar que no existan claves hardcodeadas antiguas en server.js
const staleKeys = serverCode.match(/:(v[0-9]{3})/g);
if (staleKeys) {
  console.error(`ERROR: Se encontraron claves de caché obsoletas hardcodeadas en server.js: ${staleKeys.join(', ')}`);
  process.exit(1);
}

console.log('✓ Todas las versiones y claves de caché están 100% sincronizadas y limpias.');
