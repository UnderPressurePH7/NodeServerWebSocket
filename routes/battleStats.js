const express = require('express');
const router = express.Router();
const { validateKey, validateSecretKey } = require('../middleware/auth');
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
    console.log(`CLIENT API ${req.method} ${req.originalUrl}`);
    console.log(`Data size: ${JSON.stringify(req.body).length} bytes`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`User-Agent: ${req.get('User-Agent')}`);
    console.log(`IP: ${req.ip}`);
    next();
};

const addServerHeaders = (req, res, next) => {
    const origin = req.get('origin');
    
    res.set({
        'X-API-Version': API_VERSION,
        'X-Powered-By': 'BattleStats-Client-API',
        'X-Request-ID': req.id || `cli_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    
    if (origin && (process.env.NODE_ENV !== 'production' || 
        ['https://underpressureph7.github.io', 'https://underpressureph7.github.io/Widget_2.0'].includes(origin))) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Access-Control-Allow-Credentials', 'true');
        res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type,X-Player-ID,X-API-Key,X-Secret-Key,Authorization');
    } else if (process.env.NODE_ENV !== 'production') {
        res.set('Access-Control-Allow-Origin', '*');
    }
    
    next();
};

const extractKeyFromRequest = (req, res, next) => {
    req.params.key = req.apiKey;
    next();
};

const errorHandler = (error, req, res, next) => {
    console.error('Client API error:', error);
    res.status(error.status || 500).json(createErrorResponse(error, req));
};

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

router.post('/update-stats',
    addServerHeaders,
    logServerRequest,
    validateKey,
    extractKeyFromRequest,
    asyncHandler(async (req, res) => {
        await battleStatsController.updateStats(req, res);
    })
);

router.get('/stats',
    addServerHeaders,
    validateKey,
    extractKeyFromRequest,
    asyncHandler(async (req, res) => {
        await battleStatsController.getStats(req, res);
    })
);

router.get('/other-players',
    addServerHeaders,
    validateKey,
    extractKeyFromRequest,
    asyncHandler(async (req, res) => {
        await battleStatsController.getOtherPlayersStats(req, res);
    })
);

router.post('/import',
    addServerHeaders,
    logServerRequest,
    validateKey,
    extractKeyFromRequest,
    asyncHandler(async (req, res) => {
        await battleStatsController.importStats(req, res);
    })
);

router.delete('/clear',
    addServerHeaders,
    validateKey,
    extractKeyFromRequest,
    asyncHandler(async (req, res) => {
        await battleStatsController.clearStats(req, res);
    })
);

router.delete('/battle/:battleId',
    addServerHeaders,
    validateKey,
    extractKeyFromRequest,
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
    addServerHeaders,
    (req, res) => {
        res.status(200).json(createSuccessResponse({
            version: API_VERSION,
            name: name,
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