const express = require('express');
const router = express.Router();
const { validateKey, validateSecretKey } = require('../middleware/auth');
const { clientCors } = require('../middleware/cors');
const battleStatsController = require('../controllers/battleStatsController');
const { version, name } = require('../package.json');

const createErrorResponse = (error, req) => ({
    error: error.name || 'Unknown Error',
    message: error.message,
    timestamp: new Date().toISOString(),
    path: req.originalUrl,
    ...(error.code ? { code: error.code } : {}),
    ...(process.env.NODE_ENV === 'development' && error.stack ? { stack: error.stack } : {})
});

const createSuccessResponse = (data, meta = {}) => ({
    success: true,
    timestamp: new Date().toISOString(),
    version,
    ...data,
    ...meta
});

const logClientRequest = (req, res, next) => {
    if (req.method === 'OPTIONS') {
        return next();
    }
    const bodySize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
    console.log(`CLIENT API ${req.method} ${req.originalUrl}`);
    console.log(`Data size: ${bodySize} bytes`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`User-Agent: ${req.get('User-Agent')}`);
    console.log(`IP: ${req.ip}`);
    next();
};

const addClientHeaders = (req, res, next) => {
    res.set({
        'X-API-Version': version,
        'X-Powered-By': 'BattleStats-Client-API',
        'X-Request-ID': req.id || `cli_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    next();
};

const errorHandler = (error, req, res, next) => {
    console.error('Client API error:', error);
    res.status(error.status || 500).json(createErrorResponse(error, req));
};

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

router.use(clientCors);

router.post('/update-stats',
    addClientHeaders,
    logClientRequest,
    validateKey,
    asyncHandler(battleStatsController.updateStats)
);

router.get('/stats',
    addClientHeaders,
    validateKey,
    asyncHandler(battleStatsController.getStats)
);

router.get('/other-players',
    addClientHeaders,
    validateKey,
    asyncHandler(battleStatsController.getOtherPlayersStats)
);

router.post('/import',
    addClientHeaders,
    logClientRequest,
    validateKey,
    asyncHandler(battleStatsController.importStats)
);

router.delete('/clear',
    addClientHeaders,
    validateKey,
    asyncHandler(battleStatsController.clearStats)
);

router.delete('/battle/:battleId',
    addClientHeaders,
    validateKey,
    asyncHandler(battleStatsController.deleteBattle)
);

router.delete('/clear-database',
    addClientHeaders,
    validateSecretKey, 
    asyncHandler(battleStatsController.clearDatabase)
);

router.get('/health',
    addClientHeaders,
    (req, res) => {
        res.status(200).json(createSuccessResponse({
            status: 'healthy',
            type: 'client-api',
            uptime: Math.floor(process.uptime()),
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
            }
        }));
    }
);

router.get('/version',
    addClientHeaders,
    (req, res) => {
        res.status(200).json(createSuccessResponse({
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
        }));
    }
);

router.use('*', (req, res) => {
    const error = new Error(`Client API маршрут ${req.method} ${req.originalUrl} не знайдено`);
    error.status = 404;
    res.status(404).json(createErrorResponse(error, req));
});

router.use(errorHandler);

module.exports = router;