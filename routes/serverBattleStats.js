const express = require('express');
const router = express.Router();
const { validateKey, validateSecretKey } = require('../middleware/auth');
const { serverCors } = require('../middleware/cors');
const battleStatsController = require('../controllers/battleStatsController');
const { version, name } = require('../package.json');

router.use(serverCors);
router.options('*', serverCors);

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

const logServerRequest = (req, res, next) => {
    const bodySize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
    console.log(`SERVER-TO-SERVER ${req.method} ${req.originalUrl}`);
    console.log(`Data size: ${bodySize} bytes`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log(`User-Agent: ${req.get('User-Agent')}`);
    console.log(`IP: ${req.ip}`);
    next();
};

const addServerHeaders = (req, res, next) => {
    res.set({
        'X-API-Version': version,
        'X-Powered-By': 'BattleStats-Server-API',
        'X-Request-ID': req.id || `srv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
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


router.post('/update-stats',
    addServerHeaders,
    logServerRequest,
    validateSecretKey,
    validateKey,
    asyncHandler(battleStatsController.updateStats)
);

router.get('/stats',
    addServerHeaders,
    validateSecretKey,
    validateKey,
    asyncHandler(battleStatsController.getStats)
);

router.get('/other-players',
    addServerHeaders,
    validateSecretKey,
    validateKey,
    asyncHandler(battleStatsController.getOtherPlayersStats)
);

router.post('/import',
    addServerHeaders,
    logServerRequest,
    validateSecretKey,
    validateKey,
    asyncHandler(battleStatsController.importStats)
);

router.delete('/clear',
    addServerHeaders,
    validateSecretKey,
    validateKey,
    asyncHandler(battleStatsController.clearStats)
);

router.delete('/battle/:battleId',
    addServerHeaders,
    validateSecretKey,
    validateKey,
    asyncHandler(battleStatsController.deleteBattle)
);

router.delete('/clear-database',
    addServerHeaders,
    validateSecretKey,
    asyncHandler(battleStatsController.clearDatabase)
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
        }));
    }
);

router.use('*', (req, res) => {
    const error = new Error(`Маршрут ${req.method} ${req.originalUrl} не знайдено`);
    error.status = 404;
    res.status(404).json(createErrorResponse(error, req));
});

router.use(errorHandler);

module.exports = router;