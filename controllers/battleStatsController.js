const ResponseUtils = require('../utils/responseUtils');
const { queue } = require('../config/queue');
const { metrics } = require('../config/metrics');
const BattleStatsModel = require('../models/battleStatsModel');

class BattleStatsController {
    constructor() {
        this.updateStats = this.updateStats.bind(this);
        this.getStats = this.getStats.bind(this);
        this.importStats = this.importStats.bind(this);
        this.clearStats = this.clearStats.bind(this);
        this.deleteBattle = this.deleteBattle.bind(this);
        this.clearDatabase = this.clearDatabase.bind(this);
    }

    async updateStats(req, res) {
        try {
            console.log('updateStats called with:', req.body);
            
            if (!req.body || Object.keys(req.body).length === 0) {
                return ResponseUtils.sendError(res, {
                    statusCode: 400,
                    code: 'INVALID_DATA',
                    message: 'Відсутні дані для оновлення статистики'
                });
            }

            const result = await queue.add('updateStats', {
                data: req.body,
                playerId: req.playerId,
                timestamp: new Date().toISOString()
            });

            metrics.totalRequests++;
            metrics.successfulRequests++;

            ResponseUtils.sendSuccess(res, {
                message: 'Статистика додана до черги оновлення',
                jobId: result.id,
                queuePosition: await queue.count()
            });

        } catch (error) {
            console.error('Error in updateStats:', error);
            metrics.totalRequests++;
            metrics.failedRequests++;
            
            ResponseUtils.sendError(res, {
                statusCode: 500,
                code: 'UPDATE_STATS_ERROR',
                message: 'Помилка при додаванні статистики до черги'
            });
        }
    }

    async getStats(req, res) {
        try {
            const { page, limit } = req.pagination;
            const skip = (page - 1) * limit;

            const stats = await BattleStatsModel.find()
                .sort({ battleTime: -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            const total = await BattleStatsModel.countDocuments();

            ResponseUtils.sendSuccess(res, {
                stats,
                pagination: {
                    page,
                    limit,
                    total,
                    pages: Math.ceil(total / limit)
                }
            });

        } catch (error) {
            console.error('Error in getStats:', error);
            ResponseUtils.sendError(res, {
                statusCode: 500,
                code: 'GET_STATS_ERROR',
                message: 'Помилка при отриманні статистики'
            });
        }
    }

    async importStats(req, res) {
        try {
            const { stats } = req.body;

            if (!Array.isArray(stats) || stats.length === 0) {
                return ResponseUtils.sendError(res, {
                    statusCode: 400,
                    code: 'INVALID_IMPORT_DATA',
                    message: 'Некоректні дані для імпорту'
                });
            }

            const result = await queue.add('importStats', {
                stats,
                timestamp: new Date().toISOString()
            });

            ResponseUtils.sendSuccess(res, {
                message: `Імпорт ${stats.length} записів додано до черги`,
                jobId: result.id
            });

        } catch (error) {
            console.error('Error in importStats:', error);
            ResponseUtils.sendError(res, {
                statusCode: 500,
                code: 'IMPORT_ERROR',
                message: 'Помилка при імпорті статистики'
            });
        }
    }

    async clearStats(req, res) {
        try {
            const result = await queue.add('clearStats', {
                timestamp: new Date().toISOString()
            });

            ResponseUtils.sendSuccess(res, {
                message: 'Очищення статистики додано до черги',
                jobId: result.id
            });

        } catch (error) {
            console.error('Error in clearStats:', error);
            ResponseUtils.sendError(res, {
                statusCode: 500,
                code: 'CLEAR_ERROR',
                message: 'Помилка при очищенні статистики'
            });
        }
    }

    async deleteBattle(req, res) {
        try {
            const { battleId } = req.params;

            const result = await BattleStatsModel.deleteOne({ battleId });

            if (result.deletedCount === 0) {
                return ResponseUtils.sendError(res, {
                    statusCode: 404,
                    code: 'BATTLE_NOT_FOUND',
                    message: 'Бій не знайдено'
                });
            }

            ResponseUtils.sendSuccess(res, {
                message: 'Бій успішно видалено',
                battleId
            });

        } catch (error) {
            console.error('Error in deleteBattle:', error);
            ResponseUtils.sendError(res, {
                statusCode: 500,
                code: 'DELETE_BATTLE_ERROR',
                message: 'Помилка при видаленні бою'
            });
        }
    }

    async clearDatabase(req, res) {
        try {
            const result = await queue.add('clearDatabase', {
                timestamp: new Date().toISOString()
            });

            ResponseUtils.sendSuccess(res, {
                message: 'Очищення бази даних додано до черги',
                jobId: result.id
            });

        } catch (error) {
            console.error('Error in clearDatabase:', error);
            ResponseUtils.sendError(res, {
                statusCode: 500,
                code: 'CLEAR_DATABASE_ERROR',
                message: 'Помилка при очищенні бази даних'
            });
        }
    }
}

module.exports = new BattleStatsController();