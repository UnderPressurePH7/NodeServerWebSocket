const express = require('express');
const router = express.Router();
const { validateKey } = require('../middleware/auth');
const battleStatsController = require('../controllers/battleStatsController');
const { version } = require('../package.json');

const API_VERSION = version;

const CACHE_POLICIES = {
    static: 'public, max-age=300',
    dynamic: 'public, max-age=5',
    noCache: 'no-cache, no-store, must-revalidate',
    shortLived: 'public, max-age=2'
};

class APIError extends Error {
    constructor(message, status = 500, code = null) {
        super(message);
        this.name = 'APIError';
        this.status = status;
        this.code = code;
    }
}

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

const logRequest = (req, res, next) => {
    console.log(`REST ${req.method} ${req.originalUrl}`);
    console.log(`Data size: ${JSON.stringify(req.body).length} bytes`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`User-Agent: ${req.get('User-Agent')}`);
    console.log(`IP: ${req.ip}`);
    next();
};

const setCachePolicy = (policy) => (req, res, next) => {
    res.set('Cache-Control', CACHE_POLICIES[policy] || CACHE_POLICIES.noCache);
    next();
};

const addCommonHeaders = (req, res, next) => {
    res.set({
        'X-API-Version': API_VERSION,
        'X-Powered-By': 'BattleStats-API',
        'X-Request-ID': req.id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    });
    next();
};

const errorHandler = (error, req, res, next) => {
    if (error instanceof APIError) {
        return res.status(error.status).json(createErrorResponse(error, req));
    }

    if (error.name === 'ValidationError') {
        const apiError = new APIError('Помилка валідації даних', 400, 'VALIDATION_ERROR');
        return res.status(400).json(createErrorResponse(apiError, req));
    }

    if (error.name === 'CastError') {
        const apiError = new APIError('Невірний формат даних', 400, 'CAST_ERROR');
        return res.status(400).json(createErrorResponse(apiError, req));
    }

    console.error('Unhandled error:', error);
    const apiError = new APIError('Внутрішня помилка сервера', 500, 'INTERNAL_ERROR');
    res.status(500).json(createErrorResponse(apiError, req));
};

const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

const injectApiKey = (req, res, next) => {
    req.params.key = req.apiKey;
    next();
};

router.get('/debug-test', 
    addCommonHeaders, 
    setCachePolicy('static'), 
    (req, res) => {
        res.json(createSuccessResponse({
            message: 'Battle stats API працює!',
            environment: process.env.NODE_ENV || 'development'
        }));
    }
);

router.post('/', 
    addCommonHeaders,
    setCachePolicy('noCache'),
    logRequest, 
    validateKey,
    injectApiKey,
    asyncHandler(async (req, res) => {
        await battleStatsController.updateStats(req, res);
    })
);

router.get('/', 
    addCommonHeaders,
    setCachePolicy('dynamic'),
    validateKey,
    injectApiKey,
    asyncHandler(async (req, res) => {
        await battleStatsController.getStats(req, res);
    })
);

router.get('/other-players', 
    addCommonHeaders,
    setCachePolicy('dynamic'),
    validateKey,
    injectApiKey,
    asyncHandler(async (req, res) => {
        await battleStatsController.getOtherPlayersStats(req, res);
    })
);

router.post('/import', 
    addCommonHeaders,
    setCachePolicy('noCache'),
    logRequest,
    validateKey,
    injectApiKey,
    asyncHandler(async (req, res) => {
        await battleStatsController.importStats(req, res);
    })
);

router.delete('/clear', 
    addCommonHeaders,
    setCachePolicy('noCache'),
    validateKey,
    injectApiKey,
    asyncHandler(async (req, res) => {
        await battleStatsController.clearStats(req, res);
    })
);

router.delete('/battle/:battleId', 
    addCommonHeaders,
    setCachePolicy('noCache'),
    validateKey,
    injectApiKey,
    asyncHandler(async (req, res) => {
        await battleStatsController.deleteBattle(req, res);
    })
);

router.delete('/clear-database', 
    addCommonHeaders,
    setCachePolicy('noCache'),
    asyncHandler(async (req, res) => {
        await battleStatsController.clearDatabase(req, res);
    })
);

router.get('/health', 
    addCommonHeaders, 
    setCachePolicy('shortLived'), 
    (req, res) => {
        res.status(200).json(createSuccessResponse({
            status: 'healthy',
            uptime: Math.floor(process.uptime()),
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
            }
        }));
    }
);

router.get('/version', 
    addCommonHeaders, 
    setCachePolicy('static'), 
    (req, res) => {
        res.status(200).json(createSuccessResponse({
            version: API_VERSION,
            name: 'BattleStats API',
            description: 'API для збереження та отримання статистики боїв',
            endpoints: [
                'POST / - Оновлення статистики (API key в заголовку)',
                'GET / - Отримання статистики',
                'GET /other-players - Статистика інших гравців',
                'POST /import - Імпорт даних',
                'DELETE /clear - Очищення статистики',
                'DELETE /battle/:battleId - Видалення бою',
                'DELETE /clear-database - Очищення БД'
            ]
        }));
    }
);

router.use('*', (req, res) => {
    const error = new APIError(`Маршрут ${req.method} ${req.originalUrl} не знайдено`, 404, 'ROUTE_NOT_FOUND');
    res.status(404).json(createErrorResponse(error, req));
});

router.use(errorHandler);

module.exports = router;