import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { defineConfig, Plugin } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function zipDownloadPlugin(): Plugin {
  return {
    name: 'zip-download-middleware',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];

        // 1. Descarga de src.zip
        if (url === '/src.zip' || url === '/download-src' || url === '/api/download-src') {
          const filePath = path.resolve(__dirname, 'public/src.zip');
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', 'attachment; filename="src.zip"');
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }

        // 2. Descarga de server.js
        if (url === '/server.js' || url === '/download-server' || url === '/api/download-server') {
          const filePath = path.resolve(__dirname, 'public/server.js');
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', 'attachment; filename="server.js"');
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }

        // 3. Descarga del ZIP completo
        if (
          url.includes('mi-pronostico-deportivo') ||
          url === '/api/download-zip' ||
          url === '/download-zip' ||
          url === '/download.zip'
        ) {
          const filePath = path.resolve(__dirname, 'public/mi-pronostico-deportivo-v8.0.4.zip');
          if (fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', 'attachment; filename="mi-pronostico-deportivo-v8.0.4.zip"');
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }

        next();
      });
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss(), zipDownloadPlugin()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
