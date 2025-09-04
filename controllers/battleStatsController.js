const battleStatsService = require('../services/battleStatsService');
const { queue, isQueueFull } = require('../config/queue');
const metrics = require('../config/metrics');

const battleStatsController = {
    updateStats: (req, res) => {
        console.log('📥 UPDATE-STATS запит отримано:', {
            timestamp: new Date().toISOString(),
            key: req.params.key,
            playerId: req.headers['x-player-id'],
            bodySize: JSON.stringify(req.body).length,
            hasBody: !!req.body,
            bodyKeys: Object.keys(req.body || {}),
            method: req.method,
            url: req.url,
            headers: {
                'content-type': req.headers['content-type'],
                'x-api-key': req.headers['x-api-key'] ? 'SET' : 'NOT SET',
                'x-player-id': req.headers['x-player-id'] ? 'SET' : 'NOT SET'
            }
        });

        if (isQueueFull()) {
            console.log('❌ Черга переповнена');
            return res.status(503).json({
                error: 'Service Unavailable',
                message: 'Сервер перевантажено, спробуйте пізніше',
            });
        }

        const key = req.params.key;
        const playerId = req.headers['x-player-id'];

        console.log('🔍 Параметри запиту:', {
            key: key,
            playerId: playerId,
            keyFromParams: req.params.key,
            playerIdFromHeaders: req.headers['x-player-id']
        });

        if (!playerId) {
            console.log('❌ Відсутній Player ID в заголовках:', req.headers);
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Відсутній ID гравця в заголовку запиту (X-Player-ID)',
            });
        }

        metrics.totalRequests++;
        console.log('✅ Запит додано до черги, розмір черги:', queue.size);
        console.log('📊 Поточні метрики:', {
            totalRequests: metrics.totalRequests,
            successfulRequests: metrics.successfulRequests,
            failedRequests: metrics.failedRequests,
            queueSize: queue.size
        });
        
        res.status(202).json({
            success: true,
            message: 'Запит прийнято на обробку',
            queueSize: queue.size
        });

        console.log('🔄 Додаємо завдання в чергу...');
        queue.add(async () => {
            console.log('🔄 Почалася асинхронна обробка:', { 
                key, 
                playerId,
                timestamp: new Date().toISOString(),
                queuePending: queue.pending,
                queueSize: queue.size
            });
            try {
                const result = await battleStatsService.processDataAsync(key, playerId, req.body);
                console.log('✅ Асинхронна обробка завершена:', { 
                    key, 
                    playerId, 
                    result,
                    timestamp: new Date().toISOString()
                });
                if (result) {
                    metrics.successfulRequests++;
                    console.log('✅ Успішний запит, оновлені метрики:', {
                        totalRequests: metrics.totalRequests,
                        successfulRequests: metrics.successfulRequests
                    });
                } else {
                    console.log('⚠️ Обробка повернула false');
                    metrics.failedRequests++;
                    console.log('⚠️ Невдалий запит, оновлені метрики:', {
                        totalRequests: metrics.totalRequests,
                        failedRequests: metrics.failedRequests
                    });
                }
            } catch (error) {
                console.error('❌ Помилка асинхронної обробки:', {
                    key,
                    playerId,
                    error: error.message,
                    stack: error.stack,
                    timestamp: new Date().toISOString()
                });
                metrics.failedRequests++;
            }
        }).catch(err => {
            console.error('❌ Помилка в черзі:', {
                key,
                playerId,
                error: err.message,
                stack: err.stack,
                timestamp: new Date().toISOString()
            });
            metrics.failedRequests++;
        });

        console.log('📤 Відповідь 202 надіслана, асинхронна обробка почалась');
    },

    getStats: async (req, res) => {
        console.log('📤 GET-STATS запит отримано:', {
            timestamp: new Date().toISOString(),
            key: req.params.key,
            page: req.query.page,
            limit: req.query.limit,
            url: req.url,
            method: req.method
        });

        try {
            const key = req.params.key;
            const page = parseInt(req.query.page) || 1;
            const limit = req.query.limit !== undefined ? parseInt(req.query.limit) : 10;

            console.log('🔍 Параметри GET-STATS:', { key, page, limit });

            const result = await battleStatsService.getStats(key, page, limit);
            
            console.log('✅ GET-STATS результат отримано:', {
                key,
                success: result.success,
                hasBattleStats: !!result.BattleStats,
                hasPlayerInfo: !!result.PlayerInfo,
                battleStatsKeys: Object.keys(result.BattleStats || {}),
                playerInfoKeys: Object.keys(result.PlayerInfo || {}),
                battleStatsCount: Object.keys(result.BattleStats || {}).length,
                playerInfoCount: Object.keys(result.PlayerInfo || {}).length,
                timestamp: new Date().toISOString()
            });
            
            res.status(200).json(result);
            console.log('📤 GET-STATS відповідь надіслана');
        } catch (error) {
            console.error('❌ Помилка при завантаженні даних:', {
                key: req.params.key,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Помилка при завантаженні даних'
            });
        }
    },

    getOtherPlayersStats: async (req, res) => {
        console.log('📤 GET-OTHER-PLAYERS запит отримано:', {
            timestamp: new Date().toISOString(),
            key: req.params.key,
            playerId: req.headers['x-player-id']
        });

        try {
            const key = req.params.key;
            const excludePlayerId = req.headers['x-player-id'];

            if (!excludePlayerId) {
                console.log('❌ Відсутній Player ID для GET-OTHER-PLAYERS');
                return res.status(400).json({
                    success: false,
                    message: 'Відсутній ID гравця в заголовку запиту (X-Player-ID)'
                });
            }

            console.log('🔍 Параметри GET-OTHER-PLAYERS:', { key, excludePlayerId });

            const result = await battleStatsService.getOtherPlayersStats(key, excludePlayerId);
            
            console.log('✅ GET-OTHER-PLAYERS результат:', {
                key,
                excludePlayerId,
                success: result.success,
                battleStatsCount: Object.keys(result.BattleStats || {}).length,
                timestamp: new Date().toISOString()
            });
            
            res.status(200).json(result);
        } catch (error) {
            console.error('❌ Помилка при завантаженні даних інших гравців:', {
                key: req.params.key,
                excludePlayerId: req.headers['x-player-id'],
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Помилка при завантаженні даних інших гравців'
            });
        }
    },

    importStats: async (req, res) => {
        const key = req.params.key;

        console.log('📥 IMPORT-STATS запит отримано:', {
            timestamp: new Date().toISOString(),
            key: key,
            bodySize: JSON.stringify(req.body).length,
            hasBody: !!req.body,
            bodyKeys: Object.keys(req.body || {})
        });

        res.status(202).json({
            success: true,
            message: 'Запит на імпорт прийнято'
        });

        try {
            console.log('🔄 Початок імпорту даних для ключа:', key);
            await battleStatsService.importStats(key, req.body);
            console.log('✅ Імпорт даних завершено для ключа:', key);
        } catch (error) {
            console.error('❌ Помилка при імпорті даних:', {
                key: key,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
        }
    },

    clearStats: async (req, res) => {
        const key = req.params.key;
        
        console.log('🗑️ CLEAR-STATS запит отримано:', {
            timestamp: new Date().toISOString(),
            key: key
        });

        res.status(200).json({
            success: true,
            message: `Запит на очищення даних для ключа ${key} прийнято`
        });

        try {
            console.log('🔄 Початок очищення даних для ключа:', key);
            await battleStatsService.clearStats(key);
            console.log('✅ Очищення даних завершено для ключа:', key);
        } catch (error) {
            console.error('❌ Помилка при очищенні даних:', {
                key: key,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
        }
    },

    deleteBattle: async (req, res) => {
        const key = req.params.key;
        const battleId = req.params.battleId;

        console.log('🗑️ DELETE-BATTLE запит отримано:', {
            timestamp: new Date().toISOString(),
            key: key,
            battleId: battleId
        });

        res.status(202).json({
            success: true,
            message: `Запит на видалення бою ${battleId} прийнято`
        });

        try {
            console.log('🔄 Початок видалення бою:', { key, battleId });
            await battleStatsService.deleteBattle(key, battleId);
            console.log('✅ Видалення бою завершено:', { key, battleId });
        } catch (error) {
            console.error('❌ Помилка при видаленні бою:', {
                key: key,
                battleId: battleId,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
        }
    },

    clearDatabase: async (req, res) => {
        console.log('🗑️ CLEAR-DATABASE запит отримано:', {
            timestamp: new Date().toISOString()
        });

        try {
            console.log('🔄 Початок очищення всієї бази даних');
            const result = await battleStatsService.clearDatabase();
            console.log('✅ Очищення бази даних завершено:', result);
            res.status(200).json(result);
        } catch (error) {
            console.error('❌ Помилка при очищенні бази даних:', {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            res.status(500).json({
                success: false,
                message: 'Помилка при очищенні бази даних',
            });
        }
    },

    setIo: (io) => {
        battleStatsService.setIo(io);
        console.log('📡 IO інстанс передано в battleStatsController');
    }
};

module.exports = battleStatsController;