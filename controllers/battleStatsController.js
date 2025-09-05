const battleStatsService = require('../services/battleStatsService');
const { queueManager, isQueueFull, getQueueStats } = require('../config/queue');
const metrics = require('../config/metrics');

const battleStatsController = {
    updateStats: (req, res) => {
        const key = req.apiKey;
        const playerId = req.headers['x-player-id'];

        if (isQueueFull(key)) {
            return res.status(503).json({
                error: 'Service Unavailable',
                message: 'Сервер перевантажено, спробуйте пізніше',
            });
        }

        if (!playerId) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Відсутній ID гравця в заголовку запиту (X-Player-ID)',
            });
        }

        metrics.totalRequests++;
        const queueStats = getQueueStats();
        
        res.status(202).json({
            success: true,
            message: 'Запит прийнято на обробку',
            queueStats: queueStats.perKeyQueues[key] || queueStats.defaultQueue
        });

        queueManager.addWithRetry(
            key,
            async () => {
                try {
                    const result = await battleStatsService.processDataAsync(key, playerId, req.body);
                    if (result) {
                        metrics.successfulRequests++;
                    } else {
                        metrics.failedRequests++;
                    }
                    return result;
                } catch (error) {
                    console.error('❌ Помилка асинхронної обробки:', error);
                    metrics.failedRequests++;
                    throw error;
                }
            },
            { batch: true, priority: 5 }
        ).catch(err => {
            console.error('❌ Помилка в черзі:', err);
            metrics.failedRequests++;
        });
    },

    getStats: async (req, res) => {
        try {
            const key = req.apiKey;
            const page = parseInt(req.query.page) || 1;
            const limit = req.query.limit !== undefined ? parseInt(req.query.limit) : 10;

            const result = await battleStatsService.getStats(key, page, limit);
            res.status(200).json(result);
        } catch (error) {
            console.error('❌ Помилка при завантаженні даних:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Помилка при завантаженні даних'
            });
        }
    },

    getOtherPlayersStats: async (req, res) => {
        try {
            const key = req.apiKey;
            const excludePlayerId = req.headers['x-player-id'];

            if (!excludePlayerId) {
                return res.status(400).json({
                    success: false,
                    message: 'Відсутній ID гравця в заголовку запиту (X-Player-ID)'
                });
            }

            const result = await battleStatsService.getOtherPlayersStats(key, excludePlayerId);
            res.status(200).json(result);
        } catch (error) {
            console.error('❌ Помилка при завантаженні даних інших гравців:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Помилка при завантаженні даних інших гравців'
            });
        }
    },

    importStats: async (req, res) => {
        const key = req.apiKey;

        res.status(202).json({
            success: true,
            message: 'Запит на імпорт прийнято'
        });

        queueManager.addWithRetry(
            key,
            async () => {
                try {
                    await battleStatsService.importStats(key, req.body);
                } catch (error) {
                    console.error('❌ Помилка при імпорті даних:', error);
                }
            },
            { priority: 3 }
        );
    },

    clearStats: async (req, res) => {
        const key = req.apiKey;

        res.status(200).json({
            success: true,
            message: `Запит на очищення даних для ключа ${key} прийнято`
        });

        queueManager.addCritical(
            key,
            async () => {
                try {
                    await battleStatsService.clearStats(key);
                } catch (error) {
                    console.error('❌ Помилка при очищенні даних:', error);
                }
            }
        );
    },

    deleteBattle: async (req, res) => {
        const key = req.apiKey;
        const battleId = req.params.battleId;

        res.status(202).json({
            success: true,
            message: `Запит на видалення бою ${battleId} прийнято`
        });

        queueManager.addWithRetry(
            key,
            async () => {
                try {
                    await battleStatsService.deleteBattle(key, battleId);
                } catch (error) {
                    console.error('❌ Помилка при видаленні бою:', error);
                }
            },
            { priority: 7 }
        );
    },

    clearDatabase: async (req, res) => {
        try {
            const result = await battleStatsService.clearDatabase();
            res.status(200).json(result);
        } catch (error) {
            console.error('❌ Помилка при очищенні бази даних:', error);
            res.status(500).json({
                success: false,
                message: 'Помилка при очищенні бази даних',
            });
        }
    },

    setIo: (io) => {
        battleStatsService.setIo(io);
    }
};

module.exports = battleStatsController;