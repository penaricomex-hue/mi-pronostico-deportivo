# Mi Pronóstico Deportivo — Modelo Cuantitativo V8.0.4

Sistema de análisis y predicción estadística de fútbol basado en modelado probabilístico Poisson & Dixon-Coles, estimación bayesiana con regresión a la media (shrinkage), ventaja de local empírica, fatiga asimétrica y valor esperado (EV) contrastado contra cuotas reales.

---

## 🌟 Novedades V8.0.4 (Pipeline Cuantitativo Unificado)

1. **Pipeline Matemático Unificado (`predictFixture`)**:
   - Centraliza el cálculo de Poisson, Dixon-Coles y expectativas de goles en una única función canónica compartida entre análisis individual, valor esperado (Value Bets), Parlays inteligentes y Backtesting.
2. **Backtesting Walk-Forward Riguroso (120 Partidos Históricos)**:
   - Ordenación estrictamente temporal sin contaminación futura (*no look-ahead bias*).
   - Métricas estadísticas profesionales: **Brier Score multi-clase**, **Log Loss**, exactitud 1X2, Over/Under 2.5, BTTS (ambos marcan) y simulación de rendimiento ROI.
3. **Ventaja de Local Dinámica y Empírica**:
   - Estimación empírica bayesiana del ratio histórico local vs visitante por liga con regresión hacia la media global (1.09x).
4. **Cálculo de Lesiones Ponderado por Posición**:
   - Evaluación según impacto táctico (portero titular, atacante principal, defensas) con límite máximo del 8% total.
5. **Fatiga Asimétrica Continua**:
   - Modela por separado la fatiga defensiva y ofensiva en función de los días de descanso acumulados.
6. **Segunda Opinión Externa (Big Balls)**:
   - Módulo desacoplado que no distorsiona el score de confianza (`confidence`) matemático interno.
7. **Caché Multinivel con TTLs Reales del Servidor**:
   - **Cuotas (Odds)**: 10 min
   - **Análisis de Partidos**: 60 min
   - **Fixtures (Calendario)**: 180 min (3 horas)
   - **Lesiones**: 360 min (6 horas)
   - **Historial de Resultados**: 2880 min (48 horas)
   - **Equipos y Plantillas**: 20160 min (14 días)
   - **Backtest Walk-Forward**: 43200 min (30 días)
   - **Por Defecto**: 120 min

---

## 🔑 Variables de Entorno en Render

Configura las siguientes variables en el panel de **Render** (`Environment`):

| Variable | Descripción | Obligatorio |
|---|---|---|
| `FOOTBALL_DATA_TOKEN` | Token de API de [football-data.org](https://www.football-data.org/) (partidos, plantillas y resultados). | Sí |
| `ODDS_API_KEY` | Clave de API de [The Odds API](https://the-odds-api.com/) para cuotas en tiempo real. | Opcional (recomendado) |
| `BIGBALLS_KEY` | Clave de API de Big Balls Data para contrastar segunda opinión. | Opcional |
| `DATABASE_URL` | URL de conexión de PostgreSQL para guardar apuestas simuladas y métricas. | Opcional |
| `APP_USERNAME` | Usuario para proteger la web con Basic Auth en Render. | Opcional |
| `APP_PASSWORD` | Contraseña para proteger la web con Basic Auth en Render. | Opcional |
| `STAKE_EUR` | Importe predeterminado por apuesta (por defecto `10`). | Opcional |

> **Nota de Seguridad**: Nunca subas tus claves de API ni credenciales directamente al repositorio público de GitHub.

---

## 🚀 Despliegue en Render

1. Haz push a tu rama principal (`main`) en GitHub.
2. En Render, configura tu **Web Service**:
   - **Build Command**: `npm ci && npm run build`
   - **Start Command**: `node server.js`
   - **Environment Variables**: Añade `FOOTBALL_DATA_TOKEN` y las opcionales deseadas.
3. El servicio compilará e iniciará automáticamente en `https://mi-pronostico-deportivo.onrender.com`.

---

## 📱 Aplicación Android (APK)

El proyecto incluye la carpeta `android/` configurada como contenedor WebView moderno (SDK 35, Java 17, Gradle 8.9) que conecta directamente con tu backend en Render. Al actualizar `server.js` en Render, todos los usuarios de la APK reciben las mejoras instantáneamente sin necesidad de redistribuir el APK.
