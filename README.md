# MK Bets · mi-pronostico-deportivo

Pronósticos de **LaLiga EA Sports** y **UEFA Champions League** con un modelo **Dixon-Coles**, **calibración** por competición y mercado, un **ValueBettingEngine** con reglas estrictas, **cuotas reales con hora exacta** y un **panel de rendimiento** que mide lo único que demuestra ventaja: el **CLV** (si tomamos la cuota antes de que el mercado la corrija).

Versión: **V10.1.0**. Producción: <https://mi-pronostico-deportivo.onrender.com> (requiere usuario y contraseña).

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
5b. **Mezcla modelo + mercado** (`server/model/blend.js`, v10.1): p_decisión ∝ p_calibrada^w · p_mercado^(1−w). El peso w por competición y grupo está en `data/blend-weights.json` (ajustado en el backtest; Champions hereda el de LaLiga). `BLEND_MODEL_WEIGHT` lo fuerza y `BLEND_ENABLED=false` vuelve al modelo solo.
6. **ValueBettingEngine** (`server/model/valueEngine.js`):
   - EV = p_decisión (mezcla) × cuota_ejecución − 1 ≥ **5%**
   - |p_calibrada − p_mercado| ≤ **10 pts** («El modelo se desvía demasiado del mercado»; se compara el modelo calibrado sin mezclar)
   - Cuota entre **1.50 y 4.00** durante la validación
   - Mercados: 1X2, doble oportunidad, más/menos 2.5, ambos marcan, hándicap asiático (línea principal)
   - **Máximo 3 señales por jornada** y competición
7. Cada recomendación se registra en `value_signals` con la cuota, la casa y la hora exactas. **Todas** las evaluaciones (también las rechazadas) se guardan en `value_evaluations`, una fila por captura de cuotas, con su resultado y su CLV: con ellas el panel estudia qué umbral de EV habría funcionado mejor.
8. Antes del inicio se captura la **cuota de cierre** y se calcula el **CLV** = cuota tomada × probabilidad justa de cierre − 1.
9. Al terminar cada jornada se liquidan señales y predicciones y se **reajustan los mapas de calibración** (también semanalmente).

## Backtest walk-forward (fuera de muestra)

Mismas reglas que producción. Calibración ajustada solo con temporadas de entrenamiento.

| Competición | Prueba | Brier 1X2 modelo → calibrado | Mercado | Señales | Yield (cuota media) | CLV (cuota media) | Yield (mejor cuota) | CLV (mejor cuota) |
|---|---|---|---|---|---|---|---|---|
| LaLiga | 2025-26, 2026-27 (449 partidos) | 0.5786 → 0.5770 | 0.5696 | 119 | −7.6% | −6.55% | +0.9% | −2.99% |
| Champions | 2024-25, 2025-26 (378 partidos) | 0.5432 → 0.5432 | sin cuotas históricas | — | — | — | — | — |

### Mezcla modelo + mercado (v10.1)

En entrenamiento (LaLiga 2023-24 y 2024-25, 760 partidos) el peso óptimo del modelo es prácticamente **0**: el modelo no añade información a las cuotas de apertura. La curva es casi plana hasta w ≈ 0.25, así que se usa el mayor peso cuya log-loss queda a menos de 0.001 del óptimo: **1X2 25%, más/menos 30%** (ambos marcan hereda el de más/menos). En prueba (449 partidos):

| Predicción | Brier 1X2 | Log-loss 1X2 |
|---|---|---|
| Modelo calibrado | 0.5770 | 0.9715 |
| Mezcla | 0.5697 | 0.9607 |
| Mercado | 0.5696 | 0.9609 |

| Escenario (prueba) | Señales | Yield | CLV medio | CLV + |
|---|---|---|---|---|
| Solo modelo · mejor cuota | 122 | +0.9% | −2.99% | 36.1% |
| **Mezcla · mejor cuota** (producción) | 26 | +27.1% | −1.23% | 42.3% |
| Solo modelo · cuota media | 119 | −7.6% | −6.55% | 17.6% |
| Mezcla · cuota media | 0 | — | — | — |

La mezcla mejora el CLV, pero sigue siendo negativo y genera muchas menos señales (el yield con 26 apuestas es ruido). Por eso el estudio de umbrales usa todas las evaluaciones, no solo las señales.

Lectura honesta: el modelo aún **no supera al mercado** en LaLiga, y con la cuota media el CLV es negativo. Solo más/menos 2.5 sale positivo en ambos escenarios (+5.0 u y +7.2 u). Por eso v10 arranca en paper trading y la métrica que decide es el CLV real del panel **Rendimiento**. Para la Champions no hay cuotas históricas gratuitas (los resultados vienen de openfootball), así que su rentabilidad solo se medirá con señales reales.

## Arquitectura

```
server/
  competitions.js         Competiciones activas/desactivadas, competition_slug, jornadas
  model/markets.js        Mercados, selecciones, hándicap asiático, liquidación (incl. medias)
  model/valueEngine.js    ValueBettingEngine (evaluateBet + reglas + límite por jornada)
  model/blend.js          Mezcla modelo + mercado (pooling logarítmico) y ajuste del peso
  lib/stats.js            Intervalos de confianza al 95% y regla de parada del CLV
  model/calibration.js    Isotónica (PAV), Platt, mapas por cubetas
  model/marketBook.js     Mercado sin margen y cuota de ejecución
  services/ingest.js      matches, bookmaker_odds (apertura/cierre), model_predictions
  services/calibration.js Mapas de calibración (semilla del backtest + resultados reales)
  services/signals.js     value_signals, cierre/CLV, liquidación, Performance Lab
  services/analysis.js    Análisis de partido
  backtest/walkForward.js Backtest walk-forward v10
src/views/PerformanceView.tsx  Pestaña Rendimiento (7/30/60/90 días)
data/calibration-seed.json     Observaciones fuera de muestra para la calibración inicial
data/blend-weights.json        Pesos de la mezcla modelo + mercado (generado por npm run backtest)
data/history/PD.json, CL.json  Historial (football-data.co.uk y openfootball)
```

Tablas: `matches` (con `competition_slug` + índice), `bookmaker_odds`, `model_predictions`, `value_signals`, `value_evaluations`, `calibration_maps`, `simulated_bets` (apuestas manuales; histórico conservado).

API: `GET /api/performance?days=7|30|60|90`, `GET /api/evaluations/thresholds?days=…`, `GET /api/signals`, `GET /api/calibration`, `POST /api/signals/scan`, `POST /api/signals/settle`.

## Cómo leer el panel Rendimiento

- **Veredicto del CLV** con intervalo de confianza al 95%: «Muestra insuficiente» (< 30 señales con cierre), «No concluyente», «Ventaja detectada» (todo el intervalo > 0), «Señal de alerta» / «Sin ventaja» (todo el intervalo < 0).
- **Regla de parada**: a las **300 señales con cuota de cierre**, si el intervalo del CLV no está por encima de 0 se cambia el enfoque. Antes, si a las 100 el CLV es negativo con 95% de confianza.
- El yield, el acierto y el CLV de cada competición y mercado muestran su intervalo. Verde/rojo solo cuando todo el intervalo está de un lado de 0.
- **Estudio de umbrales**: para EV ≥ 0, 2, 3, 5, 8 y 10%, mezcla frente a modelo solo, con la primera captura que supera el umbral y una selección por partido.

## Respaldo de la base de datos

`.github/workflows/db-backup.yml` hace un `pg_dump` semanal (lunes 09:30 UTC) de Neon con PostgreSQL 18 y lo guarda 90 días como artefacto de GitHub Actions (`neon-backup-AAAA-MM-DD`). Se puede lanzar a mano desde *Actions → db-backup → Run workflow*. Necesita el secreto `NEON_DATABASE_URL` (la misma cadena que `DATABASE_URL`). Para restaurar:

```bash
pg_restore --no-owner --no-privileges --clean --if-exists -d "postgresql://…/destino" mkbets.dump
```

## Variables de entorno

Consulta `.env.example`. Las principales:

| Variable | Uso |
|---|---|
| `APP_USERNAME`, `APP_PASSWORD` | Obligatorias. Sin ellas la app responde 503 |
| `FOOTBALL_DATA_TOKEN` | Calendario y resultados |
| `ODDS_API_KEY` | Cuotas (plan gratuito: 500 créditos/mes) |
| `DATABASE_URL` | Señales, cuotas, predicciones y calibración persistentes (en producción: Neon Free, 1 GB y 100 CU-h/mes; la app evita mantener despierto el cómputo) |
| `EXECUTION_BOOKMAKER` | Casa de ejecución; vacío = mejor cuota no atípica |
| `VALUE_MIN_EV`, `VALUE_MAX_MARKET_GAP`, `VALUE_MIN_ODDS`, `VALUE_MAX_ODDS`, `VALUE_MAX_BETS_PER_JORNADA` | Reglas del motor |
| `ODDS_MARKETS`, `ODDS_EXTRA_MARKETS`, `ODDS_EXTRAS_*` | Mercados de The Odds API (BTTS y doble oportunidad cuestan créditos por partido) |
| `ODDS_DAILY_CREDIT_BUDGET`, `ODDS_CLOSING_RESERVE_CREDITS`, `ODDS_CACHE_MINUTES` | Presupuesto diario; parte reservada para la cuota de cierre |
| `TRACK_CLOSING_ODDS` | `true` por defecto (necesario para el CLV) |
| `TRADING_MODE` | `paper` (por defecto) o `live` |
| `CALIBRATION_METHOD` | `auto`, `isotonic` o `platt` |
| `BLEND_ENABLED`, `BLEND_MODEL_WEIGHT` | Mezcla modelo + mercado (activada por defecto; el peso fuerza un valor global 0–1) |
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
npm run backtest       # recalcular backtest, parámetros, semilla de calibración y pesos de la mezcla
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
