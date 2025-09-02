const express = require('express');
const router = express.Router();
const { validateSecretKey } = require('../middleware/auth');
const battleStatsController = require('../controllers/battleStatsController');
const { version, name } = require('../package.json');

const API_VERSION = version;

const createErrorResponse = (error, req) => {
    const response = {
        error: error.name || 'Unknown Error',
        message: error.message,
        timestamp: new Date().toISOString(),
        path: req.originalUrl
    };

    if (error.code) {
        response.code = error.code;
    }

    if (process.env.NODE_ENV === 'development' && error.stack) {
        response.stack = error.stack;
    }

    return response;
};

const createSuccessResponse = (data, meta = {}) => {
    return {
        success: true,
        timestamp: new Date().toISOString(),
        version: API_VERSION,
        ...data,
        ...meta
    };
};

const logServerRequest = (req, res, next) => {
    console.log(`SERVER-TO-SERVER ${req.method} ${req.originalUrl}`);
    console.log(`Data size: ${JSON.stringify(req.body).length} bytes`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`User-Agent: ${req.get('User-Agent')}`);
    console.log(`IP: ${req.ip}`);
    next();
};

const addServerHeaders = (req, res, next) => {
    res.set({
        'X-API-Version': API_VERSION,
        'X-Powered-By': 'BattleStats-Server-API',
        'X-Request-ID': req.id || `srv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    });
    next();
};

const errorHandler = (error, req, res, next) => {
    console.error('Server-to-server error:', error);
    res.status(error.status || 500).json(createErrorResponse(error, req));
};

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

const validateApiKeyHeader = (req, res, next) => {
    const VALID_KEYS = require('../config/validKey');
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'Відсутній X-API-Key в заголовках запиту'
        });
    }
    
    if (!VALID_KEYS.includes(apiKey)) {
        return res.status(400).json({
            error: 'Bad Request',
            message: 'Невалідний API ключ'
        });
    }
    
    req.params.key = apiKey;
    next();
};

router.post('/update-stats',
    addServerHeaders,
    logServerRequest,
    validateSecretKey,
    validateApiKeyHeader,
    asyncHandler(async (req, res) => {
        await battleStatsController.updateStats(req, res);
    })
);

router.get('/stats',
    addServerHeaders,
    validateSecretKey,
    validateApiKeyHeader,
    asyncHandler(async (req, res) => {
        await battleStatsController.getStats(req, res);
    })
);

router.get('/other-players',
    addServerHeaders,
    validateSecretKey,
    validateApiKeyHeader,
    asyncHandler(async (req, res) => {
        await battleStatsController.getOtherPlayersStats(req, res);
    })
);

router.post('/import',
    addServerHeaders,
    logServerRequest,
    validateSecretKey,
    validateApiKeyHeader,
    asyncHandler(async (req, res) => {
        await battleStatsController.importStats(req, res);
    })
);

router.delete('/clear',
    addServerHeaders,
    validateSecretKey,
    validateApiKeyHeader,
    asyncHandler(async (req, res) => {
        await battleStatsController.clearStats(req, res);
    })
);

router.delete('/battle/:battleId',
    addServerHeaders,
    validateSecretKey,
    validateApiKeyHeader,
    asyncHandler(async (req, res) => {
        await battleStatsController.deleteBattle(req, res);
    })
);

router.delete('/clear-database',
    addServerHeaders,
    validateSecretKey,
    asyncHandler(async (req, res) => {
        await battleStatsController.clearDatabase(req, res);
    })
);

router.get('/health',
    addServerHeaders,
    (req, res) => {
        res.status(200).json(createSuccessResponse({
            status: 'healthy',
            type: 'server-to-server',
            uptime: Math.floor(process.uptime()),
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
            }
        }));
    }
);

router.get('/version',
    addServerHeaders,
    (req, res) => {
        res.status(200).json(createSuccessResponse({
            version: API_VERSION,
            name: name,
            description: 'Server-to-server API для статистики боїв',
            authentication: 'X-Secret-Key header required',
            endpoints: [
                'POST /update-stats - Оновлення статистики (X-API-Key + X-Player-ID заголовки)',
                'GET /stats - Отримання статистики (X-API-Key заголовок)',
                'GET /other-players - Статистика інших гравців (X-API-Key + X-Player-ID заголовки)',
                'POST /import - Імпорт даних (X-API-Key заголовок)',
                'DELETE /clear - Очищення статистики (X-API-Key заголовок)',
                'DELETE /battle/:battleId - Видалення бою (X-API-Key заголовок)',
                'DELETE /clear-database - Очищення БД',
                'GET /health - Стан сервера',
                'GET /version - Інформація про API'
            ]
        }));
    }
);

router.use('*', (req, res) => {
    const error = new Error(`Server-to-server маршрут ${req.method} ${req.originalUrl} не знайдено`);
    error.status = 404;
    res.status(404).json(createErrorResponse(error, req));
});

router.use(errorHandler);

module.exports = router;