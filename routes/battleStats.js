const express = require('express');
const router = express.Router();
const { validateKey } = require('../middleware/auth');
const battleStatsController = require('../controllers/battleStatsController');

const logRequest = (req, res, next) => {
    console.log(`🚀 REST ${req.method} ${req.originalUrl} для ключа: ${req.params.key}`);
    console.log(`📋 REST дані:`, JSON.stringify(req.body, null, 2));
    console.log(`⏰ Час отримання: ${new Date().toISOString()}`);
    console.log(`🌐 User-Agent: ${req.get('User-Agent')}`);
    console.log(`📍 IP: ${req.ip}`);
    next();
};

const addCommonHeaders = (req, res, next) => {
    if (req.method === 'GET') {
        res.set('Cache-Control', 'public, max-age=5');
    } else {
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
    
    res.set('X-API-Version', '1.0.0');
    res.set('X-Powered-By', 'BattleStats-API');
    next();
};

router.get('/debug-test', addCommonHeaders, (req, res) => {
    res.json({
        status: 'ok',
        message: 'Battle stats API працює!',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
        version: '1.0.0'
    });
});

router.post('/:key', 
    addCommonHeaders,
    logRequest, 
    validateKey, 
    battleStatsController.updateStats
);

router.get('/:key', 
    addCommonHeaders,
    validateKey, 
    battleStatsController.getStats
);

router.get('/pid/:key', 
    addCommonHeaders,
    validateKey, 
    battleStatsController.getOtherPlayersStats
);

router.post('/import/:key', 
    addCommonHeaders,
    logRequest,
    validateKey, 
    battleStatsController.importStats
);

router.get('/clear/:key', 
    addCommonHeaders,
    validateKey, 
    battleStatsController.clearStats
);

router.delete('/:key/:battleId', 
    addCommonHeaders,
    validateKey, 
    battleStatsController.deleteBattle
);

router.delete('/clear-database', 
    addCommonHeaders,
    battleStatsController.clearDatabase
);

router.get('/health', addCommonHeaders, (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
        }
    });
});

router.get('/version', addCommonHeaders, (req, res) => {
    res.status(200).json({
        version: '1.0.0',
        name: 'BattleStats API',
        description: 'API для збереження та отримання статистики боїв',
        endpoints: [
            'POST /:key - Оновлення статистики',
            'GET /:key - Отримання статистики',
            'GET /pid/:key - Статистика інших гравців',
            'POST /import/:key - Імпорт даних',
            'GET /clear/:key - Очищення статистики',
            'DELETE /:key/:battleId - Видалення бою',
            'DELETE /clear-database - Очищення БД'
        ]
    });
});

router.use('*', (req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Маршрут ${req.method} ${req.originalUrl} не знайдено`,
        availableEndpoints: [
            'POST /api/battle-stats/:key',
            'GET /api/battle-stats/:key',
            'GET /api/battle-stats/pid/:key',
            'POST /api/battle-stats/import/:key',
            'GET /api/battle-stats/clear/:key',
            'DELETE /api/battle-stats/:key/:battleId',
            'DELETE /api/battle-stats/clear-database'
        ]
    });});

module.exports = router;