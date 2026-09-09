# Mi Pronóstico Deportivo — V6 / Android

Ahora el proyecto tiene dos capas:

1. **Backend + interfaz web** en Render. Aquí viven el modelo, las APIs y la interfaz móvil.
2. **Aplicación Android APK** en `android/`. Es una app Android real que abre la interfaz segura del servicio Render dentro de una pantalla WebView.

Esto permite mejorar la interfaz y el motor en Render sin tener que reinstalar la APK para cada cambio visual. Cuando agreguemos funciones nativas (notificaciones, favoritos locales, widgets, compartir, etc.) podremos actualizar la APK.

## Proveedores
- football-data.org: partidos, resultados y forma reciente.
- The Odds API: cuotas pre-partido.

## Variables de Render
- `FOOTBALL_DATA_KEY`
- `ODDS_API_KEY`

No pongas las claves en GitHub ni las compartas por chat.

## Web
```bash
npm install
npm start
```

## Android
La APK se construye automáticamente mediante GitHub Actions al hacer push a `main`, o manualmente desde la pestaña Actions con `Build Android APK`.

El archivo generado es:
`android/app/build/outputs/apk/debug/app-debug.apk`

## Importante
La APK apunta al servicio Render en:
`https://mi-pronostico-deportivo.onrender.com/`

Si la URL de Render cambia, edita `APP_URL` en `android/app/src/main/java/com/mipronosticodeportivo/MainActivity.java`.

Las probabilidades son estimaciones estadísticas, no garantías.

Football data provided by the Football-Data.org API.
