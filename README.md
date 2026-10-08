# MK Bets · mi-pronostico-deportivo

Pronósticos de **LaLiga EA Sports** y **UEFA Champions League** con un modelo **Dixon-Coles**, **calibración** por competición y mercado, un **ValueBettingEngine** con reglas estrictas, **cuotas reales con hora exacta** y un **panel de rendimiento** que mide lo único que demuestra ventaja: el **CLV** (si tomamos la cuota antes de que el mercado la corrija).

Versión: **V10.0.0**. Producción: <https://mi-pronostico-deportivo.onrender.com> (requiere usuario y contraseña).

## Alcance v10

- Solo `la_liga` y `champions_league`. Premier League, Serie A, Bundesliga, Ligue 1 y Europa League están **desactivadas sin borrar histórico** (`competition_slug = 'excluded'`).
- Todas las consultas de partidos, predicciones, señales, backtest y panel filtran `WHERE competition_slug IN ('la_liga', 'champions_league')`.
- **Paper trading** por defecto (`TRADING_MODE=paper`) durante 30–60 días; objetivo: 300–500 señales reales antes de sacar conclusiones.
- **Casa de ejecución configurable** (`EXECUTION_BOOKMAKER`). Vacío = mejor cuota no atípica entre las casas disponibles. Caliente.mx no está en ninguna fuente gratuita de cuotas, por eso no es la casa principal.

## Cómo decide una apuesta

1. Calendario de football-data.org (o The Odds API como respaldo).
2. Goles esperados con Dixon-Coles (decaimiento temporal; Champions completada con la temporada en curso de football-data.org).
3. **Probabilidad original del modelo** → se guarda en `model_predictions`.
4. **Calibración** con mapas `la_liga_1x2`, `la_liga_over_under`, `la_liga_btts`, `champions_league_1x2`, `champions_league_over_under`, `champions_league_btts` (isotónica o Platt según muestra). Ejemplo en la app: «El modelo dijo 68%, pero en ese rango ha ganado 61% históricamente; probabilidad calibrada: 61%».
5. **Mercado sin margen**: consenso de 3 a 6+ casas (`bookmaker_odds` guarda apertura, capturas intermedias y cierre con `captured_at`).
6. **ValueBettingEngine** (`server/model/valueEngine.js`):
   - EV = p_calibrada × cuota_ejecución − 1 ≥ **5%**
   - |p_calibrada − p_mercado| ≤ **10 pts** («El modelo se desvía demasiado del mercado»)
   - Cuota entre **1.50 y 4.00** durante la validación
   - Mercados: 1X2, doble oportunidad, más/menos 2.5, ambos marcan, hándicap asiático (línea principal)
   - **Máximo 3 señales por jornada** y competición
7. Cada recomendación se registra en `value_signals` con la cuota, la casa y la hora exactas.
8. Antes del inicio se captura la **cuota de cierre** y se calcula el **CLV** = cuota tomada × probabilidad justa de cierre − 1.
9. Al terminar cada jornada se liquidan señales y predicciones y se **reajustan los mapas de calibración** (también semanalmente).

## Backtest walk-forward (fuera de muestra)

Mismas reglas que producción. Calibración ajustada solo con temporadas de entrenamiento.

| Competición | Prueba | Brier 1X2 modelo → calibrado | Mercado | Señales | Yield (cuota media) | CLV (cuota media) | Yield (mejor cuota) | CLV (mejor cuota) |
|---|---|---|---|---|---|---|---|---|
| LaLiga | 2025-26, 2026-27 (449 partidos) | 0.5786 → 0.5770 | 0.5696 | 119 | −7.6% | −6.55% | +0.9% | −2.99% |
| Champions | 2024-25, 2025-26 (378 partidos) | 0.5432 → 0.5432 | sin cuotas históricas | — | — | — | — | — |

Lectura honesta: el modelo aún **no supera al mercado** en LaLiga, y con la cuota media el CLV es negativo. Solo más/menos 2.5 sale positivo en ambos escenarios (+5.0 u y +7.2 u). Por eso v10 arranca en paper trading y la métrica que decide es el CLV real del panel **Rendimiento**. Para la Champions no hay cuotas históricas gratuitas (los resultados vienen de openfootball), así que su rentabilidad solo se medirá con señales reales.

## Arquitectura

```
server/
  competitions.js         Competiciones activas/desactivadas, competition_slug, jornadas
  model/markets.js        Mercados, selecciones, hándicap asiático, liquidación (incl. medias)
  model/valueEngine.js    ValueBettingEngine (evaluateBet + reglas + límite por jornada)
  model/calibration.js    Isotónica (PAV), Platt, mapas por cubetas
  model/marketBook.js     Mercado sin margen y cuota de ejecución
  services/ingest.js      matches, bookmaker_odds (apertura/cierre), model_predictions
  services/calibration.js Mapas de calibración (semilla del backtest + resultados reales)
  services/signals.js     value_signals, cierre/CLV, liquidación, Performance Lab
  services/analysis.js    Análisis de partido
  backtest/walkForward.js Backtest walk-forward v10
src/views/PerformanceView.tsx  Pestaña Rendimiento (7/30/60/90 días)
data/calibration-seed.json     Observaciones fuera de muestra para la calibración inicial
data/history/PD.json, CL.json  Historial (football-data.co.uk y openfootball)
```

Tablas: `matches` (con `competition_slug` + índice), `bookmaker_odds`, `model_predictions`, `value_signals`, `calibration_maps`, `simulated_bets` (apuestas manuales; histórico conservado).

API nueva: `GET /api/performance?days=7|30|60|90`, `GET /api/signals`, `GET /api/calibration`, `POST /api/signals/scan`, `POST /api/signals/settle`.

## Variables de entorno

Consulta `.env.example`. Las principales:

| Variable | Uso |
|---|---|
| `APP_USERNAME`, `APP_PASSWORD` | Obligatorias. Sin ellas la app responde 503 |
| `FOOTBALL_DATA_TOKEN` | Calendario y resultados |
| `ODDS_API_KEY` | Cuotas (plan gratuito: 500 créditos/mes) |
| `DATABASE_URL` | Señales, cuotas, predicciones y calibración persistentes |
| `EXECUTION_BOOKMAKER` | Casa de ejecución; vacío = mejor cuota no atípica |
| `VALUE_MIN_EV`, `VALUE_MAX_MARKET_GAP`, `VALUE_MIN_ODDS`, `VALUE_MAX_ODDS`, `VALUE_MAX_BETS_PER_JORNADA` | Reglas del motor |
| `ODDS_MARKETS`, `ODDS_EXTRA_MARKETS`, `ODDS_EXTRAS_*` | Mercados de The Odds API (BTTS y doble oportunidad cuestan créditos por partido) |
| `ODDS_DAILY_CREDIT_BUDGET`, `ODDS_CLOSING_RESERVE_CREDITS`, `ODDS_CACHE_MINUTES` | Presupuesto diario; parte reservada para la cuota de cierre |
| `TRACK_CLOSING_ODDS` | `true` por defecto (necesario para el CLV) |
| `TRADING_MODE` | `paper` (por defecto) o `live` |
| `CALIBRATION_METHOD` | `auto`, `isotonic` o `platt` |
| `SIGNAL_SCAN_EVERY_MINUTES` | Frecuencia del escaneo automático de señales |

## Comandos

```bash
npm ci                 # instalar
npm run dev:server     # API en :3000 (con recarga)
npm run dev            # frontend en :5173 (reenvía /api al :3000)
npm run lint           # TypeScript + sintaxis del servidor
npm test               # pruebas
npm run build          # compilar el frontend a dist/
npm start              # producción (sirve dist/ y la API)
npm run fetch-history  # actualizar data/history (LaLiga: football-data.co.uk; Champions: openfootball)
npm run backtest       # recalcular backtest, parámetros y semilla de calibración
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

- Resultados y cuotas históricas de LaLiga: [football-data.co.uk](https://www.football-data.co.uk/)
- Resultados históricos de la Champions: [openfootball](https://github.com/openfootball/champions-league)
- Calendario y resultados en vivo: [football-data.org](https://www.football-data.org/)
- Cuotas en vivo: [The Odds API](https://the-odds-api.com/)

Herramienta de análisis estadístico. No garantiza resultados. Apuesta con responsabilidad.
