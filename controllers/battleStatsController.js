const battleStatsService = require('../services/battleStatsService');
const { queue, isQueueFull } = require('../config/queue');
const metrics = require('../config/metrics');

const battleStatsController = {
    updateStats: (req, res) => {
        if (isQueueFull()) {
            return res.status(503).json({
                error: 'Service Unavailable',
                message: 'Сервер перевантажено, спробуйте пізніше',
            });
        }

        const key = req.params.key;
        const playerId = req.headers['x-player-id'];

        if (!playerId) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Відсутній ID гравця в заголовку запиту (X-Player-ID)',
            });
        }

        metrics.totalRequests++;
        res.status(202).json({
            success: true,
            message: 'Запит прийнято на обробку',
            queueSize: queue.size
        });

        queue.add(async () => {
            try {
                const result = await battleStatsService.processDataAsync(key, playerId, req.body);
                if (result) {
                    metrics.successfulRequests++;
                } else {
                    metrics.failedRequests++;
                }
            } catch (error) {
                metrics.failedRequests++;
                console.error('Помилка асинхронної обробки:', error);
            }
        }).catch(err => {
            metrics.failedRequests++;
            console.error('Помилка в черзі:', err);
        });
    },

    getStats: async (req, res) => {
        try {
            const key = req.params.key;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;

            const result = await battleStatsService.getStats(key, page, limit);
            
            res.status(200).json(result);
        } catch (error) {
            console.error('Помилка при завантаженні даних:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Помилка при завантаженні даних'
            });
        }
    },

    getOtherPlayersStats: async (req, res) => {
        try {
            const key = req.params.key;
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
            console.error('Помилка при завантаженні даних інших гравців:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Помилка при завантаженні даних інших гравців'
            });
        }
    },

    importStats: async (req, res) => {
        const key = req.params.key;

        res.status(202).json({
            success: true,
            message: 'Запит на імпорт прийнято'
        });

        try {
            await battleStatsService.importStats(key, req.body);
        } catch (error) {
            console.error('Помилка при імпорті даних:', error);
        }
    },

    clearStats: async (req, res) => {
        const key = req.params.key;
        
        res.status(200).json({
            success: true,
            message: `Запит на очищення даних для ключа ${key} прийнято`
        });

        try {
            await battleStatsService.clearStats(key);
        } catch (error) {
            console.error('Помилка при очищенні даних:', error);
        }
    },

    deleteBattle: async (req, res) => {
        const key = req.params.key;
        const battleId = req.params.battleId;

        res.status(202).json({
            success: true,
            message: `Запит на видалення бою ${battleId} прийнято`
        });

        try {
            await battleStatsService.deleteBattle(key, battleId);
        } catch (error) {
            console.error('Помилка при видаленні бою:', error);
        }
    },

    clearDatabase: async (req, res) => {
        try {
            const result = await battleStatsService.clearDatabase();
            res.status(200).json(result);
        } catch (error) {
            console.error('Помилка при очищенні бази даних:', error);
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