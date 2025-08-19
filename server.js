const express = require('express');
const sqlite3 = require('sqlite3').verbose();
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
const db = new sqlite3.Database('videos.db');

// Crear tabla si no existe
db.serialize(() => {
  db.run(`
  CREATE TABLE IF NOT EXISTS videos (
    drive_id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    token_usage TEXT
  )
  `);

  // Agregar columna token_usage si no existe (para bases de datos existentes)
  db.run(`
    ALTER TABLE videos ADD COLUMN token_usage TEXT
  `, (err) => {
    // Ignorar error si la columna ya existe
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error agregando columna token_usage:', err.message);
    }
  });
});

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

// Funciones de base de datos con promesas
const getVideoFromDB = (driveId) => {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM videos WHERE drive_id = ?', [driveId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const insertVideo = (driveId, description, tokenUsage = null) => {
  return new Promise((resolve, reject) => {
    const tokenUsageJson = tokenUsage ? JSON.stringify(tokenUsage) : null;
    // Si description es un objeto, convertirlo a JSON string para almacenar
    const descriptionJson = typeof description === 'object' ? JSON.stringify(description) : description;
    db.run('INSERT INTO videos (drive_id, description, token_usage) VALUES (?, ?, ?)', [driveId, descriptionJson, tokenUsageJson], function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const getAllVideos = () => {
  return new Promise((resolve, reject) => {
    db.all('SELECT * FROM videos ORDER BY created_at DESC', [], (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const updateVideo = (description, driveId) => {
  return new Promise((resolve, reject) => {
    // Si description es un objeto, convertirlo a JSON string para almacenar
    const descriptionJson = typeof description === 'object' ? JSON.stringify(description) : description;
    db.run('UPDATE videos SET description = ? WHERE drive_id = ?', [descriptionJson, driveId], function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes });
    });
  });
};

const deleteVideo = (driveId) => {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM videos WHERE drive_id = ?', [driveId], function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes });
    });
  });
};

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

    const prompt = `Analiza este video y proporciona una respuesta en formato JSON con la siguiente estructura exacta:
    {
      "texto_visible": "transcripción COMPLETA y DETALLADA de TODO el texto visible, incluyendo títulos, subtítulos, frases, números, palabras clave, etc. Separa cada elemento de texto con saltos de línea y mantén el orden de aparición" o false si no hay texto,
      "musica_fondo": "descripción de la música y género" o false si no hay música,
      "objetos_presentes": "descripción de objetos visibles" o false si no hay objetos relevantes,
      "personas": "descripción general de personas" o false si no hay personas,
      "acciones": "descripción de acciones realizadas" o false si no hay acciones,
      "colores_predominantes": "descripción de colores principales" (siempre debe tener valor),
      "ambiente_contexto": "descripción del ambiente y contexto" (siempre debe tener valor),
      "dialogo_narracion": "transcripción LITERAL y COMPLETA de todo lo que se dice en el video, palabra por palabra, tal como se pronuncia. Incluye pausas naturales, muletillas, repeticiones y el diálogo exacto sin resumir ni parafrasear" o false si no hay audio/diálogo,
      "duracion_segundos": número entero con la duración aproximada del video en segundos,
      "duracion_formato": "formato legible de la duración (ej: '2:30', '1:15:45')"
    }
    
    IMPORTANTE: 
    - Responde ÚNICAMENTE con el JSON válido, sin texto adicional
    - Usa false (booleano) cuando no detectes algo, NO strings como "No se detecta"
    - Para texto_visible: Lee y transcribe TODO el texto que aparezca en pantalla, palabra por palabra, manteniendo el formato y orden original
    - Si hay listas numeradas, mantén la numeración exacta
    - Si hay títulos o subtítulos, especifica cuáles son
    - No resumas el texto, transcríbelo completamente
    - Para dialogo_narracion: Transcribe LITERALMENTE todo lo que se dice, palabra por palabra, tal como se pronuncia. NO resumas, NO parafrasees, NO interpretes. Incluye muletillas como "eh", "mm", "este", pausas naturales, repeticiones, etc.
    - Los campos colores_predominantes, ambiente_contexto, duracion_segundos y duracion_formato siempre deben tener valor
    - Para la duración, analiza todo el contenido del video y proporciona una estimación precisa
    - El formato de duración debe ser MM:SS para videos menores a 1 hora, o HH:MM:SS para videos de 1 hora o más
    - Todas las descripciones deben ser en español`;

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

    // Obtener información de uso de tokens
    const usageMetadata = response.usageMetadata;
    let description = response.text().trim();

    // Limpiar la respuesta para asegurar que sea JSON válido
    // Remover posibles markdown code blocks
    description = description.replace(/```json\n?/g, '').replace(/```\n?/g, '');

    // Validar que sea JSON válido
    try {
      const parsedDescription = JSON.parse(description);
      // Si el parsing es exitoso, usar el objeto parseado
      description = parsedDescription;
    } catch (jsonError) {
      console.error('Error: Gemini no devolvió JSON válido:', description);
      throw new Error('La respuesta de Gemini no es un JSON válido');
    }

    return {
      description,
      tokenUsage: {
        promptTokens: usageMetadata?.promptTokenCount || 0,
        candidatesTokens: usageMetadata?.candidatesTokenCount || 0,
        totalTokens: usageMetadata?.totalTokenCount || 0
      }
    };
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
    const existingVideo = await getVideoFromDB(videoId);

    if (existingVideo) {
      // Parsear description si es un JSON string
      let parsedDescription = existingVideo.description;
      try {
        parsedDescription = JSON.parse(existingVideo.description);
      } catch (e) {
        // Si no es JSON válido, mantener como string
        console.warn('Description no es JSON válido, manteniendo como string');
      }

      // Parsear token usage si existe
      let tokenUsage = null;
      if (existingVideo.token_usage) {
        try {
          tokenUsage = JSON.parse(existingVideo.token_usage);
        } catch (e) {
          console.warn('Error parseando token_usage:', e.message);
        }
      }

      return res.json({
        drive_id: existingVideo.drive_id,
        description: parsedDescription,
        cached: true,
        tokenUsage: tokenUsage
      });
    }

    // Si no existe, procesar el video
    console.log(`Procesando video nuevo: ${videoId}`);

    // Descargar video de Google Drive
    const filePath = await downloadVideoFromDrive(videoId);
    console.log(`Video descargado: ${filePath}`);

    let description;
    let tokenUsage;
    try {
      // Obtener descripción con Gemini
      const result = await getVideoDescription(filePath);
      description = result.description;
      tokenUsage = result.tokenUsage;
      console.log(`Descripción obtenida para ${videoId}`);
      console.log(`Tokens utilizados:`, tokenUsage);
    } finally {
      // Siempre eliminar el archivo temporal
      cleanupTempFile(filePath);
    }

    // Guardar en base de datos
    await insertVideo(videoId, description, tokenUsage);
    console.log(`Video guardado en BD: ${videoId}`);

    res.json({
      drive_id: videoId,
      description: description,
      cached: false,
      tokenUsage: tokenUsage
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
app.get('/videos', async (req, res) => {
  try {
    const videos = await getAllVideos();

    // Parsear token usage para cada video
    const videosWithTokenUsage = videos.map(video => {
      // Parsear description si es un JSON string
      let parsedDescription = video.description;
      try {
        parsedDescription = JSON.parse(video.description);
      } catch (e) {
        // Si no es JSON válido, mantener como string
        console.warn(`Description del video ${video.drive_id} no es JSON válido, manteniendo como string`);
      }

      let tokenUsage = null;
      if (video.token_usage) {
        try {
          tokenUsage = JSON.parse(video.token_usage);
        } catch (e) {
          console.warn(`Error parseando token_usage para video ${video.drive_id}:`, e.message);
        }
      }

      return {
        ...video,
        description: parsedDescription,
        tokenUsage: tokenUsage,
        token_usage: undefined // Remover el campo raw
      };
    });

    res.json({
      count: videosWithTokenUsage.length,
      videos: videosWithTokenUsage
    });
  } catch (error) {
    console.error('Error obteniendo videos:', error.message);
    res.status(500).json({
      error: `Error obteniendo videos: ${error.message}`
    });
  }
});

// GET /videos/:driveId - Obtener un video específico
app.get('/videos/:driveId', async (req, res) => {
  const { driveId } = req.params;

  try {
    const video = await getVideoFromDB(driveId);

    if (!video) {
      return res.status(404).json({
        error: 'Video no encontrado'
      });
    }

    // Parsear description si es un JSON string
    let parsedDescription = video.description;
    try {
      parsedDescription = JSON.parse(video.description);
    } catch (e) {
      // Si no es JSON válido, mantener como string
      console.warn('Description no es JSON válido, manteniendo como string');
    }

    // Parsear token usage si existe
    let tokenUsage = null;
    if (video.token_usage) {
      try {
        tokenUsage = JSON.parse(video.token_usage);
      } catch (e) {
        console.warn('Error parseando token_usage:', e.message);
      }
    }

    res.json({
      ...video,
      description: parsedDescription,
      tokenUsage: tokenUsage,
      token_usage: undefined // Remover el campo raw
    });
  } catch (error) {
    console.error('Error obteniendo video:', error.message);
    res.status(500).json({
      error: `Error obteniendo video: ${error.message}`
    });
  }
});

// PUT /videos/:driveId - Actualizar descripción de un video
app.put('/videos/:driveId', async (req, res) => {
  const { driveId } = req.params;
  const { description } = req.body;

  if (!description) {
    return res.status(400).json({
      error: 'El campo description es requerido'
    });
  }

  try {
    const result = await updateVideo(description, driveId);

    if (result.changes === 0) {
      return res.status(404).json({
        error: 'Video no encontrado'
      });
    }

    // Obtener el video actualizado
    const updatedVideo = await getVideoFromDB(driveId);
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
app.delete('/videos/:driveId', async (req, res) => {
  const { driveId } = req.params;

  try {
    const result = await deleteVideo(driveId);

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