# dismiss-secrets-pilot-poc

## Reporte de alertas de Secret Scanning

El workflow `Secret Scanning Alert Report` se ejecuta con cada push y genera un reporte JSON de las alertas abiertas del repositorio. El reporte incluye metadatos y ubicaciones, pero no los valores de los secretos. Se publica como artifact de GitHub Actions y se conserva durante 7 días.

### Configuración

1. Crea un token fine-grained limitado a este repositorio y con permiso **Secret scanning alerts: Read-only**.
2. En **Settings → Secrets and variables → Actions**, crea el secret `SECRET_SCANNING_READ_TOKEN` y guarda allí el token. No lo añadas a archivos del repositorio ni lo compartas en el chat.
3. Haz un push para ejecutar el workflow.

### Uso del agente

Descarga `secret-scanning-alerts.json` desde el artifact de la ejecución en **Actions** y colócalo en el workspace para que `dismiss-secrets-agent` lo analice cuando lo invoques. El agente solo recomienda una clasificación; no cambia el estado de las alertas.