const battleStatsService = require('../services/battleStatsService');
const { queueManager, isQueueFull, getQueueStats } = require('../config/queue');
const metrics = require('../config/metrics');
const ResponseUtils = require('../utils/responseUtils');

const battleStatsController = {
    updateStats: (req, res) => {
        const key = req.apiKey;
        const playerId = req.playerId;

        if (isQueueFull(key)) {
            return ResponseUtils.sendError(res, {
                statusCode: 503,
                message: 'Сервер перевантажено, спробуйте пізніше'
            });
        }

        metrics.totalRequests++;
        const queueStats = getQueueStats();
        
        ResponseUtils.sendSuccess(res, {
            message: 'Запит прийнято на обробку',
            queueStats: queueStats.perKeyQueues[key] || queueStats.defaultQueue
        }, {}, 202);

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
            const page = req.pagination?.page || parseInt(req.query.page) || 1;
            const limit = req.pagination?.limit !== undefined ? req.pagination.limit : 
                         (req.query.limit !== undefined ? parseInt(req.query.limit) : 10);

            const result = await battleStatsService.getStats(key, page, limit);
            ResponseUtils.sendSuccess(res, result);
        } catch (error) {
            console.error('❌ Помилка при завантаженні даних:', error);
            ResponseUtils.sendError(res, {
                statusCode: 500,
                message: 'Помилка при завантаженні даних'
            });
        }
    },

    importStats: async (req, res) => {
        const key = req.apiKey;

        ResponseUtils.sendSuccess(res, {
            message: 'Запит на імпорт прийнято'
        }, {}, 202);

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

        ResponseUtils.sendSuccess(res, {
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

        ResponseUtils.sendSuccess(res, {
            message: `Запит на видалення бою ${battleId} прийнято`
        }, {}, 202);

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
            ResponseUtils.sendSuccess(res, result);
        } catch (error) {
            console.error('❌ Помилка при очищенні бази даних:', error);
            ResponseUtils.sendError(res, {
                statusCode: 500,
                message: 'Помилка при очищенні бази даних'
            });
        }
    },

    setIo: (io) => {
        battleStatsService.setIo(io);
    }
};

module.exports = battleStatsController;