# MK BETS — Modelo Estadístico de Pronósticos Deportivos (V8.0)

Sistema de análisis y predicción cuantitativa de fútbol basado en modelado estadístico Poisson & Dixon-Coles, estimación bayesiana con regresión a la media (shrinkage), ventaja de local aprendida empíricamente, fatiga asimétrica y valor esperado (EV) contrastado contra cuotas reales.

---

## 🌟 Novedades V8.0 (Motor Estadístico Refactorizado)

1. **Ventaja de Local Dinámica y Aprendida**:
   - Sustituye los multiplicadores manuales fijos por una estimación empírica bayesiana: ratio histórico de goles local vs visitante por competición con regresión hacia la media global (1.09x).
2. **Cálculo de Lesiones Ponderado por Posición**:
   - Fin al recorte indiscriminado (-3% por jugador). Ahora evalúa posición (portero titular, atacante principal, defensas) y acota el impacto máximo al 8% total.
3. **Fatiga y Descanso Asimétrica y Continua**:
   - Modela por separado la fatiga defensiva (desajustes de repliegue y concentración) y la fatiga ofensiva (pérdida de chispa) con una curva suave en lugar de saltos bruscos irreales.
4. **Segunda Opinión Externa (Big Balls) Desacoplada**:
   - Se presenta como referencia informativa externa. Ya no adultera ni incrementa/reduce artificialmente el score de confianza (`confidence`) del modelo propio.
5. **Corrección de Rango de Fechas (>10 días)**:
   - Chunking automático de peticiones a Football-Data para evitar el error `HTTP 400: Specified period must not exceed 10 days`.
6. **Caché Multinivel con TTL Diferenciado**:
   - Cuotas: 3 min | Análisis: 15 min | Fixtures: 25 min | Lesiones: 90 min | Historial: 4 horas | Equipos: 24 horas.
7. **Motor de Backtesting y Calibración (V8.1 Foundation)**:
   - Medición de Brier Score multi-clase, Log Loss y calibración empírica por tramos de probabilidad.
8. **Radar de Oportunidades de Valor (EV+)**:
   - Escáner automático de cuotas con discrepancia matemática favorable contra la probabilidad estimada.
9. **Gestión de Banca con Criterio de Kelly (Quarter Kelly)**:
   - Calculadora interactiva integrada para dimensionamiento óptimo de stake protegiendo la banca de rachas.
10. **Exportador Rápido de Boletines de Apuestas**:
   - Generación de tickets formateados en un clic para compartir en WhatsApp, Telegram y comunidades.

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
2. En Render, crea un **Web Service**:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Environment Variables**: Añade `FOOTBALL_DATA_TOKEN` y opcionalmente las demás.
3. El servicio compilará e iniciará automáticamente en `https://tu-servicio.onrender.com`.

---

## 📱 Aplicación Android (APK)

El proyecto incluye la carpeta `android/` configurada como un contenedor nativo seguro con WebView apuntando a tu URL de producción en Render. Al actualizar `server.js` en Render, todos los usuarios de la APK reciben las mejoras instantáneamente sin necesidad de recompilar la aplicación móvil.
