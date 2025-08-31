const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const http = require('http');
const mongoose = require('mongoose');
const compression = require('compression');
const helmet = require('helmet')
const connectDB = require('./config/database');
const battleStatsRoutes = require('./routes/battleStats');
const queue = require('./config/queue');
const metrics = require('./config/metrics');
const { initializeWebSocket } = require('./routes/websockets');

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const port = process.env.PORT || 3000;

const allowedOrigins = [
    'https://underpressureph7.github.io',
    'https://juniorapi.github.io'
];

const io = new Server(server, {
    cors: {
        origin: function (origin, callback) {
            if (!origin || process.env.NODE_ENV !== 'production') {
                callback(null, true);
            } else if (allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(null, false);
            }
        },
        methods: ["GET", "POST"],
        credentials: true
    },
    // Налаштування для Heroku
    transports: ['websocket', 'polling'], 
    pingTimeout: 60000,
    pingInterval: 25000,
    allowEIO3: true
});

server.setTimeout(30000); // Heroku має 30-секундний тайм-аут
server.keepAliveTimeout = 61000; // Heroku Load Balancer тайм-аут 60s
server.headersTimeout = 62000; // Більше ніж keepAliveTimeout

app.set('trust proxy', 1);
app.disable('x-powered-by');

const corsOptions = {
    origin: function (origin, callback) {
        console.log('CORS request from origin:', origin);
        if (!origin || process.env.NODE_ENV !== 'production') {
            // Дозволити всі запити у dev або без origin (наприклад, curl)
            callback(null, true);
        } else if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.log('CORS blocked origin:', origin);
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Player-ID'],
    credentials: true,
    maxAge: 86400,
    preflightContinue: false,
    optionsSuccessStatus: 204
};

// Middleware з Heroku-оптимізацією
app.use(helmet({ 
    contentSecurityPolicy: false,
}));
app.use(cors(corsOptions));
app.use(compression({ 
    level: process.env.NODE_ENV === 'production' ? 9 : 1, // Максимальне стиснення в продакшн
    threshold: '1kb', // Не стискати відповіді менше 1kb
    filter: (req, res) => {
        if (req.headers['x-no-compression']) {
            // не стискати, якщо є цей заголовок
            return false;
        }
        return compression.filter(req, res);
    }
}));

// Оптимізований парсер JSON для Heroku
app.use(express.json({ 
    limit: process.env.NODE_ENV === 'production' ? '2mb' : '5mb', // Менший ліміт у продакшн
    type: ['application/json', 'text/plain']
}));
app.use(express.urlencoded({ 
    limit: process.env.NODE_ENV === 'production' ? '2mb' : '5mb',
    extended: false, 
    parameterLimit: 1000
}));

// Кешування для статичних відповідей
const statusCache = {
    data: null,
    timestamp: 0,
    ttl: 5000
};

if (process.env.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
        console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
        next();
    });
}

app.get('/', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({
        message: 'Сервер працює!',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development'
    });
});

app.get('/api/status', async (req, res) => {
    try {
        const now = Date.now();
        
        if (statusCache.data && (now - statusCache.timestamp) < statusCache.ttl) {
            return res.json(statusCache.data);
        }

        const isConnected = mongoose.connection.readyState === 1;
        const memory = process.memoryUsage();
        
        const statusData = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            database: isConnected ? 'connected' : 'disconnected',
            uptime: Math.floor(process.uptime()),
            queue: {
                size: queue.size,
                pending: queue.pending,
                isPaused: queue.isPaused
            },
            memory: {
                heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
                heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
            }
        };

        statusCache.data = statusData;
        statusCache.timestamp = now;

        res.set('Cache-Control', 'public, max-age=5');
        res.json(statusData);
    } catch (error) {
        console.error('Status check error:', error);
        res.status(500).json({
            status: 'error',
            message: 'Internal server error',
            timestamp: new Date().toISOString()
        });
    }
});

app.get('/api/queue-status', (req, res) => {
    const successRate = metrics.totalRequests > 0 
        ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)
        : '0';

    res.set('Cache-Control', 'public, max-age=2');
    res.json({
        queueSize: queue.size,
        pendingCount: queue.pending,
        isPaused: queue.isPaused,
        metrics: {
            totalRequests: metrics.totalRequests,
            successfulRequests: metrics.successfulRequests,
            failedRequests: metrics.failedRequests,
            successRate: `${successRate}%`
        }
    });
});

// Routes
app.use('/api/battle-stats', battleStatsRoutes);

// Оптимізований error handler
app.use((err, req, res, next) => {
    if (process.env.NODE_ENV !== 'production') {
        console.error('Error:', err.stack);
    }
    
    res.status(err.status || 500).json({
        error: err.status === 404 ? 'Not Found' : 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Щось пішло не так!'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: 'Маршрут не знайдено',
        path: req.path
    });
});

// Ініціалізація WebSocket
initializeWebSocket(io);

let isShuttingDown = false;

// Heroku-оптимізований graceful shutdown
const gracefulShutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`\nОтримано сигнал ${signal}. Починаю коректну зупинку...`);

    server.close(async () => {
        console.log('HTTP-сервер закрито. Нові запити не приймаються.');

        try {
            if (queue.size > 0 || queue.pending > 0) {
                console.log(`Очікування завершення ${queue.size} завдань у черзі...`);
                await queue.onIdle();
                console.log('Всі завдання в черзі завершено.');
            }

            await mongoose.disconnect();
            console.log('З\'єднання з MongoDB закрито.');
            
            console.log('Сервер успішно зупинено.');
            process.exit(0);
        } catch (error) {
            console.error('Помилка під час зупинки:', error);
            process.exit(1);
        }
    });

    // Примусова зупинка через 10 секунд, якщо щось пішло не так
    setTimeout(() => {
        console.error('Не вдалося коректно зупинити сервер за 10 секунд. Примусова зупинка.');
        process.exit(1);
    }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const startServer = async () => {
    try {
        console.log('Спроба підключення до бази даних...');
        await connectDB();
        console.log('База даних підключена успішно!');
        
        server.listen(port, () => {
            console.log(`Сервер запущено на порту ${port}`);
            console.log(`Режим: ${process.env.NODE_ENV || 'development'}`);
            console.log(`PID: ${process.pid}`);
            console.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
        });

    } catch (error) {
        console.error('Помилка запуску сервера:', error);
        process.exit(1);
    }
}

startServer();

module.exports = app;
