# Video Analyzer - Servidor Node.js con Express

Servidor Node.js que analiza videos de Google Drive usando Gemini AI y mantiene un cache en SQLite.

## 🚀 Características

- **Análisis de videos**: Descarga videos de Google Drive y los analiza con Gemini AI
- **Cache inteligente**: Usa SQLite para evitar re-procesar videos ya analizados
- **API REST completa**: CRUD completo para gestionar descripciones de videos
- **Gestión de archivos**: Descarga temporal y limpieza automática
- **Manejo de errores**: Respuestas HTTP claras y logging detallado

## 📋 Prerequisitos

1. **Node.js** (versión 18 o superior)
2. **Cuenta de Google Cloud** con:
   - Google Drive API habilitada
   - Cuenta de servicio creada
   - Archivo JSON de credenciales descargado
3. **API Key de Gemini** desde [Google AI Studio](https://makersuite.google.com/app/apikey)

## 🛠️ Instalación

### Paso 1: Clonar y configurar el proyecto

```bash
# Instalar dependencias
npm install

# Copiar archivo de variables de entorno
cp .env.example .env
```

### Paso 2: Configurar Google Cloud (cuenta de servicio)

1. Ve a [Google Cloud Console](https://console.cloud.google.com/)
2. Crea un nuevo proyecto o selecciona uno existente
3. Habilita la **Google Drive API**
4. Ve a **IAM y administración** > **Cuentas de servicio**
5. Crea una nueva cuenta de servicio
6. Descarga el archivo JSON de credenciales
7. **IMPORTANTE**: Serializa el JSON completo como string para el .env

### Paso 3: Obtener API Key de Gemini

1. Ve a [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Crea una nueva API Key
3. Cópiala para usar en el archivo .env

### Paso 4: Configurar variables de entorno

Edita el archivo `.env` con tus credenciales reales:

```env
PORT=3000
GEMINI_API_KEY=tu_gemini_api_key_real
GOOGLE_SERVICE_ACCOUNT={"type":"service_account",...todo_el_json_serializado...}
```

**Tip**: Para serializar el JSON de Google Service Account:
```bash
# En terminal, reemplaza el contenido entre comillas:
echo '{"type":"service_account",...}' | tr -d '\n' > temp.json
cat temp.json
```

### Paso 5: Dar permisos a la cuenta de servicio

Para que la cuenta de servicio pueda acceder a videos en Google Drive:
1. Abre Google Drive
2. Comparte la carpeta/archivos con el email de la cuenta de servicio
3. O haz los archivos públicos con enlace compartido

## 🚀 Ejecución

```bash
# Iniciar el servidor
npm start

# Para desarrollo (con auto-reload)
npm run dev
```

El servidor estará disponible en `http://localhost:3000`

## 📡 API Endpoints

### POST / - Procesar video
Analiza un video de Google Drive (con cache)

```bash
curl -X POST http://localhost:3000/ \
  -H "Content-Type: application/json" \
  -d '{"videoId": "1AbCdEfGhIjKlMnOp"}'
```

**Respuesta exitosa:**
```json
{
  "drive_id": "1AbCdEfGhIjKlMnOp",
  "description": "Video muestra una persona caminando por la playa...",
  "cached": false
}
```

### GET /videos - Listar todos los videos
```bash
curl http://localhost:3000/videos
```

### GET /videos/:driveId - Obtener un video específico
```bash
curl http://localhost:3000/videos/1AbCdEfGhIjKlMnOp
```

### PUT /videos/:driveId - Actualizar descripción
```bash
curl -X PUT http://localhost:3000/videos/1AbCdEfGhIjKlMnOp \
  -H "Content-Type: application/json" \
  -d '{"description": "Nueva descripción actualizada"}'
```

### DELETE /videos/:driveId - Eliminar registro
```bash
curl -X DELETE http://localhost:3000/videos/1AbCdEfGhIjKlMnOp
```

### GET /health - Estado del servidor
```bash
curl http://localhost:3000/health
```

## 📊 Base de Datos

SQLite automáticamente crea el archivo `videos.db` con la tabla:

```sql
CREATE TABLE videos (
  drive_id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 🔧 Estructura del Proyecto

```
/
├── server.js          # Servidor principal
├── package.json       # Dependencias y scripts
├── .env              # Variables de entorno (no incluir en git)
├── .env.example      # Plantilla de variables de entorno
├── README.md         # Este archivo
└── videos.db         # Base de datos SQLite (generada automáticamente)
```

## 🔍 Troubleshooting

### Error: "Google Drive API no está configurada"
- Verifica que el JSON de la cuenta de servicio esté bien serializado en `.env`
- Asegúrate de que la Google Drive API esté habilitada en tu proyecto

### Error: "No se pudo descargar el video"
- Verifica que el video ID sea correcto
- Asegúrate de que la cuenta de servicio tenga acceso al archivo
- El archivo debe ser un video compatible

### Error: "Gemini AI no está configurada"
- Verifica tu API Key de Gemini en el archivo `.env`
- Confirma que tengas acceso a la API de Gemini

### Error de permisos en /tmp
- En sistemas Unix, asegúrate de tener permisos de escritura en `/tmp`
- El servidor crea automáticamente el directorio si no existe

## 🔒 Seguridad

- **Nunca** commits el archivo `.env` al repositorio
- Mantén tus credenciales seguras
- La cuenta de servicio debe tener permisos mínimos necesarios
- Los archivos temporales se eliminan automáticamente

## 🐳 Notas Adicionales

- Los videos se descargan temporalmente en `/tmp` y se eliminan tras el procesamiento
- El cache evita reprocesar videos ya analizados
- Todas las respuestas incluyen manejo de errores apropiado
- El servidor incluye logging detallado para debugging

## 📝 Licencia

ISC License - Ver archivo de licencia para más detalles.