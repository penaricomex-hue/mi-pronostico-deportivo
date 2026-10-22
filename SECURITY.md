# Seguridad

## Reportar un problema

Si encuentras una vulnerabilidad, no abras un issue público. Escribe al propietario del repositorio.

## Medidas aplicadas

**Servidor**
- Inicio de sesión obligatorio (Basic Auth) en producción. Sin `APP_USERNAME`/`APP_PASSWORD` la app responde 503: falla cerrada, nunca abierta. Es una sola clave compartida, no hay cuentas ni registro.
- Comparación de credenciales en tiempo constante.
- Bloqueo temporal de la IP tras 10 intentos fallidos en 15 minutos. La contraseña correcta levanta ese bloqueo. Si hay PostgreSQL, el conteo se guarda y sigue vigente aunque Render duerma el proceso.
- Las peticiones que modifican datos exigen la cabecera `X-MK-Request` (la propia app la envía; un formulario de otro sitio no puede).
- Límite de peticiones por IP a la API (`API_RATE_LIMIT_PER_MINUTE`, 120 por defecto).
- Cabeceras: Content-Security-Policy estricta, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, sin `X-Powered-By`.
- No se sirve código fuente ni archivos ocultos; solo el frontend compilado (`dist/`).
- Errores internos sin trazas ni mensaje de base de datos hacia el cliente.
- Cuerpo JSON limitado a 100 KB.
- Las claves de API solo viven en variables de entorno del servidor; el navegador nunca las recibe.
- Conexión a PostgreSQL con verificación del certificado. `DATABASE_SSL_INSECURE=true` solo si el proveedor no lo permite.

**App Android**
- Solo HTTPS (`usesCleartextTraffic=false` y `network_security_config`), sin certificados instalados por el usuario.
- La WebView solo navega dentro del dominio de la app; otros enlaces se abren en el navegador.
- Sin acceso a archivos locales desde la WebView; Safe Browsing activado.
- La clave no se guarda hasta que la página carga. En la pantalla de error hay «Olvidar usuario».
- Sin copias de seguridad en la nube de credenciales ni datos de la app.

**Repositorio**
- El repositorio está **público**. No subas secretos. Conviene pasarlo a privado en GitHub → Settings → General → Danger zone.
- `.gitignore` bloquea `.env`, llaves y keystores. El zip de distribución antiguo no debe versionarse.
- CI: `npm audit` (falla con vulnerabilidades altas), búsqueda de secretos con Gitleaks en todo el historial y permisos mínimos del token (`contents: read`). También comprueba el historial de **Champions**, no solo el de las ligas apagadas.
- Dependabot: actualizaciones semanales de npm y mensuales de Actions y Gradle.
- La firma del APK usa secretos de GitHub Actions; el keystore nunca se guarda en el repositorio.
- El respaldo semanal de Neon se cifra con `BACKUP_PASSPHRASE` antes de subirse como artefacto. Sin esa frase el workflow se detiene y no publica el volcado.

## Recomendaciones para el propietario
1. Activa la verificación en dos pasos en GitHub y en Render.
2. Usa una contraseña larga y única para `APP_PASSWORD`.
3. Si una clave se expone, revócala en el proveedor y crea una nueva antes de nada.
4. Revisa cada Pull Request (incluidos los de Dependabot) antes de fusionarlo con `main`, porque `main` se despliega automáticamente.
