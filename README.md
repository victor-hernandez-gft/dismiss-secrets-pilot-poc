# dismiss-secrets-pilot-poc

## Reporte y análisis de alertas de Secret Scanning

El workflow `Secret Scanning Alert Report` se ejecuta con cada push a `main` y también puede iniciarse manualmente desde **Actions → Secret Scanning Alert Report → Run workflow**. Genera un reporte Markdown y un JSON con la metadata de las alertas abiertas. Ninguno de los archivos incluye valores de secretos. El reporte se publica como artifact y se conserva durante 7 días.

### Configuración

1. Crea un token fine-grained limitado a este repositorio y con permiso **Secret scanning alerts: Read-only**.
2. En **Settings → Secrets and variables → Actions**, crea el secret `SECRET_SCANNING_READ_TOKEN` y guarda allí el token. No lo añadas a archivos del repositorio ni lo compartas en el chat.
3. Crea el secret `OPENAI_API_KEY` con una API key de OpenAI. No la añadas a archivos del repositorio ni la compartas en el chat.
4. Opcionalmente, en **Settings → Secrets and variables → Actions → Variables**, define `OPENAI_MODEL` con el modelo autorizado por tu organización. Si no la defines, se usa `gpt-4o-mini`.
5. Haz un push a `main` o inicia el workflow manualmente.

El workflow separa permisos por job: el primero lee alertas; el segundo envía a la API de OpenAI únicamente identificadores, tipo, estado, fechas y ubicaciones (sin valores de secretos); el tercero crea/reutiliza issues y publica el análisis. El job de análisis solo tiene permiso de lectura del contenido del repositorio y no puede escribir issues. El resultado estructurado se valida localmente antes de publicar.

Con el contenido disponible, la clasificación automática es `NO_DISMISS`: GitHub entrega metadata de tipo, estado, fechas y ubicación, pero esa metadata no prueba por sí sola si la credencial sigue activa, fue revocada, es ficticia o se usa exclusivamente en pruebas. El análisis recomienda verificar el estado con el propietario autorizado. No se solicita ni se envía a OpenAI el valor del secreto. Si la API falla o devuelve un resultado inválido, el job falla explícitamente y no se publica un comentario incompleto.

### Uso manual del agente

También puedes descargar `secret-scanning-alerts.md` desde el artifact y pedir a `dismiss-secrets-agent` que lo analice en Copilot Chat. Ese agente es para análisis manual; el análisis automático en Actions lo realiza OpenAI con las mismas reglas conservadoras.