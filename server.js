const cluster = require('cluster');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const connectDB = require('./config/database');
const { queue, gracefulShutdown } = require('./config/queue');
const metrics = require('./config/metrics');
const { initializeWebSocket } = require('./routes/websockets');
const battleStatsController = require('./controllers/battleStatsController');
const RedisConnectionPool = require('./config/redisPool');
const ResponseUtils = require('./utils/responseUtils');
const { unifiedAuth, setRedisClient } = require('./middleware/unifiedAuth');
const { clientCors, serverCors, ALLOWED_ORIGINS } = require('./middleware/cors');
const { version, name } = require('./package.json');
const RouteBuilder = require('./utils/routeBuilder');

const WEB_CONCURRENCY = Number(process.env.WEB_CONCURRENCY || 1);
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';



process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});

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
      origin: ALLOWED_ORIGINS,
      methods: ['GET', 'POST'],
      credentials: false,
      allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Player-ID', 'X-Secret-Key']
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    allowEIO3: true,
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, !origin || ALLOWED_ORIGINS.includes(origin));
    }
  });

  const redisUrl = process.env.REDISCLOUD_URL || process.env.REDIS_URL || null;
  let redisPool = null;
  let primaryClient = null;

  (async () => {
    try {
      if (!redisUrl) {
        console.warn('ℹ️  Redis URL not set. Running Socket.IO without cluster adapter.');
      } else {
        redisPool = new RedisConnectionPool(redisUrl, 5);
        await redisPool.init();
        
        primaryClient = await redisPool.acquire();
        const subClient = await redisPool.acquire();
        
        io.adapter(createAdapter(primaryClient, subClient));
        console.log(`🔌 Socket.IO Redis adapter connected in worker ${process.pid}.`);
        setRedisClient(primaryClient);
      }
    } catch (err) {
      console.error(`❌ Failed to init Redis adapter in worker ${process.pid}:`, err);
    }
  })();

  // Configure Express
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression({
    level: IS_PROD ? 9 : 1,
    threshold: '1kb',
    filter: (req, res) => !req.headers['x-no-compression']
  }));

  app.use(express.json({
    limit: IS_PROD ? '2mb' : '5mb',
    type: ['application/json', 'text/plain']
  }));

  app.use(express.urlencoded({
    limit: IS_PROD ? '2mb' : '5mb',
    extended: false,
    parameterLimit: 1000
  }));

  app.use(clientCors);

  server.setTimeout(30000);
  server.keepAliveTimeout = 61000;
  server.headersTimeout = 62000;

  // Health endpoints
  app.get('/', (req, res) => {
    ResponseUtils.sendSuccess(res, {
      message: 'Сервер працює!',
      version,
      environment: process.env.NODE_ENV,
      worker: process.pid
    });
  });

  app.get('/api/status', async (req, res) => {
    try {
      const memory = process.memoryUsage();
      ResponseUtils.sendSuccess(res, {
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
      ResponseUtils.sendError(res, new AppError('Status check failed', 500));
    }
  });

  app.get('/api/queue-status', (req, res) => {
    const successRate = metrics.totalRequests > 0
        ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)
        : '0';

    ResponseUtils.sendSuccess(res, {
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

  // Build routes using RouteBuilder
  const routeBuilder = new RouteBuilder(app, battleStatsController);
  
  // Client API routes: CORS enabled, Secret Key NOT required
  routeBuilder.buildClientRoutes();
  
  // Server-to-Server API routes: Secret Key required, CORS disabled
  routeBuilder.buildServerRoutes();

  // Utility endpoints
  app.get('/api/battle-stats/health', routeBuilder.addClientHeaders, (req, res) => {
    ResponseUtils.sendSuccess(res, {
        status: 'healthy',
        type: 'client-api',
        uptime: Math.floor(process.uptime()),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        }
    });
  });

  app.get('/api/battle-stats/version', routeBuilder.addClientHeaders, (req, res) => {
    ResponseUtils.sendSuccess(res, {
        version,
        name,
        description: 'Client API для статистики боїв',
        authentication: 'X-API-Key заголовок обов\'язковий'
    });
  });

  app.get('/api/websocket-test', (req, res) => {
    ResponseUtils.sendSuccess(res, {
      socketIo: {
        connected: io.engine.clientsCount,
        transport: 'websocket, polling'
      },
      cors: {
        origins: ALLOWED_ORIGINS
      }
    });
  });

  app.use('*', (req, res) => {
    const error = new AppError(`Route ${req.method} ${req.originalUrl} not found`, 404);
    ResponseUtils.sendError(res, error);
  });

  app.use((error, req, res, next) => {
    if (!IS_PROD) console.error('❌ Error:', error);
    if (!(error instanceof AppError)) error = new AppError('Internal server error', 500);
    ResponseUtils.sendError(res, error);
  });

  initializeWebSocket(io, primaryClient);
  battleStatsController.setIo(io);

  io.engine.on('connection_error', (err) => {
    console.error('Socket.IO connection error:', err);
  });

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
        if (redisPool) {
          await redisPool.destroy();
          console.log('✅ Redis pool disconnected.');
        }
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