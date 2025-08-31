const express = require('express');
const router = express.Router();
const { validateKey } = require('../middleware/auth');
const battleStatsController = require('../controllers/battleStatsController');

// // Тестовий роут без валідації ключа
// router.get('/test', (req, res) => {
//     res.json({
//         status: 'ok',
//         message: 'Battle stats API працює!',
//         timestamp: new Date().toISOString(),
//         environment: process.env.NODE_ENV || 'development'
//     });
// });

router.post('/:key', (req, res, next) => {
    console.log(`🚀 REST POST updateStats для ключа: ${req.params.key}`);
    console.log(`📋 REST дані:`, JSON.stringify(req.body, null, 2));
    console.log(`⏰ Час отримання: ${new Date().toISOString()}`);
    next();
}, validateKey, battleStatsController.updateStats);
router.get('/:key', validateKey, battleStatsController.getStats);
router.get('/pid/:key', validateKey, battleStatsController.getOtherPlayersStats);
router.post('/import/:key', validateKey, battleStatsController.importStats);
router.get('/clear/:key', validateKey, battleStatsController.clearStats);
router.delete('/:key/:battleId', validateKey, battleStatsController.deleteBattle);
router.delete('/clear-database', battleStatsController.clearDatabase);

module.exports = router;
