# MK Bets · mi-pronostico-deportivo

Pronósticos de fútbol con un modelo **Dixon-Coles** ajustado por máxima verosimilitud, **cuotas reales** de varias casas y un **backtest fuera de muestra** que decide, liga por liga, si el modelo merece confianza.

Versión del modelo: **V9.0.0**. Producción: <https://mi-pronostico-deportivo.onrender.com> (requiere usuario y contraseña).

## Resultados honestos del backtest

Entrenamiento con 2023-24 y 2024-25; prueba con 2025-26 y 2026-27 (partidos que el ajuste nunca vio). Brier 1X2, más bajo es mejor; 0.667 equivale a adivinar al azar.

| Liga | Partidos de prueba | Modelo propio | Mercado (cuotas sin margen) | Apuestas de valor | ROI | CLV medio |
|---|---|---|---|---|---|---|
| Premier League | 430 | 0.6157 | 0.6128 | 29 | +44.4% | +4.26% |
| LaLiga | 449 | 0.5786 | 0.5696 | 31 | −38.6% | +1.59% |
| Serie A | 430 | 0.5887 | 0.5781 | 18 | −32.6% | +4.64% |
| Bundesliga | 342 | 0.5806 | 0.5637 | 24 | −42.0% | +3.18% |
| Ligue 1 | 351 | 0.6047 | 0.5859 | 25 | +13.7% | +2.72% |

Qué significa:

- El modelo propio **no supera al mercado** en ninguna liga. Por eso el peso aprendido del modelo en 1X2 es 0% y la probabilidad final de 1X2 es la del mercado. En goles (más/menos de 2.5) el modelo aporta entre 0% y 10%.
- El CLV (cuota tomada frente a la cuota justa de cierre) es positivo en todas las ligas, pero con menos de 50 apuestas por liga el ROI es sobre todo ruido.
- Regla de activación: una liga marca "valor" solo si en prueba hay **≥ 50 apuestas, CLV medio > 0 y ROI ≥ 0**. Hoy ninguna liga la cumple, así que la app **no recomienda apuestas**. Puedes ver las candidatas activando "Mostrar ligas no validadas", bajo tu propio riesgo.

El informe completo está en `data/backtest-report.json` y en la pestaña **Backtest** de la app.

## Arquitectura

```
server.js                 Punto de entrada (Render): importa server/index.js
server/
  index.js                Arranque: configuración, BD, proveedores, servicios y tareas
  app.js                  Express: seguridad, Basic Auth, /health, /api y frontend compilado
  config.js               Variables de entorno
  db.js                   PostgreSQL y migraciones versionadas
  routes/api.js           Endpoints REST
  model/                  Poisson, Dixon-Coles, mercado (devig, Kelly, atípicas), predicción y métricas
  backtest/walkForward.js Backtest walk-forward (reajuste semanal, sin fuga de información)
  providers/              football-data.org, The Odds API, football-data.co.uk (historial), Big Balls
  services/               Ratings, análisis, selecciones de valor, combinadas y apuestas simuladas
  lib/                    HTTP, caché persistente, limitador de llamadas, CSV, nombres de equipos
src/                      Frontend React + Tailwind (pestañas Partidos, Valor, Combinadas, Mis apuestas, Backtest, Estado)
data/
  history/*.json          Resultados y cuotas reales de 5 temporadas por liga (football-data.co.uk)
  teams.json              Alias de equipos por liga (evita confundir Milan con Inter o PSG con Paris FC)
  model-params.json       Parámetros aprendidos en el backtest (ξ y pesos de mezcla por liga)
  backtest-report.json    Informe del backtest
scripts/                  fetch-history, run-backtest, check-syntax
tests/                    Pruebas con node:test
android/                  App Android (WebView endurecida)
```

Flujo de una predicción:

1. Calendario de football-data.org (o de The Odds API si no hay token).
2. Nombres de equipo normalizados con `data/teams.json`.
3. Goles esperados con Dixon-Coles ajustado sobre 3 temporadas con decaimiento temporal.
4. Probabilidad de mercado: consenso sin margen de todas las casas.
5. Probabilidad final = peso aprendido × modelo + (1 − peso) × mercado.
6. Valor: EV ≥ 2%, probabilidad ≥ 20%, cuota ≤ 5, ≥ 3 casas, sin cuota atípica y liga validada.
7. Stake: Kelly fraccional (¼) sobre el bankroll, con tope del 2%.

## Variables de entorno

Consulta `.env.example`. Las imprescindibles en Render:

| Variable | Uso |
|---|---|
| `APP_USERNAME`, `APP_PASSWORD` | Obligatorias. Sin ellas la app responde 503 |
| `FOOTBALL_DATA_TOKEN` | Calendario y resultados (plan gratuito: 10 llamadas/min, sin Europa League) |
| `ODDS_API_KEY` | Cuotas (cada consulta de liga gasta 2 créditos: 1X2 + goles) |
| `DATABASE_URL` | Apuestas simuladas, caché y consumo de cuota que sobreviven a reinicios |
| `CURRENCY`, `STAKE`, `BANKROLL`, `KELLY_FRACTION`, `MAX_STAKE_PCT` | Banca |

## Comandos

```bash
npm ci                 # instalar
npm run dev:server     # API en :3000 (con recarga)
npm run dev            # frontend en :5173 (reenvía /api al :3000)
npm run lint           # TypeScript + sintaxis del servidor
npm test               # pruebas
npm run build          # compilar el frontend a dist/
npm start              # producción (sirve dist/ y la API)
npm run fetch-history  # actualizar data/history desde football-data.co.uk
npm run backtest       # recalcular backtest y parámetros del modelo
```

Después de `npm run fetch-history` ejecuta siempre `npm run backtest` y revisa el informe antes de subir los cambios.

## Forma de trabajar

`main` se despliega automáticamente en Render. Trabaja en una rama, abre un Pull Request y fusiona solo cuando la CI esté en verde:

```bash
git switch -c mi-cambio
# ...cambios...
npm run check
git commit -m "Describe el cambio"
git push -u origin mi-cambio
```

## Seguridad

Consulta [SECURITY.md](SECURITY.md).

## Fuentes de datos

- Resultados y cuotas históricas: [football-data.co.uk](https://www.football-data.co.uk/)
- Calendario y resultados en vivo: [football-data.org](https://www.football-data.org/)
- Cuotas en vivo: [The Odds API](https://the-odds-api.com/)

Herramienta de análisis estadístico. No garantiza resultados. Apuesta con responsabilidad.
