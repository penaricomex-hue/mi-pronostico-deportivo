# MK Bets · mi-pronostico-deportivo

MK Bets se especializa en **dos torneos**: **LaLiga EA Sports** y la **UEFA Champions League**. Combina un modelo **Dixon-Coles** calibrado por competición y mercado con el consenso sin margen de varias casas, y solo recomienda una apuesta si la **cuota real de Caliente MX** (la casa de ejecución) deja EV positivo.

Versión: **V10.0.0**. Producción: <https://mi-pronostico-deportivo.onrender.com> (requiere usuario y contraseña).

## Enfoque V10

1. **Competiciones activas**: `la_liga` (PD) y `champions_league` (CL). Las demás ligas quedan desactivadas sin borrar histórico: `matches.competition_slug = 'excluded'`, y toda consulta de partidos, predicciones, backtest y rendimiento filtra `competition_slug IN ('la_liga','champions_league')`.
2. **Cuotas** en `bookmaker_odds` (una fila por captura, con `captured_at`, `is_opening` e `is_closing`). `caliente_mx` se guarda aparte del resto de casas; el consenso sin margen se construye con 3 o más casas **sin incluir a Caliente**.
3. **Motor de valor** (`server/model/valueEngine.js`): `EV = p_calibrada × cuota_Caliente − 1`. Recomienda solo si EV ≥ 5 %, la diferencia modelo − mercado es ≤ 10 pts, la cuota de Caliente está entre 1.50 y 4.00 y no se han dado ya 3 señales en esa jornada. Mercados: 1X2, doble oportunidad, más/menos 2.5, ambos anotan y hándicap asiático.
4. **Calibración** por competición y mercado (`la_liga_1x2`, `la_liga_over_under`, `la_liga_btts`, `champions_league_1x2`…): Platt con menos de 300 casos e isotónica robusta (bloques de 40 o más casos) a partir de ahí. Se reajusta automáticamente con cada resultado real; la app explica, por ejemplo: “El modelo dijo 68 %, pero en ese rango ha ganado 61 % históricamente; probabilidad calibrada: 61 %”.
5. **Señales** (`bet_signals`): guardan la probabilidad original y la calibrada, la probabilidad de mercado, la cuota exacta de Caliente y su hora de captura, EV, stake y modo (`paper`). Al inicio del partido se fija la cuota de cierre para calcular el **CLV**; al terminar se liquidan.
6. **Panel “Rendimiento — LaLiga y Champions”** (7/30/60/90 días): señales, acierto, ROI, ganancia, yield, EV medio, CLV, % con CLV positivo, calibración por rangos, Caliente frente al mercado y mejores y peores mercados.

### Cuotas de Caliente MX

Caliente MX no aparece en ninguna API pública de cuotas. Hay dos vías:

- **Manual**: en el análisis de un partido o en la pestaña **Señales** (lista “Revisa en Caliente MX”, que indica la cuota mínima necesaria). Cada cuota se guarda con su hora exacta.
- **Feed JSON opcional**: `CALIENTE_FEED_URL` (+ `CALIENTE_FEED_TOKEN`) que devuelva `[{ "home", "away", "kickoff", "competition", "selection", "odds" }]`. Se consulta cada `CALIENTE_FEED_MINUTES`.

También existe `POST /api/caliente/odds` con `{ fixtureId, date, competition, tz, entries: [{ selection, odds }] }`.

### Resultados honestos del backtest

LaLiga, entrenamiento 2023-24 y 2024-25 y prueba 2025-26 y 2026-27 (449 partidos que el ajuste nunca vio):

| Métrica | Modelo | Mercado sin margen |
|---|---|---|
| Brier 1X2 | 0.5786 | 0.5696 |
| Log-loss 1X2 | 0.9745 | 0.9609 |

Motor V10 en prueba, usando como cuota de ejecución la **media de apertura del mercado** (no existe histórico público de Caliente): 118 señales, acierto del 36.4 %, yield del −9.1 % y CLV medio del −7.3 %. Más/menos 2.5: 60 apuestas con un yield del −4.7 %; 1X2: 58 apuestas con un yield del −13.7 %.

Lectura: a precio medio de mercado **no hay ventaja**. El valor depende de que Caliente MX pague por encima del consenso en momentos concretos, y eso solo se puede medir con señales reales. Champions: Brier del modelo de 0.5372 en 189 partidos, sin cuotas históricas públicas.

Por eso la app arranca en **paper trading** (`PAPER_TRADING=true`). La meta es acumular **300–500 señales** durante 30–60 días y decidir con el CLV, no con el porcentaje de aciertos.

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
src/                      Frontend React + Tailwind (pestañas Partidos, Señales, Rendimiento, Mis apuestas, Backtest, Estado)
data/
  history/PD.json         LaLiga: resultados y cuotas reales (football-data.co.uk)
  history/CL.json         Champions: resultados (football-data.org, sin cuotas)
  calibration-seed.json   Predicciones fuera de muestra para iniciar la calibración
  teams.json              Alias de equipos por liga (evita confundir Milan con Inter o PSG con Paris FC)
  model-params.json       Parámetros aprendidos en el backtest (ξ y pesos de mezcla por liga)
  backtest-report.json    Informe del backtest
scripts/                  fetch-history, run-backtest, check-syntax
tests/                    Pruebas con node:test
android/                  App Android (WebView endurecida)
```

Flujo de una señal:

1. Calendario de football-data.org, solo PD y CL.
2. Goles esperados con Dixon-Coles y probabilidades de todos los mercados a partir de la matriz de marcadores.
3. Calibración por competición y mercado.
4. Probabilidad de mercado sin margen con 3 o más casas (sin Caliente).
5. Comparación con la cuota real de Caliente MX en el motor de valor y tope de 3 señales por jornada.
6. Registro de la señal con la cuota y la hora exactas, cierre (CLV), liquidación y recalibración.

## Variables de entorno

Consulta `.env.example`. Las imprescindibles en Render:

| Variable | Uso |
|---|---|
| `APP_USERNAME`, `APP_PASSWORD` | Obligatorias. Sin ellas la app responde 503 |
| `FOOTBALL_DATA_TOKEN` | Calendario y resultados de LaLiga y Champions |
| `ODDS_API_KEY` | Cuotas de las demás casas (1X2, goles y hándicap: 3 créditos por consulta) |
| `ODDS_EVENT_MARKETS` | Opcional: `btts,double_chance` por partido (cuesta créditos extra) |
| `DATABASE_URL` | Obligatoria para cuotas, señales, calibración y rendimiento |
| `TRACK_CLOSING_ODDS` | `true` para capturar el cierre y medir el CLV |
| `PAPER_TRADING` | `true` (por defecto) durante la validación |
| `ENGINE_MIN_EV`, `ENGINE_MAX_MARKET_GAP`, `ENGINE_MIN_ODDS`, `ENGINE_MAX_ODDS`, `ENGINE_MAX_BETS_PER_MATCHDAY`, `ENGINE_MIN_MARKET_BOOKS` | Reglas del motor (0.05, 0.10, 1.50, 4.00, 3 y 3) |
| `CALIENTE_FEED_URL`, `CALIENTE_FEED_TOKEN`, `CALIENTE_FEED_MINUTES` | Feed opcional de cuotas de Caliente MX |
| `SIGNALS_EVERY_MINUTES`, `CALIBRATE_EVERY_HOURS`, `SETTLE_EVERY_MINUTES` | Frecuencia de las tareas automáticas |
| `CURRENCY`, `STAKE`, `BANKROLL`, `KELLY_FRACTION`, `MAX_STAKE_PCT` | Banca |

En el plan gratuito de Render el servicio se duerme sin tráfico; las tareas automáticas solo corren mientras está despierto.

## Comandos

```bash
npm ci                 # instalar
npm run dev:server     # API en :3000 (con recarga)
npm run dev            # frontend en :5173 (reenvía /api al :3000)
npm run lint           # TypeScript + sintaxis del servidor
npm test               # pruebas
npm run build          # compilar el frontend a dist/
npm start              # producción (sirve dist/ y la API)
npm run fetch-history  # actualizar data/history/PD.json desde football-data.co.uk
node scripts/fetch-cl-history.js  # actualizar data/history/CL.json (necesita FOOTBALL_DATA_TOKEN)
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
