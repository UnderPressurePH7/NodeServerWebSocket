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
const RedisConnectionPool = require('./config/redisPool');
const ResponseUtils = require('./utils/responseUtils');
const { unifiedAuth, setRedisClient } = require('./middleware/unifiedAuth');
const { clientCors, serverCors, ALLOWED_ORIGINS } = require('./middleware/cors');
const { version, name } = require('./package.json');
const RouteBuilder = require('./utils/routeBuilder');

// Імпортуємо контролер з додатковою діагностикою
let battleStatsController;
try {
    console.log('Loading battleStatsController...');
    battleStatsController = require('./controllers/battleStatsController');
    console.log('Controller loaded successfully:', {
        type: typeof battleStatsController,
        methods: Object.getOwnPropertyNames(battleStatsController).filter(name => typeof battleStatsController[name] === 'function')
    });
} catch (error) {
    console.error('CRITICAL: Failed to load battleStatsController:', error);
    process.exit(1);
}

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
        console.warn('ℹ️  Redis URL not set. Running without Redis adapter.');
      } else {
        console.log('🔗 Connecting to Redis...');
        redisPool = new RedisConnectionPool(redisUrl, { maxConnections: 10 });
        primaryClient = redisPool.getClient();
        setRedisClient(primaryClient);

        const pubClient = redisPool.getClient();
        const subClient = pubClient.duplicate();
        io.adapter(createAdapter(pubClient, subClient));
        console.log('✅ Redis adapter configured');
      }

      await connectDB();
      console.log('✅ Database connected');

      app.use(helmet({
        contentSecurityPolicy: IS_PROD ? undefined : false,
        crossOriginEmbedderPolicy: false
      }));
      app.use(compression());
      app.use(express.json({ limit: '10mb' }));
      app.use(express.urlencoded({ extended: true, limit: '10mb' }));

      app.set('trust proxy', true);

      app.use((req, res, next) => {
        if (req.method !== 'OPTIONS') {
          console.log(`📝 ${req.method} ${req.path} - Body:`, JSON.stringify(req.body).substring(0, 200));
        }
        next();
      });

      initializeWebSocket(io);

      app.get('/api/health', (req, res) => {
        try {
          const memory = process.memoryUsage();
          ResponseUtils.sendSuccess(res, {
            status: 'healthy',
            environment: process.env.NODE_ENV || 'development',
            version,
            redis: redisPool ? 'connected' : 'disconnected',
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

      console.log('🔍 Controller diagnosis before route building:');
      console.log('- Type:', typeof battleStatsController);
      console.log('- Constructor:', battleStatsController.constructor?.name);
      console.log('- Available methods:', Object.getOwnPropertyNames(battleStatsController).filter(name => typeof battleStatsController[name] === 'function'));
      console.log('- updateStats method:', typeof battleStatsController.updateStats);

      let routeBuilder;
      try {
        console.log('🛠️  Creating RouteBuilder...');
        routeBuilder = new RouteBuilder(app, battleStatsController);
        console.log('✅ RouteBuilder created successfully');
        
        console.log('🔗 Building client routes...');
        routeBuilder.buildClientRoutes();
        console.log('✅ Client routes built');
        
        console.log('🔗 Building server routes...');
        routeBuilder.buildServerRoutes();
        console.log('✅ Server routes built');
        
      } catch (routeError) {
        console.error('❌ CRITICAL ERROR building routes:', routeError);
        console.error('Stack:', routeError.stack);
        process.exit(1);
      }

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
        if (!res.headersSent) {
          ResponseUtils.sendError(res, error);
        }
      });

      server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 Worker ${process.pid} listening on port ${PORT}`);
        console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`🔗 CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
      });

    } catch (error) {
      console.error('❌ Failed to start server:', error);
      process.exit(1);
    }
  })();
}