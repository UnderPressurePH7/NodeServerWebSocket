const cluster = require('cluster');
const os = require('os');
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
const shutdownManager = require('./utils/shutdownManager');
const ResponseUtils = require('./utils/responseUtils');
const UnifiedRouter = require('./routes/unifiedRouter');
const { unifiedAuth } = require('./middleware/unifiedAuth');

const { version, name } = require('./package.json');

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
        unifiedAuth.setRedisClient(primaryClient);
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
        status: primaryClient?.isOpen ? 'connected' : 'disconnected',
        pool: redisPool ? redisPool.getStats() : null
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

  const unifiedRouter = new UnifiedRouter();

  const routes = [
    {
      method: 'post',
      path: '/api/battle-stats/update-stats',
      controller: battleStatsController.updateStats,
      requirePlayerId: true,
      cors: 'client'
    },
    {
      method: 'get',
      path: '/api/battle-stats/stats',
      controller: battleStatsController.getStats,
      cors: 'client',
      additionalMiddleware: [unifiedRouter.validatePagination]
    },
    {
      method: 'get',
      path: '/api/battle-stats/other-players',
      controller: battleStatsController.getOtherPlayersStats,
      requirePlayerId: true,
      cors: 'client'
    },
    {
      method: 'post',
      path: '/api/battle-stats/import',
      controller: battleStatsController.importStats,
      cors: 'client'
    },
    {
      method: 'delete',
      path: '/api/battle-stats/clear',
      controller: battleStatsController.clearStats,
      cors: 'client'
    },
    {
      method: 'delete',
      path: '/api/battle-stats/battle/:battleId',
      controller: battleStatsController.deleteBattle,
      cors: 'client',
      additionalMiddleware: [unifiedRouter.validateBattleId]
    },
    {
      method: 'delete',
      path: '/api/battle-stats/clear-database',
      controller: battleStatsController.clearDatabase,
      requireSecret: true,
      cors: 'client'
    },
    {
      method: 'post',
      path: '/api/server/update-stats',
      controller: battleStatsController.updateStats,
      requireSecret: true,
      requirePlayerId: true,
      cors: 'server'
    },
    {
      method: 'get',
      path: '/api/server/stats',
      controller: battleStatsController.getStats,
      requireSecret: true,
      cors: 'server',
      additionalMiddleware: [unifiedRouter.validatePagination]
    },
    {
      method: 'get',
      path: '/api/server/other-players',
      controller: battleStatsController.getOtherPlayersStats,
      requireSecret: true,
      requirePlayerId: true,
      cors: 'server'
    },
    {
      method: 'post',
      path: '/api/server/import',
      controller: battleStatsController.importStats,
      requireSecret: true,
      cors: 'server'
    },
    {
      method: 'delete',
      path: '/api/server/clear',
      controller: battleStatsController.clearStats,
      requireSecret: true,
      cors: 'server'
    },
    {
      method: 'delete',
      path: '/api/server/battle/:battleId',
      controller: battleStatsController.deleteBattle,
      requireSecret: true,
      cors: 'server',
      additionalMiddleware: [unifiedRouter.validateBattleId]
    },
    {
      method: 'delete',
      path: '/api/server/clear-database',
      controller: battleStatsController.clearDatabase,
      requireSecret: true,
      cors: 'server'
    }
  ];

  routes.forEach(route => unifiedRouter.setupRoute(route));

  unifiedRouter.setupRoute({
    method: 'get',
    path: '/api/battle-stats/health',
    controller: (req, res) => {
      ResponseUtils.sendSuccess(res, {
        status: 'healthy',
        type: 'client-api',
        uptime: Math.floor(process.uptime()),
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        }
      });
    },
    cors: 'client',
    additionalMiddleware: []
  });

  unifiedRouter.setupRoute({
    method: 'get',
    path: '/api/battle-stats/version',
    controller: (req, res) => {
      ResponseUtils.sendSuccess(res, {
        version,
        name,
        description: 'Client API для статистики боїв',
        authentication: 'X-API-Key заголовок обов\'язковий',
        endpoints: [
          'POST /update-stats - Оновлення статистики (X-Player-ID обов\'язковий)',
          'GET /stats - Отримання статистики',
          'GET /other-players - Статистика інших гравців (X-Player-ID обов\'язковий)',
          'POST /import - Імпорт даних',
          'DELETE /clear - Очищення статистики',
          'DELETE /battle/:battleId - Видалення бою',
          'DELETE /clear-database - Очищення БД (X-Secret-Key обов\'язковий)',
          'GET /health - Стан сервера (без автентифікації)',
          'GET /version - Інформація про API (без автентифікації)'
        ]
      });
    },
    cors: 'client',
    additionalMiddleware: []
  });

  unifiedRouter.setupRoute({
    method: 'get',
    path: '/api/server/health',
    controller: (req, res) => {
      ResponseUtils.sendSuccess(res, {
        status: 'healthy',
        type: 'server-to-server',
        uptime: Math.floor(process.uptime()),
        memory: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        }
      });
    },
    cors: 'server',
    additionalMiddleware: []
  });

  unifiedRouter.setupRoute({
    method: 'get',
    path: '/api/server/version',
    controller: (req, res) => {
      ResponseUtils.sendSuccess(res, {
        version,
        name,
        description: 'Server-to-server API для статистики боїв',
        authentication: 'X-Secret-Key header required',
        endpoints: [
          'POST /update-stats',
          'GET /stats',
          'GET /other-players',
          'POST /import',
          'DELETE /clear',
          'DELETE /battle/:battleId',
          'DELETE /clear-database',
          'GET /health',
          'GET /version'
        ]
      });
    },
    cors: 'server',
    additionalMiddleware: []
  });

  app.use(unifiedRouter.getRouter());

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

  shutdownManager.registerResource('HTTP Server', () => {
    return new Promise((resolve) => {
      server.close(() => {
        console.log('HTTP сервер зупинено');
        resolve();
      });
    });
  });

  shutdownManager.registerResource('Queue System', async () => {
    if (queue && typeof queue.onIdle === 'function') {
      await Promise.race([
        queue.onIdle(),
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    }
    await gracefulShutdown();
  });

  shutdownManager.registerResource('MongoDB', async () => {
    await mongoose.disconnect();
  });

  shutdownManager.registerResource('Redis Pool', async () => {
    if (redisPool) {
      await redisPool.destroy();
    }
  });

  shutdownManager.registerResource('Auth Cache', async () => {
    unifiedAuth.destroy();
  });
}