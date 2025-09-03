const express = require('express');
const cors = require('cors');
const http = require('http');
const mongoose = require('mongoose');
const compression = require('compression');
const helmet = require('helmet');
const cluster = require('cluster');
const os = require('os');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');

const connectDB = require('./config/database');
const battleStatsRoutes = require('./routes/battleStats');
const serverBattleStatsRoutes = require('./routes/serverBattleStats');
const queue = require('./config/queue');
const metrics = require('./config/metrics');
const { initializeWebSocket } = require('./routes/websockets');
const { version } = require('./package.json');
const { setRedisClient } = require('./middleware/auth');

const numCPUs = process.env.WEB_CONCURRENCY || 1;
const port = process.env.PORT || 3000;

if (cluster.isPrimary && process.env.NODE_ENV === 'production') {
  console.log(`Головний процес ${process.pid} запущено`);
  console.log(`Запускаємо ${numCPUs} робочих процесів...`);

  for (let i = 0; i < numCPUs; i++) {
      cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
      console.log(`Робочий процес ${worker.process.pid} завершив роботу. Код: ${code}, сигнал: ${signal}.`);
      console.log('Запускаємо новий робочий процес...');
      cluster.fork();
  });
} else {
  const app = express();
  const server = http.createServer(app);

  class AppError extends Error {
      constructor(message, statusCode, code = null) {
          super(message);
          this.statusCode = statusCode;
          this.code = code;
          this.isOperational = true;
          Error.captureStackTrace(this, this.constructor);
      }
  }

  class ValidationError extends AppError {
      constructor(message, details = null) {
          super(message, 400, 'VALIDATION_ERROR');
          this.details = details;
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

  const allowedOrigins = [
      'https://underpressureph7.github.io'
  ];

  const serverCorsOptions = {
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Player-ID', 'X-API-Key', 'X-Secret-Key'],
      credentials: true,
      maxAge: 86400,
      preflightContinue: false,
      optionsSuccessStatus: 204
  };

  const httpCorsOptions = {
      origin: function (origin, callback) {

          console.log('CORS check: Received origin:', origin);
          console.log('CORS check: Allowed origins:', allowedOrigins);

          if (process.env.NODE_ENV !== 'production') {
              return callback(null, true);
          }
          if (!origin || allowedOrigins.includes(origin)) {
              return callback(null, true);
          }
          console.error(`CORS check: Origin ${origin} not allowed by CORS policy.`);
          callback(new Error(`Origin ${origin} not allowed by CORS policy`));
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Player-ID', 'X-API-Key', 'X-Secret-Key'],
      credentials: true,
      maxAge: 86400,
      preflightContinue: false,
      optionsSuccessStatus: 204
  };

  const socketCorsOptions = {
      origin: function (origin, callback) {
          if (!origin) return callback(null, true);
          if (process.env.NODE_ENV !== 'production') return callback(null, true);
          if (allowedOrigins.includes(origin)) return callback(null, true);
          callback(new Error(`WebSocket origin ${origin} not allowed`));
      },
      methods: ['GET', 'POST'],
      credentials: true
  };

  const io = new Server(server, {
      cors: socketCorsOptions,
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
      allowEIO3: true
  });

  const redisUrl = process.env.REDISCLOUD_URL || process.env.REDIS_URL;
  const redisClient = createClient({ url: redisUrl });

  setRedisClient(redisClient);

  const subClient = redisClient.duplicate();

  Promise.all([redisClient.connect(), subClient.connect()]).then(() => {
      io.adapter(createAdapter(redisClient, subClient));
      console.log(`Socket.IO Redis adapter for worker ${process.pid} connected.`);
  }).catch(err => {
      console.error(`Failed to connect Redis adapter for worker ${process.pid}:`, err);
      process.exit(1);
  });

  server.setTimeout(30000);
  server.keepAliveTimeout = 61000;
  server.headersTimeout = 62000;

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ contentSecurityPolicy: false }));

  app.use(compression({
      level: process.env.NODE_ENV === 'production' ? 9 : 1,
      threshold: '1kb',
      filter: (req, res) => !req.headers['x-no-compression']
  }));

  app.use(express.json({
      limit: process.env.NODE_ENV === 'production' ? '2mb' : '5mb',
      type: ['application/json', 'text/plain']
  }));

  app.use(express.urlencoded({
      limit: process.env.NODE_ENV === 'production' ? '2mb' : '5mb',
      extended: false,
      parameterLimit: 1000
  }));

  app.use(cors(httpCorsOptions));
  app.options('*', cors(httpCorsOptions));

  const sendErrorResponse = (res, error) => {
      const isDev = process.env.NODE_ENV === 'development';
      const statusCode = error.statusCode || 500;

      const response = {
          success: false,
          error: {
              code: error.code || 'UNKNOWN_ERROR',
              message: error.message,
              statusCode
          },
          timestamp: new Date().toISOString()
      };

      if (isDev && error.stack) response.error.stack = error.stack;
      if (error.details) response.error.details = error.details;

      res.status(statusCode).json(response);
  };

  const sendSuccessResponse = (res, data = {}, statusCode = 200) => {
      res.status(statusCode).json({
          success: true,
          data,
          timestamp: new Date().toISOString()
      });
  };

  app.get('/', (req, res) => {
      sendSuccessResponse(res, {
          message: 'Сервер працює!',
          version: version,
          environment: process.env.NODE_ENV,
          worker: process.pid
      });
  });

  app.get('/api/status', async (req, res) => {
      try {
          const memory = process.memoryUsage();
          const dynamicData = {
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
          };

          sendSuccessResponse(res, dynamicData);
      } catch (error) {
          sendErrorResponse(res, new ServerError('Status check failed'));
      }
  });

  app.get('/api/queue-status', (req, res) => {
      const successRate = metrics.totalRequests > 0
          ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)
          : '0';

      sendSuccessResponse(res, {
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

  app.use('/api/server', cors(serverCorsOptions), serverBattleStatsRoutes);
  app.use('/api/battle-stats', battleStatsRoutes);

  app.use((req, res, next) => {
      next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
  });

  app.use((error, req, res, next) => {
      if (process.env.NODE_ENV !== 'production') console.error('Error:', error);
      if (error.name === 'CorsError') return sendErrorResponse(res, new ValidationError('CORS policy violation'));
      if (error.type === 'entity.parse.failed') return sendErrorResponse(res, new ValidationError('Invalid JSON payload'));
      if (error.type === 'entity.too.large') return sendErrorResponse(res, new ValidationError('Request payload too large'));
      if (!error.isOperational) error = new ServerError();
      sendErrorResponse(res, error);
  });

  initializeWebSocket(io);

  const startServer = async () => {
      try {
          await connectDB();
          server.listen(port, () => {
              console.log(`🚀 Робочий процес ${process.pid} запущено на порту ${port}`);
          });
      } catch (error) {
          console.error(`Помилка запуску робочого процесу ${process.pid}:`, error);
          process.exit(1);
      }
  };

  startServer();

  const gracefulShutdown = async (signal) => {
      console.log(`Отримано сигнал ${signal} для робочого процесу ${process.pid}.`);
      server.close(async () => {
          console.log('HTTP-сервер закрито.');
          await mongoose.disconnect();
          console.log('MongoDB відключено.');
          if(redisClient.isOpen) await redisClient.quit();
          if(subClient.isOpen) await subClient.quit();
          console.log('Redis clients відключено.');
          cluster.worker.disconnect();
      });
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}