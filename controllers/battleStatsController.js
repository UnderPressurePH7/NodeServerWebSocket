const ResponseUtils = require('../utils/responseUtils');
const { addWithRetry, isQueueFull, getQueueStats } = require('../config/queue');
const metrics = require('../config/metrics');
const battleStatsService = require('../services/battleStatsService');

const updateStats = async (req, res) => {
    try {
        if (!req.body || Object.keys(req.body).length === 0) {
            return ResponseUtils.sendError(res, {
                statusCode: 400,
                code: 'INVALID_DATA',
                message: 'Відсутні дані для оновлення статистики'
            });
        }

        if (isQueueFull()) {
            return ResponseUtils.sendError(res, {
                statusCode: 503,
                code: 'QUEUE_FULL',
                message: 'Сервер перевантажено, спробуйте пізніше'
            });
        }

        const result = await addWithRetry('updateStats', async () => {
            return await battleStatsService.processDataAsync(req.apiKey, req.body);
        }, {
            retries: 3,
            retryDelay: 1000,
            priority: 5
        });

        metrics.totalRequests++;
        
        if (result) {
            metrics.successfulRequests++;
            ResponseUtils.sendSuccess(res, {
                message: 'Статистика успішно оновлена',
                queueStats: getQueueStats()
            }, {}, 202);
        } else {
            metrics.failedRequests++;
            ResponseUtils.sendError(res, {
                statusCode: 422,
                code: 'PROCESSING_FAILED',
                message: 'Не вдалося обробити дані'
            });
        }

    } catch (error) {
        metrics.totalRequests++;
        metrics.failedRequests++;
        
        ResponseUtils.sendError(res, {
            statusCode: 500,
            code: 'UPDATE_STATS_ERROR',
            message: 'Помилка при оновленні статистики'
        });
    }
};

const getStats = async (req, res) => {
    try {
        const { page, limit } = req.pagination;
        const result = await battleStatsService.getStats(req.apiKey, page, limit);

        ResponseUtils.sendSuccess(res, {
            ...result,
            pagination: { page, limit }
        });

    } catch (error) {
        ResponseUtils.sendError(res, {
            statusCode: 500,
            code: 'GET_STATS_ERROR',
            message: 'Помилка при отриманні статистики'
        });
    }
};

const importStats = async (req, res) => {
    try {
        const { stats, ...importData } = req.body;
        const dataToImport = stats || importData;

        if (!dataToImport || typeof dataToImport !== 'object') {
            return ResponseUtils.sendError(res, {
                statusCode: 400,
                code: 'INVALID_IMPORT_DATA',
                message: 'Некоректні дані для імпорту'
            });
        }

        await addWithRetry('importStats', async () => {
            return await battleStatsService.importStats(req.apiKey, dataToImport);
        }, {
            retries: 2,
            retryDelay: 2000,
            priority: 8
        });

        ResponseUtils.sendSuccess(res, {
            message: 'Імпорт успішно завершено',
            key: req.apiKey
        });

    } catch (error) {
        ResponseUtils.sendError(res, {
            statusCode: 500,
            code: 'IMPORT_ERROR',
            message: 'Помилка при імпорті статистики'
        });
    }
};

const clearStats = async (req, res) => {
    try {
        await addWithRetry('clearStats', async () => {
            return await battleStatsService.clearStats(req.apiKey);
        }, {
            retries: 1,
            priority: 7
        });

        ResponseUtils.sendSuccess(res, {
            message: 'Статистика успішно очищена',
            key: req.apiKey
        });

    } catch (error) {
        ResponseUtils.sendError(res, {
            statusCode: 500,
            code: 'CLEAR_ERROR',
            message: 'Помилка при очищенні статистики'
        });
    }
};

const deleteBattle = async (req, res) => {
    try {
        const { battleId } = req.params;

        await addWithRetry('deleteBattle', async () => {
            return await battleStatsService.deleteBattle(req.apiKey, battleId);
        }, {
            retries: 1,
            priority: 6
        });

        ResponseUtils.sendSuccess(res, {
            message: 'Бій успішно видалено',
            battleId,
            key: req.apiKey
        });

    } catch (error) {
        ResponseUtils.sendError(res, {
            statusCode: 500,
            code: 'DELETE_BATTLE_ERROR',
            message: 'Помилка при видаленні бою'
        });
    }
};

const clearDatabase = async (req, res) => {
    try {
        await addWithRetry('clearDatabase', async () => {
            return await battleStatsService.clearDatabase();
        }, {
            retries: 1,
            priority: 10
        });

        ResponseUtils.sendSuccess(res, {
            message: 'База даних успішно очищена'
        });

    } catch (error) {
        ResponseUtils.sendError(res, {
            statusCode: 500,
            code: 'CLEAR_DATABASE_ERROR',
            message: 'Помилка при очищенні бази даних'
        });
    }
};

module.exports = {
    updateStats,
    getStats,
    importStats,
    clearStats,
    deleteBattle,
    clearDatabase
};