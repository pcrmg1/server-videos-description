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
const MAX_CONCURRENT_REQUESTS = 2;
const HTTP_TIMEOUT = 4.5 * 60 * 1000; // 4.5 minutos para dar margen
const ANALYSIS_TIMEOUT = 3 * 60 * 1000; // 3 minutos para análisis
let currentProcessing = 0;

// Sistema de cola mejorado con mejor manejo de concurrencia
class ProcessingQueue {
  constructor() {
    this.queue = [];
    this.processingIds = new Set(); // Track IDs being processed
    this.retryAttempts = new Map(); // Track retry attempts per video
    this.maxRetries = 2;
    
    // Procesar cola cada 2 segundos
    setInterval(() => this.processQueue(), 2000);
  }

  add(videoId, res) {
    // Verificar si ya está siendo procesado
    if (this.processingIds.has(videoId)) {
      console.log(`⚠️ Video ${videoId} ya está siendo procesado, rechazando duplicado`);
      return res.status(409).json({
        error: 'Video ya está siendo procesado',
        videoId: videoId
      });
    }

    // Verificar si ya está en la cola
    const existsInQueue = this.queue.some(item => item.videoId === videoId);
    if (existsInQueue) {
      console.log(`⚠️ Video ${videoId} ya está en la cola, rechazando duplicado`);
      return res.status(409).json({
        error: 'Video ya está en la cola',
        videoId: videoId
      });
    }

    // Configurar timeout para la respuesta HTTP
    const timeout = setTimeout(() => {
      console.log(`⏰ Timeout para video ${videoId} después de ${HTTP_TIMEOUT / 1000} segundos`);
      if (!res.headersSent) {
        res.status(408).json({
          error: 'Procesamiento tomó demasiado tiempo',
          videoId: videoId,
          timeout: true
        });
      }
      this.removeFromQueue(videoId);
    }, HTTP_TIMEOUT);

    const queueItem = { 
      videoId, 
      res, 
      timestamp: Date.now(),
      timeout
    };

    this.queue.push(queueItem);
    console.log(`📋 Video ${videoId} agregado a la cola. Posición: ${this.queue.length}`);
    
    // Intentar procesar inmediatamente
    this.processQueue();
  }

  removeFromQueue(videoId) {
    const index = this.queue.findIndex(item => item.videoId === videoId);
    if (index !== -1) {
      const item = this.queue.splice(index, 1)[0];
      if (item.timeout) {
        clearTimeout(item.timeout);
      }
      console.log(`🗑️ Video ${videoId} removido de la cola`);
    }
    this.processingIds.delete(videoId);
  }

  async processQueue() {
    // No procesar si no hay capacidad
    if (currentProcessing >= MAX_CONCURRENT_REQUESTS || this.queue.length === 0) {
      return;
    }

    // Tomar el primer video de la cola
    const queueItem = this.queue.find(item => !this.processingIds.has(item.videoId));
    if (!queueItem) {
      return;
    }

    const { videoId, res, timeout } = queueItem;
    
    // Marcar como procesando
    this.processingIds.add(videoId);
    currentProcessing++;
    
    console.log(`🎬 Procesando video de la cola: ${videoId} (${this.queue.length} en cola, ${currentProcessing}/${MAX_CONCURRENT_REQUESTS} procesando)`);
    
    try {
      await this.processVideo(videoId, res);
    } catch (error) {
      console.error(`❌ Error procesando video ${videoId}:`, error.message);
      
      // Verificar si se puede reintentar
      const attempts = this.retryAttempts.get(videoId) || 0;
      if (attempts < this.maxRetries && this.isRetryableError(error)) {
        console.log(`🔄 Reintentando video ${videoId} (${attempts + 1}/${this.maxRetries})`);
        this.retryAttempts.set(videoId, attempts + 1);
        
        // Volver a agregar a la cola después de un delay
        setTimeout(() => {
          this.processingIds.delete(videoId);
          this.processQueue();
        }, 5000 * (attempts + 1)); // Backoff incremental
      } else {
        // Sin más reintentos
        this.retryAttempts.delete(videoId);
        if (!res.headersSent) {
          res.status(500).json({
            error: `Error procesando video después de ${attempts + 1} intentos: ${error.message}`,
            videoId: videoId,
            attempts: attempts + 1
          });
        }
      }
    } finally {
      // Limpiar
      currentProcessing--;
      this.removeFromQueue(videoId);
      
      // Continuar procesando cola
      setTimeout(() => this.processQueue(), 1000);
    }
  }

  isRetryableError(error) {
    const retryableMessages = [
      '500', '502', '503', '504',
      'timeout', 'network', 'ECONNRESET', 'ETIMEDOUT',
      'Internal Server Error', 'Service Unavailable',
      'temporalmente no disponible', 'sobrecargado'
    ];
    
    return retryableMessages.some(msg => 
      error.message.toLowerCase().includes(msg.toLowerCase())
    );
  }

  async processVideo(videoId, res) {
    try {
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

        if (!res.headersSent) {
          res.json({
            drive_id: existingVideo.drive_id,
            description: parsedDescription,
            cached: true,
            tokenUsage: tokenUsage
          });
        }
        return;
      }

      // Procesamiento con timeout estricto
      console.log(`🚀 Iniciando procesamiento nuevo: ${videoId}`);
      
      const processingPromise = this.performVideoAnalysis(videoId);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Procesamiento excedió el tiempo límite'));
        }, ANALYSIS_TIMEOUT);
      });

      const result = await Promise.race([processingPromise, timeoutPromise]);
      
      if (!res.headersSent) {
        res.json({
          drive_id: videoId,
          description: result.description,
          cached: false,
          modelUsed: result.modelUsed,
          tokenUsage: result.tokenUsage
        });
      }
      
    } catch (error) {
      console.error(`💥 Error en processVideo para ${videoId}:`, error.message);
      throw error;
    }
  }

  async performVideoAnalysis(videoId) {
    let filePath;
    
    try {
      // Descarga con timeout
      console.log(`📥 Descargando video: ${videoId}`);
      filePath = await Promise.race([
        downloadVideoFromDrive(videoId),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timeout en descarga')), 60000);
        })
      ]);
      console.log(`✅ Video descargado: ${filePath}`);
      
      // Análisis con timeout
      console.log(`🤖 Iniciando análisis con Gemini para ${videoId}...`);
      const analysisResult = await Promise.race([
        getVideoDescription(filePath),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Timeout en análisis')), ANALYSIS_TIMEOUT - 60000);
        })
      ]);
      
      console.log(`✅ Análisis completado para ${videoId}`);
      
      // Guardar en BD
      await insertVideo(videoId, analysisResult.description, analysisResult.tokenUsage);
      console.log(`💾 Video guardado en BD: ${videoId}`);
      
      return analysisResult;
      
    } catch (error) {
      console.error(`❌ Error en análisis de ${videoId}:`, error.message);
      throw error;
    } finally {
      if (filePath) {
        cleanupTempFile(filePath);
      }
      
      // Forzar garbage collection
      if (global.gc) {
        global.gc();
      }
    }
  }

  getStatus() {
    return {
      queueLength: this.queue.length,
      processingIds: Array.from(this.processingIds),
      currentProcessing: currentProcessing,
      maxConcurrent: MAX_CONCURRENT_REQUESTS,
      retryAttempts: Object.fromEntries(this.retryAttempts)
    };
  }
}

const processingQueue = new ProcessingQueue();

// Middleware
app.use(express.json());

// Middleware para configurar timeout en todas las respuestas
app.use((req, res, next) => {
  res.setTimeout(HTTP_TIMEOUT, () => {
    console.log(`⏰ Timeout HTTP para ${req.method} ${req.path}`);
    if (!res.headersSent) {
      res.status(408).json({
        error: 'Timeout de servidor',
        timeout: HTTP_TIMEOUT / 1000
      });
    }
  });
  next();
});

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

  // Agregar columna token_usage si no existe
  db.run(`
    ALTER TABLE videos ADD COLUMN token_usage TEXT
  `, (err) => {
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

// Funciones de base de datos con promesas y timeout
const getVideoFromDB = (driveId) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout en consulta de base de datos'));
    }, 10000);

    db.get('SELECT * FROM videos WHERE drive_id = ?', [driveId], (err, row) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(row);
    });
  });
};

const insertVideo = (driveId, description, tokenUsage = null) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout en inserción de base de datos'));
    }, 15000);

    const tokenUsageJson = tokenUsage ? JSON.stringify(tokenUsage) : null;
    const descriptionJson = typeof description === 'object' ? JSON.stringify(description) : description;
    
    db.run('INSERT INTO videos (drive_id, description, token_usage) VALUES (?, ?, ?)', [driveId, descriptionJson, tokenUsageJson], function (err) {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
};

const getAllVideos = () => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout en consulta de todos los videos'));
    }, 30000);

    db.all('SELECT * FROM videos ORDER BY created_at DESC', [], (err, rows) => {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve(rows);
    });
  });
};

const updateVideo = (description, driveId) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout en actualización de base de datos'));
    }, 15000);

    const descriptionJson = typeof description === 'object' ? JSON.stringify(description) : description;
    db.run('UPDATE videos SET description = ? WHERE drive_id = ?', [descriptionJson, driveId], function (err) {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve({ changes: this.changes });
    });
  });
};

const deleteVideo = (driveId) => {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout en eliminación de base de datos'));
    }, 10000);

    db.run('DELETE FROM videos WHERE drive_id = ?', [driveId], function (err) {
      clearTimeout(timeout);
      if (err) reject(err);
      else resolve({ changes: this.changes });
    });
  });
};

// Función para descargar video de Google Drive con timeout
async function downloadVideoFromDrive(videoId) {
  if (!drive) {
    throw new Error('Google Drive API no está configurada correctamente');
  }

  try {
    // Timeout para metadata
    const fileMetadata = await Promise.race([
      drive.files.get({
        fileId: videoId,
        fields: 'name, mimeType, size'
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout obteniendo metadata')), 30000);
      })
    ]);

    const fileName = fileMetadata.data.name || `video_${videoId}`;
    const fileSize = parseInt(fileMetadata.data.size) || 0;
    
    // Verificar tamaño antes de descargar
    if (fileSize > 100 * 1024 * 1024) { // 100MB límite
      throw new Error(`Archivo demasiado grande: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);
    }

    const filePath = path.join('/tmp', `${videoId}_${Date.now()}_${fileName}`);

    // Timeout para descarga
    const response = await Promise.race([
      drive.files.get({
        fileId: videoId,
        alt: 'media'
      }, { responseType: 'stream' }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Timeout en descarga')), 120000);
      })
    ]);

    // Guardar archivo con timeout
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout guardando archivo'));
      }, 120000);

      const dest = fs.createWriteStream(filePath);
      let downloadedBytes = 0;

      response.data
        .on('data', (chunk) => {
          downloadedBytes += chunk.length;
          // Log progreso cada 10MB
          if (downloadedBytes % (10 * 1024 * 1024) < chunk.length) {
            console.log(`📥 Descargado: ${(downloadedBytes / 1024 / 1024).toFixed(1)} MB`);
          }
        })
        .on('end', () => {
          clearTimeout(timeout);
          console.log(`✅ Descarga completa: ${(downloadedBytes / 1024 / 1024).toFixed(2)} MB`);
          resolve(filePath);
        })
        .on('error', (error) => {
          clearTimeout(timeout);
          cleanupTempFile(filePath);
          reject(error);
        })
        .pipe(dest);

      dest.on('error', (error) => {
        clearTimeout(timeout);
        cleanupTempFile(filePath);
        reject(error);
      });
    });
  } catch (error) {
    console.error('Error descargando video:', error.message);
    throw new Error(`No se pudo descargar el video: ${error.message}`);
  }
}

// Función para obtener descripción con Gemini con timeouts mejorados
async function getVideoDescription(filePath) {
  if (!genAI) {
    throw new Error('Gemini AI no está configurada correctamente');
  }

  try {
    const stats = fs.statSync(filePath);
    const fileSizeInMB = stats.size / (1024 * 1024);
    
    console.log(`📊 Tamaño del archivo: ${fileSizeInMB.toFixed(2)} MB`);
    
    if (fileSizeInMB > 50) {
      throw new Error(`Archivo demasiado grande (${fileSizeInMB.toFixed(2)} MB). Máximo: 50 MB`);
    }

    const modelConfigs = [
      { name: "gemini-2.5-flash", maxSizeMB: 50 },
      { name: "gemini-2.5-pro", maxSizeMB: 30 }
    ];

    const availableModels = modelConfigs.filter(config => fileSizeInMB <= config.maxSizeMB);
    
    if (availableModels.length === 0) {
      throw new Error(`Archivo demasiado grande para todos los modelos (${fileSizeInMB.toFixed(2)} MB)`);
    }

    // Leer archivo
    let videoBuffer;
    try {
      videoBuffer = fs.readFileSync(filePath);
    } catch (readError) {
      throw new Error(`Error leyendo archivo: ${readError.message}`);
    }

    const fileExtension = path.extname(filePath).toLowerCase();
    let mimeType = 'video/mp4';

    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.wmv': 'video/x-ms-wmv',
      '.webm': 'video/webm'
    };

    mimeType = mimeTypes[fileExtension] || 'video/mp4';

    const prompt = `Analiza este video y responde ÚNICAMENTE con JSON válido (sin markdown):
    {
      "texto_visible": "transcripción COMPLETA del texto visible" o false,
      "musica_fondo": "descripción de la música" o false,
      "objetos_presentes": "descripción de objetos" o false,
      "personas": "descripción de personas" o false,
      "acciones": "descripción de acciones" o false,
      "colores_predominantes": "colores principales",
      "ambiente_contexto": "descripción del ambiente",
      "dialogo_narracion": "transcripción LITERAL del diálogo" o false,
      "duracion_segundos": número_entero,
      "duracion_formato": "formato legible (ej: '2:30')"
    }`;

    // Intentar con cada modelo disponible
    for (const modelConfig of availableModels) {
      try {
        console.log(`🤖 Probando ${modelConfig.name}...`);
        
        const model = genAI.getGenerativeModel({ model: modelConfig.name });
        
        // Análisis con timeout estricto
        const analysisPromise = model.generateContent([
          prompt,
          {
            inlineData: {
              data: videoBuffer.toString('base64'),
              mimeType: mimeType
            }
          }
        ]);
        
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Timeout en análisis con Gemini'));
          }, 150000); // 2.5 minutos
        });
        
        const result = await Promise.race([analysisPromise, timeoutPromise]);
        const response = await result.response;
        
        // Liberar memoria inmediatamente
        videoBuffer = null;
        if (global.gc) global.gc();
        
        const usageMetadata = response.usageMetadata;
        let description = response.text().trim();
        
        // Limpiar respuesta
        description = description.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        
        try {
          description = JSON.parse(description);
        } catch (jsonError) {
          console.warn('Error parseando JSON:', jsonError.message);
          description = {
            error: 'JSON parsing failed',
            raw_response: description.substring(0, 1000),
            parsed_at: new Date().toISOString()
          };
        }
        
        return {
          description,
          modelUsed: modelConfig.name,
          tokenUsage: {
            promptTokens: usageMetadata?.promptTokenCount || 0,
            candidatesTokens: usageMetadata?.candidatesTokenCount || 0,
            totalTokens: usageMetadata?.totalTokenCount || 0
          }
        };
        
      } catch (error) {
        console.warn(`❌ ${modelConfig.name} falló:`, error.message);
        continue;
      }
    }
    
    throw new Error('Todos los modelos de Gemini fallaron');
    
  } catch (error) {
    // Mapear errores comunes
    if (error.message.includes('500')) {
      throw new Error('Servidor de Gemini temporalmente no disponible');
    } else if (error.message.includes('503')) {
      throw new Error('Servicio de Gemini sobrecargado');
    } else if (error.message.includes('403')) {
      throw new Error('API key inválida o sin permisos');
    } else if (error.message.includes('429')) {
      throw new Error('Límite de cuota excedido');
    }
    
    throw error;
  }
}

function cleanupTempFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`🗑️ Archivo temporal eliminado: ${filePath}`);
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

  console.log(`🎬 Solicitud de procesamiento: ${videoId}`);
  
  // Siempre usar la cola para mejor control
  processingQueue.add(videoId, res);
});

// Estado de la cola
app.get('/queue-status', (req, res) => {
  res.json({
    ...processingQueue.getStatus(),
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Procesamiento directo (para compatibilidad)
app.post('/process-direct', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({
      error: 'El campo videoId es requerido'
    });
  }

  // Redirigir a la cola principal
  processingQueue.add(videoId, res);
});

// CRUD ENDPOINTS
app.get('/videos', async (req, res) => {
  try {
    const videos = await getAllVideos();

    const videosWithTokenUsage = videos.map(video => {
      let parsedDescription = video.description;
      try {
        parsedDescription = JSON.parse(video.description);
      } catch (e) {
        // Mantener como string si no es JSON válido
      }

      let tokenUsage = null;
      if (video.token_usage) {
        try {
          tokenUsage = JSON.parse(video.token_usage);
        } catch (e) {
          console.warn(`Error parseando token_usage para ${video.drive_id}`);
        }
      }

      return {
        ...video,
        description: parsedDescription,
        tokenUsage: tokenUsage,
        token_usage: undefined
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

app.get('/videos/:driveId', async (req, res) => {
  const { driveId } = req.params;

  try {
    const video = await getVideoFromDB(driveId);

    if (!video) {
      return res.status(404).json({
        error: 'Video no encontrado'
      });
    }

    let parsedDescription = video.description;
    try {
      parsedDescription = JSON.parse(video.description);
    } catch (e) {
      // Mantener como string
    }

    let tokenUsage = null;
    if (video.token_usage) {
      try {
        tokenUsage = JSON.parse(video.token_usage);
      } catch (e) {
        console.warn('Error parseando token_usage');
      }
    }

    res.json({
      ...video,
      description: parsedDescription,
      tokenUsage: tokenUsage,
      token_usage: undefined
    });
  } catch (error) {
    console.error('Error obteniendo video:', error.message);
    res.status(500).json({
      error: `Error obteniendo video: ${error.message}`
    });
  }
});

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

// Health check mejorado
app.get('/health', (req, res) => {
  const memUsage = process.memoryUsage();
  
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime() / 60)} minutos`,
    processing: {
      current: currentProcessing,
      max: MAX_CONCURRENT_REQUESTS,
      available: MAX_CONCURRENT_REQUESTS - currentProcessing,
      queue: processingQueue.getStatus()
    },
    memory: {
      used: Math.round(memUsage.heapUsed / 1024 / 1024),
      total: Math.round(memUsage.heapTotal / 1024 / 1024),
      external: Math.round(memUsage.external / 1024 / 1024),
      rss: Math.round(memUsage.rss / 1024 / 1024)
    },
    services: {
      database: 'Connected',
      googleDrive: drive ? 'Configured' : 'Not configured',
      geminiAI: genAI ? 'Configured' : 'Not configured'
    },
    timeouts: {
      http: `${HTTP_TIMEOUT / 1000}s`,
      analysis: `${ANALYSIS_TIMEOUT / 1000}s`
    }
  });
});

// Middleware para rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
    path: req.path,
    method: req.method
  });
});

// Error handler global
app.use((error, req, res, next) => {
  console.error('Error no manejado:', error);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Error interno del servidor',
      timestamp: new Date().toISOString()
    });
  }
});

// Crear directorio temporal
const tmpDir = '/tmp';
if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// Limpiar archivos temporales antiguos al inicio
try {
  const files = fs.readdirSync(tmpDir);
  const now = Date.now();
  let cleaned = 0;
  
  files.forEach(file => {
    const filePath = path.join(tmpDir, file);
    const stats = fs.statSync(filePath);
    const ageInMinutes = (now - stats.mtime.getTime()) / (1000 * 60);
    
    if (ageInMinutes > 30) { // Archivos más antiguos de 30 minutos
      fs.unlinkSync(filePath);
      cleaned++;
    }
  });
  
  if (cleaned > 0) {
    console.log(`🧹 Limpieza inicial: ${cleaned} archivos temporales eliminados`);
  }
} catch (error) {
  console.warn('Error en limpieza inicial:', error.message);
}

// Iniciar servidor
const server = app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
  console.log(`⚡ Concurrencia máxima: ${MAX_CONCURRENT_REQUESTS} videos simultáneos`);
  console.log(`⏰ Timeout HTTP: ${HTTP_TIMEOUT / 1000}s | Análisis: ${ANALYSIS_TIMEOUT / 1000}s`);
  console.log(`📋 Sistema de cola con reintentos automáticos`);
  console.log(`📊 Base de datos SQLite inicializada`);
  console.log(`🔧 Google Drive API: ${drive ? 'Configurada ✅' : 'No configurada ❌'}`);
  console.log(`🤖 Gemini AI: ${genAI ? 'Configurada ✅' : 'No configurada ❌'}`);
  console.log(`📁 Directorio temporal: ${tmpDir}`);
  console.log(`💾 Memoria inicial: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);
  console.log(`🗑️ Garbage collection: ${global.gc ? 'Habilitado' : 'Ejecutar con --expose-gc'}`);
});

// Configurar timeout del servidor
server.setTimeout(HTTP_TIMEOUT + 30000); // 30s extra de margen

// Manejo de cierre graceful
const gracefulShutdown = () => {
  console.log('\n🔄 Iniciando cierre graceful...');
  console.log(`📊 Videos en procesamiento: ${currentProcessing}`);
  console.log(`📋 Videos en cola: ${processingQueue.getStatus().queueLength}`);
  
  server.close(() => {
    console.log('🌐 Servidor HTTP cerrado');
    db.close((err) => {
      if (err) {
        console.error('Error cerrando BD:', err.message);
      } else {
        console.log('💾 Base de datos cerrada');
      }
      process.exit(0);
    });
  });
  
  // Forzar cierre después de 10 segundos
  setTimeout(() => {
    console.log('⚠️ Forzando cierre del proceso');
    process.exit(1);
  }, 10000);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Monitoreo de memoria optimizado
setInterval(() => {
  const memUsage = process.memoryUsage();
  const memUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const queueStatus = processingQueue.getStatus();
  
  if (memUsedMB > 200 || queueStatus.queueLength > 5 || currentProcessing > 0) {
    console.log(`📊 Memoria: ${memUsedMB} MB | Cola: ${queueStatus.queueLength} | Procesando: ${currentProcessing}/${MAX_CONCURRENT_REQUESTS}`);
  }
  
  // GC agresivo si hay mucha memoria en uso
  if (memUsedMB > 800 && global.gc) {
    console.log('🗑️ Ejecutando GC por alto uso de memoria');
    global.gc();
  }
}, 30000);

// Limpieza periódica de archivos temporales
setInterval(() => {
  try {
    const files = fs.readdirSync(tmpDir);
    const now = Date.now();
    let cleaned = 0;
    
    files.forEach(file => {
      try {
        const filePath = path.join(tmpDir, file);
        const stats = fs.statSync(filePath);
        const ageInMinutes = (now - stats.mtime.getTime()) / (1000 * 60);
        
        if (ageInMinutes > 15) { // Limpiar archivos de más de 15 minutos
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch (error) {
        // Ignorar errores de archivos individuales
      }
    });
    
    if (cleaned > 0) {
      console.log(`🧹 Archivos temporales limpiados: ${cleaned}`);
    }
  } catch (error) {
    console.warn('Error en limpieza periódica:', error.message);
  }
}, 10 * 60 * 1000); // Cada 10 minutos

console.log('🎯 Sistema de procesamiento de videos iniciado correctamente');