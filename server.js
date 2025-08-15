const express = require('express');
const Database = require('better-sqlite3');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// Inicializar base de datos
const db = new Database('videos.db');

// Crear tabla si no existe
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    drive_id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Configurar Google Drive API
let drive;
try {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT || '{}');
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  drive = google.drive({ version: 'v3', auth });
} catch (error) {
  console.error('Error configurando Google Drive API:', error.message);
}

// Configurar Gemini AI
let genAI;
try {
  genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
} catch (error) {
  console.error('Error configurando Gemini AI:', error.message);
}

// Función para verificar si el archivo existe en la base de datos
const getVideoFromDB = db.prepare('SELECT * FROM videos WHERE drive_id = ?');
const insertVideo = db.prepare('INSERT INTO videos (drive_id, description) VALUES (?, ?)');
const getAllVideos = db.prepare('SELECT * FROM videos ORDER BY created_at DESC');
const updateVideo = db.prepare('UPDATE videos SET description = ? WHERE drive_id = ?');
const deleteVideo = db.prepare('DELETE FROM videos WHERE drive_id = ?');

// Función para descargar video de Google Drive
async function downloadVideoFromDrive(videoId) {
  if (!drive) {
    throw new Error('Google Drive API no está configurada correctamente');
  }

  try {
    // Obtener metadata del archivo
    const fileMetadata = await drive.files.get({
      fileId: videoId,
      fields: 'name, mimeType, size'
    });

    const fileName = fileMetadata.data.name || `video_${videoId}`;
    const filePath = path.join('/tmp', `${videoId}_${fileName}`);

    // Descargar el archivo
    const response = await drive.files.get({
      fileId: videoId,
      alt: 'media'
    }, { responseType: 'stream' });

    // Guardar el archivo
    return new Promise((resolve, reject) => {
      const dest = fs.createWriteStream(filePath);
      response.data
        .on('end', () => resolve(filePath))
        .on('error', reject)
        .pipe(dest);
    });
  } catch (error) {
    console.error('Error descargando video:', error.message);
    throw new Error(`No se pudo descargar el video: ${error.message}`);
  }
}

// Función para obtener descripción con Gemini
async function getVideoDescription(filePath) {
  if (!genAI) {
    throw new Error('Gemini AI no está configurada correctamente');
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
    // Leer el archivo como buffer
    const videoBuffer = fs.readFileSync(filePath);
    
    const prompt = `Analiza este video y proporciona una descripción detallada en español que incluya:
    - Texto visible en pantalla (si existe)
    - Música de fondo y su género (si existe)
    - Objetos presentes en el video
    - Personas que aparecen (descripción general, sin nombres específicos)
    - Acciones que se realizan
    - Colores predominantes
    - Ambiente y contexto general
    
    Proporciona una descripción completa y estructurada.`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: videoBuffer.toString('base64'),
          mimeType: 'video/mp4' // Asumiendo MP4, se puede detectar dinámicamente
        }
      }
    ]);

    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error('Error obteniendo descripción:', error.message);
    throw new Error(`No se pudo obtener la descripción: ${error.message}`);
  }
}

// Función para eliminar archivo temporal
function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Archivo temporal eliminado: ${filePath}`);
    }
  } catch (error) {
    console.error('Error eliminando archivo temporal:', error.message);
  }
}

// RUTA PRINCIPAL: POST / - Procesar video
app.post('/', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ 
      error: 'El campo videoId es requerido' 
    });
  }

  try {
    // Verificar si ya existe en la base de datos
    const existingVideo = getVideoFromDB.get(videoId);
    
    if (existingVideo) {
      return res.json({
        drive_id: existingVideo.drive_id,
        description: existingVideo.description,
        cached: true
      });
    }

    // Si no existe, procesar el video
    console.log(`Procesando video nuevo: ${videoId}`);
    
    // Descargar video de Google Drive
    const filePath = await downloadVideoFromDrive(videoId);
    console.log(`Video descargado: ${filePath}`);

    let description;
    try {
      // Obtener descripción con Gemini
      description = await getVideoDescription(filePath);
      console.log(`Descripción obtenida para ${videoId}`);
    } finally {
      // Siempre eliminar el archivo temporal
      cleanupTempFile(filePath);
    }

    // Guardar en base de datos
    insertVideo.run(videoId, description);
    console.log(`Video guardado en BD: ${videoId}`);

    res.json({
      drive_id: videoId,
      description: description,
      cached: false
    });

  } catch (error) {
    console.error('Error procesando video:', error.message);
    res.status(500).json({ 
      error: `Error procesando video: ${error.message}` 
    });
  }
});

// CRUD ENDPOINTS

// GET /videos - Obtener todos los videos
app.get('/videos', (req, res) => {
  try {
    const videos = getAllVideos.all();
    res.json({
      count: videos.length,
      videos: videos
    });
  } catch (error) {
    console.error('Error obteniendo videos:', error.message);
    res.status(500).json({ 
      error: `Error obteniendo videos: ${error.message}` 
    });
  }
});

// GET /videos/:driveId - Obtener un video específico
app.get('/videos/:driveId', (req, res) => {
  const { driveId } = req.params;

  try {
    const video = getVideoFromDB.get(driveId);
    
    if (!video) {
      return res.status(404).json({ 
        error: 'Video no encontrado' 
      });
    }

    res.json(video);
  } catch (error) {
    console.error('Error obteniendo video:', error.message);
    res.status(500).json({ 
      error: `Error obteniendo video: ${error.message}` 
    });
  }
});

// PUT /videos/:driveId - Actualizar descripción de un video
app.put('/videos/:driveId', (req, res) => {
  const { driveId } = req.params;
  const { description } = req.body;

  if (!description) {
    return res.status(400).json({ 
      error: 'El campo description es requerido' 
    });
  }

  try {
    const result = updateVideo.run(description, driveId);
    
    if (result.changes === 0) {
      return res.status(404).json({ 
        error: 'Video no encontrado' 
      });
    }

    // Obtener el video actualizado
    const updatedVideo = getVideoFromDB.get(driveId);
    res.json({
      message: 'Descripción actualizada exitosamente',
      video: updatedVideo
    });
  } catch (error) {
    console.error('Error actualizando video:', error.message);
    res.status(500).json({ 
      error: `Error actualizando video: ${error.message}` 
    });
  }
});

// DELETE /videos/:driveId - Eliminar un video
app.delete('/videos/:driveId', (req, res) => {
  const { driveId } = req.params;

  try {
    const result = deleteVideo.run(driveId);
    
    if (result.changes === 0) {
      return res.status(404).json({ 
        error: 'Video no encontrado' 
      });
    }

    res.json({ 
      message: 'Video eliminado exitosamente',
      drive_id: driveId
    });
  } catch (error) {
    console.error('Error eliminando video:', error.message);
    res.status(500).json({ 
      error: `Error eliminando video: ${error.message}` 
    });
  }
});

// Ruta de estado/salud
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    services: {
      database: 'Connected',
      googleDrive: drive ? 'Configured' : 'Not configured',
      geminiAI: genAI ? 'Configured' : 'Not configured'
    }
  });
});

// Middleware para rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Ruta no encontrada' 
  });
});

// Middleware global de manejo de errores
app.use((error, req, res, next) => {
  console.error('Error no manejado:', error);
  res.status(500).json({ 
    error: 'Error interno del servidor' 
  });
});

// Crear directorio tmp si no existe
const tmpDir = '/tmp';
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`📊 Base de datos SQLite inicializada`);
  console.log(`🔧 Google Drive API: ${drive ? 'Configurada ✅' : 'No configurada ❌'}`);
  console.log(`🤖 Gemini AI: ${genAI ? 'Configurada ✅' : 'No configurada ❌'}`);
  console.log(`📁 Directorio temporal: ${tmpDir}`);
});

// Manejo graceful del cierre
process.on('SIGINT', () => {
  console.log('\n🔄 Cerrando servidor...');
  db.close();
  console.log('✅ Base de datos cerrada');
  process.exit(0);
});