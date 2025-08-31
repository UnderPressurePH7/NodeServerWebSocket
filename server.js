const express = require('express');
const cors = require('cors');
const http = require('http');
const mongoose = require('mongoose');
const compression = require('compression');
const helmet = require('helmet');
const connectDB = require('./config/database');
const battleStatsRoutes = require('./routes/battleStats');
const queue = require('./config/queue');
const metrics = require('./config/metrics');
const { initializeWebSocket } = require('./routes/websockets');

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

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const port = process.env.PORT || 3000;

const corsOptions = {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Player-ID'],
    credentials: true,
    maxAge: 86400,
    preflightContinue: false,
    optionsSuccessStatus: 204
};

const io = new Server(server, {
    cors: corsOptions,
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
    allowEIO3: true
});

server.setTimeout(30000);
server.keepAliveTimeout = 61000;
server.headersTimeout = 62000;

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({ 
    contentSecurityPolicy: false 
}));

app.use(cors(corsOptions));

app.use(compression({ 
    level: process.env.NODE_ENV === 'production' ? 9 : 1, 
    threshold: '1kb',
    filter: (req, res) => {
        return req.headers['x-no-compression'] ? false : compression.filter(req, res);
    }
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

const statusCache = {
    static: { data: null, timestamp: 0, ttl: 300000 },
    dynamic: { data: null, timestamp: 0, ttl: 5000 }
};

if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
        console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
        next();
    });
}

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
    
    if (isDev && error.stack) {
        response.error.stack = error.stack;
    }
    
    if (error.details) {
        response.error.details = error.details;
    }
    
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
    res.set('Cache-Control', 'public, max-age=300');
    sendSuccessResponse(res, {
        message: 'Сервер працює!',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
    });
});

app.get('/api/status', async (req, res) => {
    try {
        const now = Date.now();
        
        let staticData = statusCache.static.data;
        if (!staticData || (now - statusCache.static.timestamp) > statusCache.static.ttl) {
            staticData = {
                version: '1.0.0',
                environment: process.env.NODE_ENV || 'development',
                nodeVersion: process.version,
                platform: process.platform
            };
            statusCache.static.data = staticData;
            statusCache.static.timestamp = now;
        }
        
        let dynamicData = statusCache.dynamic.data;
        if (!dynamicData || (now - statusCache.dynamic.timestamp) > statusCache.dynamic.ttl) {
            const memory = process.memoryUsage();
            dynamicData = {
                status: 'ok',
                database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
                uptime: Math.floor(process.uptime()),
                memory: {
                    heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
                    heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
                },
                connections: {
                    websocket: io.engine.clientsCount,
                    total: io.engine.clientsCount
                }
            };
            statusCache.dynamic.data = dynamicData;
            statusCache.dynamic.timestamp = now;
        }

        res.set('Cache-Control', 'public, max-age=5');
        sendSuccessResponse(res, { ...staticData, ...dynamicData });
    } catch (error) {
        sendErrorResponse(res, new ServerError('Status check failed'));
    }
});

app.get('/api/queue-status', (req, res) => {
    const successRate = metrics.totalRequests > 0 
        ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)
        : '0';

    res.set('Cache-Control', 'public, max-age=2');
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

app.use('/api/battle-stats', battleStatsRoutes);

app.use((req, res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
});

app.use((error, req, res, next) => {
    if (process.env.NODE_ENV !== 'production') {
        console.error('Error:', error);
    }
    
    if (error.name === 'CorsError') {
        return sendErrorResponse(res, new ValidationError('CORS policy violation'));
    }
    
    if (error.type === 'entity.parse.failed') {
        return sendErrorResponse(res, new ValidationError('Invalid JSON payload'));
    }
    
    if (error.type === 'entity.too.large') {
        return sendErrorResponse(res, new ValidationError('Request payload too large'));
    }
    
    if (!error.isOperational) {
        error = new ServerError();
    }
    
    sendErrorResponse(res, error);
});

initializeWebSocket(io);

let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\nОтримано сигнал ${signal}. Починаю graceful shutdown...`);

    const shutdownTimeout = setTimeout(() => {
        console.error('Примусове завершення через таймаут.');
        process.exit(1);
    }, 25000);

    try {
        if (io && typeof io.close === 'function') {
            try {
                await new Promise((resolve) => {
                    io.close((err) => {
                        if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
                            console.error('Помилка при закритті Socket.IO:', err.message);
                        } else {
                            console.log('Socket.IO сервер закрито.');
                        }
                        resolve();
                    });
                });
            } catch (ioError) {
                console.log('Socket.IO вже закрито або недоступне.');
            }
        }

        if (server.listening) {
            await new Promise((resolve) => {
                server.close((err) => {
                    if (err) {
                        console.error('Помилка при закритті HTTP сервера:', err.message);
                    } else {
                        console.log('HTTP-сервер закрито.');
                    }
                    resolve();
                });
            });
        } else {
            console.log('HTTP-сервер вже закрито.');
        }

        if (queue && (queue.size > 0 || queue.pending > 0)) {
            console.log(`Очікування завершення ${queue.size + queue.pending} завдань...`);
            await Promise.race([
                queue.onIdle(),
                new Promise(resolve => setTimeout(resolve, 8000))
            ]);
            console.log('Черга завдань оброблена.');
        }

        try {
            await mongoose.disconnect();
            console.log('MongoDB відключено.');
        } catch (mongoError) {
            console.error('Помилка при відключенні MongoDB:', mongoError.message);
        }
        
        clearTimeout(shutdownTimeout);
        console.log('Сервер успішно зупинено.');
        process.exit(0);

    } catch (error) {
        console.error('Помилка під час shutdown:', error);
        clearTimeout(shutdownTimeout);
        process.exit(1);
    }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    if (process.env.NODE_ENV === 'production' && !isShuttingDown) {
        gracefulShutdown('UNHANDLED_REJECTION');
    }
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    if (!isShuttingDown) {
        gracefulShutdown('UNCAUGHT_EXCEPTION');
    }
});

const startServer = async () => {
    try {
        console.log('Підключення до бази даних...');
        await connectDB();
        console.log('База даних підключена успішно!');
        
        server.listen(port, () => {
            console.log(`🚀 Сервер запущено на порту ${port}`);
            console.log(`📦 Режим: ${process.env.NODE_ENV || 'development'}`);
            console.log(`🆔 PID: ${process.pid}`);
        });

    } catch (error) {
        console.error('Помилка запуску сервера:', error);
        process.exit(1);
    }
};

startServer();

module.exports = { app, server, io };