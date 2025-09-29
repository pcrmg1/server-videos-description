const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración para limitar concurrencia y memoria
const MAX_CONCURRENT_REQUESTS = 2; // Máximo 2 videos procesándose simultáneamente
let currentProcessing = 0;

// Sistema de cola mejorado
class ProcessingQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  add(videoId, res) {
    this.queue.push({ videoId, res, timestamp: Date.now() });
    console.log(`📋 Video ${videoId} agregado a la cola. Posición: ${this.queue.length}`);
    this.processNext();
  }

  async processNext() {
    if (this.processing || this.queue.length === 0 || currentProcessing >= MAX_CONCURRENT_REQUESTS) {
      return;
    }

    this.processing = true;
    const { videoId, res } = this.queue.shift();
    
    console.log(`🎬 Procesando video de la cola: ${videoId} (${this.queue.length} restantes)`);
    
    try {
      currentProcessing++;
      await this.processVideo(videoId, res);
    } catch (error) {
      console.error(`❌ Error procesando video de la cola ${videoId}:`, error.message);
      res.status(500).json({
        error: `Error procesando video: ${error.message}`
      });
    } finally {
      currentProcessing--;
      this.processing = false;
      // Procesar siguiente video en la cola
      setTimeout(() => this.processNext(), 1000);
    }
  }

  async processVideo(videoId, res) {
    // Verificar si ya existe en la base de datos
    const existingVideo = await getVideoFromDB(videoId);

    if (existingVideo) {
      console.log(`✅ Video encontrado en cache: ${videoId}`);
      let parsedDescription = existingVideo.description;
      try {
        parsedDescription = JSON.parse(existingVideo.description);
      } catch (e) {
        console.warn('Description no es JSON válido, manteniendo como string');
      }

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

    let filePath;
    try {
      filePath = await downloadVideoFromDrive(videoId);
      console.log(`📥 Video descargado: ${filePath}`);
    } catch (downloadError) {
      console.error(`❌ Error descargando video ${videoId}:`, downloadError.message);
      throw downloadError;
    }

    let description;
    let tokenUsage;
    let modelUsed;
    
    try {
      console.log(`🤖 Iniciando análisis con Gemini para ${videoId}...`);
      const result = await getVideoDescription(filePath);
      description = result.description;
      tokenUsage = result.tokenUsage;
      modelUsed = result.modelUsed;
      console.log(`✅ Descripción obtenida para ${videoId}`);
      console.log(`🔧 Modelo utilizado: ${modelUsed}`);
      console.log(`📊 Tokens utilizados:`, tokenUsage);
    } catch (analysisError) {
      console.error(`❌ Error analizando video ${videoId}:`, analysisError.message);
      throw analysisError;
    } finally {
      if (filePath) {
        cleanupTempFile(filePath);
      }
    }

    try {
      await insertVideo(videoId, description, tokenUsage);
      console.log(`💾 Video guardado en BD: ${videoId}`);
    } catch (dbError) {
      console.error(`❌ Error guardando en BD ${videoId}:`, dbError.message);
      throw dbError;
    }

    console.log(`🎉 Procesamiento completado exitosamente: ${videoId}`);
    
    res.json({
      drive_id: videoId,
      description: description,
      cached: false,
      modelUsed: modelUsed,
      tokenUsage: tokenUsage
    });
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      processing: this.processing,
      currentProcessing: currentProcessing,
      maxConcurrent: MAX_CONCURRENT_REQUESTS
    };
  }
}

const processingQueue = new ProcessingQueue();

// Middleware
app.use(express.json());

// Middleware para limitar concurrencia
const concurrencyLimiter = (req, res, next) => {
  if (req.path === '/' && req.method === 'POST') {
    if (currentProcessing >= MAX_CONCURRENT_REQUESTS) {
      // En lugar de rechazar, agregar a la cola
      const { videoId } = req.body;
      if (!videoId) {
        return res.status(400).json({
          error: 'El campo videoId es requerido'
        });
      }
      
      console.log(`🔄 Servidor ocupado, agregando video ${videoId} a la cola`);
      processingQueue.add(videoId, res);
      return; // No llamar next(), la respuesta se manejará desde la cola
    }
  }
  next();
};

app.use(concurrencyLimiter);

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
    // Verificar tamaño del archivo antes de procesarlo
    const stats = fs.statSync(filePath);
    const fileSizeInMB = stats.size / (1024 * 1024);
    
    console.log(`Tamaño del archivo: ${fileSizeInMB.toFixed(2)} MB`);
    
    // Limitar tamaño de archivo para evitar problemas de memoria
    if (fileSizeInMB > 50) {
      throw new Error(`Archivo demasiado grande (${fileSizeInMB.toFixed(2)} MB). Máximo permitido: 50 MB`);
    }

    // Configuración de modelos con límites de tamaño
    const modelConfigs = [
      { 
        name: "gemini-2.5-flash", 
        maxSizeMB: 150,
        description: "Modelo rápido y eficiente"
      },
      { 
        name: "gemini-2.5-pro", 
        maxSizeMB: 30,
        description: "Modelo de alta calidad"
      }
    ];


    // Filtrar modelos según el tamaño del archivo
    const availableModels = modelConfigs.filter(config => fileSizeInMB <= config.maxSizeMB);
    
    if (availableModels.length === 0) {
      throw new Error(`Archivo demasiado grande para todos los modelos disponibles (${fileSizeInMB.toFixed(2)} MB)`);
    }

    console.log(`Modelos disponibles para archivo de ${fileSizeInMB.toFixed(2)} MB:`, 
      availableModels.map(m => m.name).join(', '));

    // Función para intentar análisis con reintentos
    const attemptAnalysis = async (modelConfig, retryCount = 0) => {
      const maxRetries = 3;
      const baseDelay = 2000; // 2 segundos
      
      try {
        console.log(`🤖 Intentando análisis con ${modelConfig.name} (intento ${retryCount + 1}/${maxRetries + 1})`);
        
        const model = genAI.getGenerativeModel({ model: modelConfig.name });
        
        // Configurar timeout más corto para detectar problemas rápidamente
        const analysisPromise = model.generateContent([
          prompt,
          {
            inlineData: {
              data: videoBuffer.toString('base64'),
              mimeType: mimeType
            }
          }
        ]);
        
        // Timeout de 3 minutos para el análisis
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timeout: El análisis tomó demasiado tiempo')), 3 * 60 * 1000);
        });
        
        const result = await Promise.race([analysisPromise, timeoutPromise]);
        console.log(`✅ Análisis completado con ${modelConfig.name}`);
        
        return {
          result,
          modelUsed: modelConfig.name
        };
        
      } catch (error) {
        console.error(`❌ Error con ${modelConfig.name} (intento ${retryCount + 1}):`, error.message);
        
        // Verificar si es un error recuperable
        const isRecoverableError = 
          error.message.includes('500') || 
          error.message.includes('Internal Server Error') ||
          error.message.includes('503') ||
          error.message.includes('502') ||
          error.message.includes('timeout') ||
          error.message.includes('network') ||
          error.message.includes('ECONNRESET') ||
          error.message.includes('ETIMEDOUT');
        
        if (isRecoverableError && retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount); // Backoff exponencial
          console.log(`⏳ Reintentando en ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return attemptAnalysis(modelConfig, retryCount + 1);
        }
        
        throw error;
      }
    };

    // Leer el archivo como buffer con manejo de memoria optimizado
    let videoBuffer;
    try {
      videoBuffer = fs.readFileSync(filePath);
      console.log(`Buffer creado: ${(videoBuffer.length / (1024 * 1024)).toFixed(2)} MB`);
    } catch (readError) {
      throw new Error(`Error leyendo archivo: ${readError.message}`);
    }

    // Prompt optimizado para reducir carga de procesamiento
    const prompt = `Analiza este video y responde ÚNICAMENTE con JSON válido (sin markdown ni texto adicional):
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
    
    Usa false (booleano) para campos vacíos. Transcribe texto y diálogo literalmente. Todas las descripciones en español.`;

    // Detectar el tipo MIME del archivo
    const fileExtension = path.extname(filePath).toLowerCase();
    let mimeType = 'video/mp4'; // Default

    switch (fileExtension) {
      case '.mp4':
        mimeType = 'video/mp4';
        break;
      case '.avi':
        mimeType = 'video/x-msvideo';
        break;
      case '.mov':
        mimeType = 'video/quicktime';
        break;
      case '.wmv':
        mimeType = 'video/x-ms-wmv';
        break;
      case '.webm':
        mimeType = 'video/webm';
        break;
      default:
        console.warn(`Extensión de archivo desconocida: ${fileExtension}, usando video/mp4`);
    }

    console.log(`Procesando video con MIME type: ${mimeType}`);

    // Intentar análisis con cada modelo disponible
    let result;
    let modelUsed;
    let lastError;
    
    for (const modelConfig of availableModels) {
      try {
        const analysisResult = await attemptAnalysis(modelConfig);
        result = analysisResult.result;
        modelUsed = analysisResult.modelUsed;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`❌ Modelo ${modelConfig.name} falló definitivamente:`, error.message);
        continue;
      }
    }
    
    if (!result) {
      throw new Error(`Todos los modelos fallaron. Último error: ${lastError?.message || 'Error desconocido'}`);
    }
    
    // Liberar memoria del buffer inmediatamente después del uso
    videoBuffer = null;
    
    // Forzar garbage collection si está disponible
    if (global.gc) {
      global.gc();
      console.log('Garbage collection ejecutado');
    }

    const response = await result.response;

    // Obtener información de uso de tokens
    const usageMetadata = response.usageMetadata;
    let description = response.text().trim();

    // Limpiar la respuesta para asegurar que sea JSON válido
    // Remover posibles markdown code blocks
    description = description.replace(/```json\n?/g, '').replace(/```\n?/g, '');

    // Remover espacios en blanco al inicio y final
    description = description.trim();

    // Validar que sea JSON válido
    try {
      const parsedDescription = JSON.parse(description);
      // Si el parsing es exitoso, usar el objeto parseado
      description = parsedDescription;
    } catch (jsonError) {
      console.error('Error parseando JSON de Gemini:', jsonError.message);
      console.error('Respuesta recibida:', description);

      // Intentar limpiar caracteres problemáticos
      try {
        // Remover caracteres de control y espacios extra
        const cleanedDescription = description
          .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // Remover caracteres de control
          .replace(/\n\s*\n/g, '\n') // Remover líneas vacías múltiples
          .trim();

        const parsedDescription = JSON.parse(cleanedDescription);
        description = parsedDescription;
        console.log('JSON parseado exitosamente después de limpieza');
      } catch (secondError) {
        console.error('Error en segundo intento de parsing:', secondError.message);

        // Como último recurso, crear un objeto con la respuesta como string
        description = {
          error: 'JSON parsing failed',
          raw_response: description,
          parsed_at: new Date().toISOString()
        };
        console.log('Usando respuesta raw como fallback');
      }
    }

    return {
      description,
      modelUsed,
      tokenUsage: {
        promptTokens: usageMetadata?.promptTokenCount || 0,
        candidatesTokens: usageMetadata?.candidatesTokenCount || 0,
        totalTokens: usageMetadata?.totalTokenCount || 0
      }
    };
  } catch (error) {
    console.error('Error obteniendo descripción:', error.message);

    // Proporcionar información más detallada del error
    if (error.message.includes('500') || error.message.includes('Internal Server Error')) {
      throw new Error(`Servidor de Google Gemini temporalmente no disponible. Intenta nuevamente en unos minutos. Error: ${error.message}`);
    } else if (error.message.includes('503') || error.message.includes('Service Unavailable')) {
      throw new Error(`Servicio de Gemini sobrecargado. Intenta nuevamente más tarde. Error: ${error.message}`);
    } else if (error.message.includes('404') || error.message.includes('not found')) {
      throw new Error(`Modelo de Gemini no disponible. Verifica tu API key. Error: ${error.message}`);
    } else if (error.message.includes('403') || error.message.includes('permission')) {
      throw new Error(`Sin permisos para usar Gemini AI. Verifica tu API key. Error: ${error.message}`);
    } else if (error.message.includes('429') || error.message.includes('quota') || error.message.includes('limit')) {
      throw new Error(`Límite de cuota excedido en Gemini AI. Espera antes de reintentar. Error: ${error.message}`);
    } else {
      throw new Error(`No se pudo obtener la descripción: ${error.message}`);
    }
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

  console.log(`🎬 Iniciando procesamiento de video: ${videoId} (${currentProcessing}/${MAX_CONCURRENT_REQUESTS})`);

  // Si hay capacidad, procesar directamente
  if (currentProcessing < MAX_CONCURRENT_REQUESTS) {
    currentProcessing++;
    
    // Decrementar contador cuando termine la request
    const originalEnd = res.end;
    res.end = function(...args) {
      currentProcessing--;
      // Procesar siguiente en cola si hay
      setTimeout(() => processingQueue.processNext(), 1000);
      originalEnd.apply(this, args);
    };
    
    // Procesar directamente
    return await processingQueue.processVideo(videoId, res);
  } else {
    // Agregar a la cola
    console.log(`🔄 Servidor ocupado, agregando video ${videoId} a la cola`);
    return processingQueue.add(videoId, res);
  }
});

// Ruta para obtener estado de la cola
app.get('/queue-status', (req, res) => {
  res.json({
    ...processingQueue.getStatus(),
    timestamp: new Date().toISOString()
  });
});

// Ruta original simplificada (mantenida para compatibilidad)
app.post('/process-direct', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({
      error: 'El campo videoId es requerido'
    });
  }

  console.log(`🎬 Procesamiento directo de video: ${videoId}`);

  try {
    await processingQueue.processVideo(videoId, res);
  } catch (error) {
    console.error(`💥 Error procesando video ${videoId}:`, error.message);
    console.error('Stack trace:', error.stack);
    
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
    processing: {
      current: currentProcessing,
      max: MAX_CONCURRENT_REQUESTS,
      available: MAX_CONCURRENT_REQUESTS - currentProcessing,
      queue: processingQueue.getStatus()
    },
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      external: Math.round(process.memoryUsage().external / 1024 / 1024),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
    },
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
  console.log(`⚡ Concurrencia máxima: ${MAX_CONCURRENT_REQUESTS} videos simultáneos`);
  console.log(`📋 Sistema de cola implementado para manejar sobrecarga`);
  console.log(`📊 Base de datos SQLite inicializada`);
  console.log(`🔧 Google Drive API: ${drive ? 'Configurada ✅' : 'No configurada ❌'}`);
  console.log(`🤖 Gemini AI: ${genAI ? 'Configurada ✅' : 'No configurada ❌'}`);
  console.log(`📁 Directorio temporal: ${tmpDir}`);
  console.log(`💾 Memoria inicial: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
  
  // Habilitar garbage collection manual si está disponible
  if (global.gc) {
    console.log(`🗑️ Garbage collection manual habilitado`);
  } else {
    console.log(`⚠️ Para mejor rendimiento, ejecuta con: node --expose-gc server.js`);
  }
});

// Manejo graceful del cierre
process.on('SIGINT', () => {
  console.log('\n🔄 Cerrando servidor...');
  console.log(`📊 Videos en procesamiento al cerrar: ${currentProcessing}`);
  console.log(`📋 Videos en cola al cerrar: ${processingQueue.getStatus().queueLength}`);
  db.close();
  console.log('✅ Base de datos cerrada');
  process.exit(0);
});

// Monitoreo de memoria cada 30 segundos
setInterval(() => {
  const memUsage = process.memoryUsage();
  const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const memTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
  
  if (memUsedMB > 200) { // Solo mostrar si usa más de 200MB
    console.log(`📊 Memoria: ${memUsedMB}/${memTotalMB} MB | Procesando: ${currentProcessing}/${MAX_CONCURRENT_REQUESTS}`);
  }
  
  // Si la memoria supera 1GB, forzar garbage collection
  if (memUsedMB > 1024 && global.gc) {
    console.log('🗑️ Ejecutando garbage collection por alto uso de memoria');
    global.gc();
  }
}, 60000); // Cada minuto en lugar de cada 30 segundos