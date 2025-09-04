const cluster = require('cluster');
const os = require('os');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const connectDB = require('./config/database');
const { queue, gracefulShutdown } = require('./config/queue');
const metrics = require('./config/metrics');
const { initializeWebSocket } = require('./routes/websockets');
const battleStatsRoutes = require('./routes/battleStats');     
const serverBattleStatsRoutes = require('./routes/serverBattleStats'); 

const { version } = require('./package.json');
const { setRedisClient } = require('./middleware/auth');

const WEB_CONCURRENCY = Number(process.env.WEB_CONCURRENCY || 1);
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}
class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}
class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}
class ServerError extends AppError {
  constructor(message = 'Internal server error') {
    super(message, 500, 'INTERNAL_ERROR');
  }
}

if (cluster.isPrimary && IS_PROD) {
  console.log(`🧠 Primary ${process.pid} started. Spawning ${WEB_CONCURRENCY} workers...`);
  for (let i = 0; i < WEB_CONCURRENCY; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`⚠️  Worker ${worker.process.pid} exited. code=${code} signal=${signal}. Restarting...`);
    cluster.fork();
  });
} else {
  const app = express();
  const server = http.createServer(app);

  const io = new Server(server, {
    cors: {
      origin: (origin, cb) => {
        if (!origin || !IS_PROD) return cb(null, true);
        return cb(null, true);
      },
      methods: ['GET', 'POST'],
      credentials: false
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    allowEIO3: true
  });

  const redisUrl = process.env.REDISCLOUD_URL || process.env.REDIS_URL || null;
  let redisClient = null;
  let subClient = null;

  (async () => {
    try {
      if (!redisUrl) {
        console.warn('ℹ️  Redis URL not set. Running Socket.IO without cluster adapter.');
      } else {
        redisClient = createClient({ url: redisUrl });
        subClient = redisClient.duplicate();
        await Promise.all([redisClient.connect(), subClient.connect()]);
        io.adapter(createAdapter(redisClient, subClient));
        console.log(`🔌 Socket.IO Redis adapter connected in worker ${process.pid}.`);
        setRedisClient(redisClient); 
      }
    } catch (err) {
      console.error(`❌ Failed to init Redis adapter in worker ${process.pid}:`, err);
    }
  })();

  app.set('trust proxy', 1); 
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: false 
    })
  );

  app.use(
    compression({
      level: IS_PROD ? 9 : 1,
      threshold: '1kb',
      filter: (req, res) => !req.headers['x-no-compression']
    })
  );

  app.use(
    express.json({
      limit: IS_PROD ? '2mb' : '5mb',
      type: ['application/json', 'text/plain']
    })
  );

  app.use(
    express.urlencoded({
      limit: IS_PROD ? '2mb' : '5mb',
      extended: false,
      parameterLimit: 1000
    })
  );

  server.setTimeout(30000);        
  server.keepAliveTimeout = 61000;  
  server.headersTimeout = 62000;    

  const sendSuccess = (res, data = {}, status = 200) => {
    res.status(status).json({
      success: true,
      data,
      timestamp: new Date().toISOString()
    });
  };

  const sendError = (res, err) => {
    const status = err.statusCode || 500;
    const payload = {
      success: false,
      error: {
        code: err.code || 'UNKNOWN_ERROR',
        message: err.message || 'Error',
        statusCode: status
      },
      timestamp: new Date().toISOString()
    };
    if (!IS_PROD && err.stack) payload.error.stack = err.stack;
    if (err.details) payload.error.details = err.details;
    res.status(status).json(payload);
  };

  app.get('/', (req, res) => {
    sendSuccess(res, {
      message: 'Сервер працює!',
      version,
      environment: process.env.NODE_ENV,
      worker: process.pid
    });
  });

  app.get('/api/status', async (req, res) => {
    try {
      const memory = process.memoryUsage();
      sendSuccess(res, {
        status: 'ok',
        database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        uptime: Math.floor(process.uptime()),
        memory: {
          heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
          heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
        },
        connections: {
          websocket: io.engine.clientsCount
        },
        worker: process.pid
      });
    } catch (e) {
      sendError(res, new ServerError('Status check failed'));
    }
  });

  app.get('/api/health/detailed', async (req, res) => {
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: Math.floor(process.uptime()),
      memory: process.memoryUsage(),
      connections: {
        websocket: io?.engine?.clientsCount || 0
      },
      database: {
        status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        host: mongoose.connection.host
      },
      redis: {
        status: redisClient?.isOpen ? 'connected' : 'disconnected'
      },
      queue: {
        size: queue?.size || 0,
        pending: queue?.pending || 0,
        isPaused: queue?.isPaused || false
      }
    };
    
    const overallStatus = (
      health.database.status === 'connected' && 
      health.queue.size < 1000
    ) ? 'healthy' : 'unhealthy';
    
    res.status(overallStatus === 'healthy' ? 200 : 503).json({
      ...health,
      status: overallStatus
    });
  });

  app.get('/api/queue-status', (req, res) => {
    const successRate =
      metrics.totalRequests > 0
        ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)
        : '0';

    sendSuccess(res, {
      queue: {
        size: queue.size,
        pending: queue.pending,
        isPaused: queue.isPaused
      },
      metrics: {
        totalRequests: metrics.totalRequests,
        successfulRequests: metrics.successfulRequests,
        failedRequests: metrics.failedRequests,
        successRate: `${successRate}%`
      }
    });
  });

  app.use('/api/battle-stats', battleStatsRoutes);
  app.use('/api/server', serverBattleStatsRoutes); 

  app.use((req, res, next) => next(new NotFoundError(`Route ${req.method} ${req.path} not found`)));

  app.use((error, req, res, next) => {
    if (!IS_PROD) console.error('❌ Error:', error);
    if (!(error instanceof AppError)) error = new ServerError();
    sendError(res, error);
  });

  initializeWebSocket(io, redisClient);

  const start = async () => {
    try {
      await connectDB();
      server.listen(PORT, () => {
        console.log(`🚀 Worker ${process.pid} listening on port ${PORT}`);
      });
    } catch (err) {
      console.error(`❌ Worker ${process.pid} failed to start:`, err);
      process.exit(1);
    }
  };

  start();

  const gracefulServerShutdown = async (signal) => {
    console.log(`🔻 Signal ${signal} received in worker ${process.pid}. Shutting down...`);
    
    server.close(async () => {
      console.log('HTTP сервер зупинено');
      
      try {
        if (queue && typeof queue.onIdle === 'function') {
          await Promise.race([
            queue.onIdle(),
            new Promise(resolve => setTimeout(resolve, 5000))
          ]);
        }
      } catch (e) {
        console.warn('Queue shutdown timeout:', e?.message);
      }
      
      try {
        await gracefulShutdown();
      } catch (e) {
        console.warn('Queue graceful shutdown error:', e?.message);
      }
      
      try {
        await mongoose.disconnect();
        console.log('✅ MongoDB disconnected.');
      } catch (e) {
        console.warn('Mongo disconnect error:', e?.message);
      }

      try {
        if (redisClient?.isOpen) await redisClient.quit();
        if (subClient?.isOpen) await subClient.quit();
        console.log('✅ Redis clients disconnected.');
      } catch (e) {
        console.warn('Redis disconnect error:', e?.message);
      }

      if (cluster.worker) cluster.worker.disconnect?.();
      process.exit(0);
    });
    
    setTimeout(() => {
      console.error('Примусове завершення через тайм-аут');
      process.exit(1);
    }, 10000);
  };

  process.on('SIGTERM', () => gracefulServerShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulServerShutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
  });
}