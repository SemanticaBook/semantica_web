# Semantica Web

Frontend de Semantica para convertir PDFs a EPUB y Markdown. Vite publica la aplicación en GitHub Pages; el análisis con Laya corre localmente en el navegador.

## GitHub Pages

En **Settings → Pages**, selecciona **GitHub Actions** como fuente. El workflow `Deploy Vite to GitHub Pages` construye y publica `dist/`. El modelo ONNX no forma parte de ese artefacto ni del repositorio web.

La acción `Build and publish Laya browser model` es manual y prepara el modelo multilingüe oficial para ONNX Runtime Web, después lo publica en un repositorio público de Hugging Face separado. Configura el secreto de Actions `HF_TOKEN` con un token Hugging Face con acceso de escritura. Por defecto, el destino es `SemanticaBook/semantica-laya-multilingual-onnx`; puedes cambiarlo con la variable Actions `LAYA_MODEL_REPO`. Como respaldo versionado, la web también lee desde `https://raw.githubusercontent.com/SemanticaBook/laya-weights/main/`; ese repositorio debe estar publicado y ser público.

El deploy verifica que al menos una fuente sirva el manifiesto sin credenciales. Si ambas fallan, publica el respaldo de GitHub y, si corresponde, revisa el log de `Build and publish Laya browser model`. No pongas un token de Hugging Face en la configuración `VITE_*`: ese valor acabaría expuesto en el JavaScript público.

Por defecto el core descarga el modelo desde:

```text
https://huggingface.co/SemanticaBook/semantica-laya-multilingual-onnx/resolve/main/
```

Para otro origen, define `VITE_LAYA_MODEL_BASE_URL` en las variables de Actions. El hosting del modelo debe ser público, servir los nombres de archivo del manifiesto y permitir solicitudes CORS desde la web. Si cambias la URL, su manifiesto y pesos deben publicarse juntos.

La acción de publicación usa CPU/almacenamiento de GitHub Actions para transformar y cuantizar el checkpoint `safetensors` de ConvAI Innovations en ONNX. Esa exportación pesada no se ejecuta en el cliente. Al pulsar **Cargar modelo**, el navegador descarga los pesos ONNX preparados, verifica cada fragmento, los guarda en Cache Storage e inicia la inferencia local; el PDF y el texto procesado permanecen en el dispositivo.

## Desarrollo

```bash
npm ci
npm run dev
npm run build
```

Para usar en desarrollo un host de modelo diferente, define `VITE_LAYA_MODEL_BASE_URL` en el entorno de Vite. La variable se incorpora al build y debe contener una URL base terminada opcionalmente en `/`.
