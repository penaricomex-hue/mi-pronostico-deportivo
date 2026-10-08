# Seguridad

## Reportar un problema

Si encuentras una vulnerabilidad, no abras un issue público. Escribe al propietario del repositorio.

## Medidas aplicadas

**Servidor**
- Inicio de sesión obligatorio (Basic Auth) en producción. Sin `APP_USERNAME`/`APP_PASSWORD` la app responde 503: falla cerrada, nunca abierta.
- Comparación de credenciales en tiempo constante.
- Bloqueo temporal de la IP tras 10 intentos fallidos en 15 minutos.
- Límite de peticiones por IP a la API (`API_RATE_LIMIT_PER_MINUTE`, 120 por defecto).
- Cabeceras: Content-Security-Policy estricta, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, sin `X-Powered-By`.
- No se sirve código fuente ni archivos ocultos; solo el frontend compilado (`dist/`).
- Errores internos sin trazas de pila hacia el cliente.
- Cuerpo JSON limitado a 100 KB.
- Las claves de API solo viven en variables de entorno del servidor; el navegador nunca las recibe.

**App Android**
- Solo HTTPS (`usesCleartextTraffic=false` y `network_security_config`), sin certificados instalados por el usuario.
- La WebView solo navega dentro del dominio de la app; otros enlaces se abren en el navegador.
- Sin acceso a archivos locales desde la WebView; Safe Browsing activado.
- Sin copias de seguridad en la nube de credenciales ni datos de la app.

**Repositorio**
- Repositorio privado.
- `.gitignore` bloquea `.env`, llaves y keystores.
- CI: `npm audit` (falla con vulnerabilidades altas), búsqueda de secretos con Gitleaks en todo el historial y permisos mínimos del token (`contents: read`).
- Dependabot: actualizaciones semanales de npm y mensuales de Actions y Gradle.
- La firma del APK usa secretos de GitHub Actions; el keystore nunca se guarda en el repositorio.

## Recomendaciones para el propietario
1. Activa la verificación en dos pasos en GitHub y en Render.
2. Usa una contraseña larga y única para `APP_PASSWORD`.
3. Si una clave se expone, revócala en el proveedor y crea una nueva antes de nada.
4. Revisa cada Pull Request (incluidos los de Dependabot) antes de fusionarlo con `main`, porque `main` se despliega automáticamente.
