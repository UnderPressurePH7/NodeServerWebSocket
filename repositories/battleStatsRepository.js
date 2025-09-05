const BattleStats = require('../models/BattleStats');
const mongoose = require('mongoose');
const LRUCache = require('../utils/LRUCache');

class BattleStatsRepository {
    constructor() {
        this.cache = new LRUCache(100, 50);
        this.cleanupInterval = setInterval(() => this.cache.cleanup(), 60000);
    }

    async findByKey(key, useCache = true) {
        try {
            if (useCache) {
                const cached = this.cache.get(key);
                if (cached) return cached;
            }

            const result = await BattleStats.findById(key).lean();
            
            if (result && useCache) {
                this.cache.set(key, result, 5000);
            }

            return result;
        } catch (error) {
            console.error('❌ Помилка в findByKey:', error);
            throw error;
        }
    }

    invalidateCache(key) {
        this.cache.delete(key);
    }

    async findOrCreate(key) {
        let statsDoc = await this.findByKey(key);
        if (!statsDoc) {
            statsDoc = new BattleStats({
                _id: key,
                BattleStats: new Map(),
                PlayerInfo: new Map()
            });
        }
        return statsDoc;
    }

    async getPaginatedBattles(key, page = 1, limit = 10) {
        const skip = (page - 1) * limit;
        const cacheKey = `paginated:${key}:${page}:${limit}`;
        
        const cached = this.cache.get(cacheKey);
        if (cached) return cached;

        try {
            const results = await BattleStats.aggregate([
                { $match: { _id: key } },
                {
                    $project: {
                        PlayerInfo: "$PlayerInfo",
                        BattleStats: { $objectToArray: "$BattleStats" }
                    }
                },
                { $unwind: "$BattleStats" },
                { $sort: { "BattleStats.v.startTime": -1 } },
                { $skip: skip },
                { $limit: limit },
                {
                    $group: {
                        _id: "$_id",
                        PlayerInfo: { $first: "$PlayerInfo" },
                        BattleStats: { $push: "$BattleStats" }
                    }
                },
                {
                    $project: {
                        _id: 1,
                        PlayerInfo: 1,
                        BattleStats: { $arrayToObject: "$BattleStats" }
                    }
                }
            ]);

            if (results.length > 0) {
                const doc = results[0];
                doc.BattleStats = new Map(Object.entries(doc.BattleStats || {}));
                doc.PlayerInfo = new Map(Object.entries(doc.PlayerInfo || {}));
                this.cache.set(cacheKey, [doc], 3000);
                return [doc];
            }

            return [];
        } catch (error) {
            console.error('Помилка пагінації:', error);
            return [];
        }
    }

    async bulkUpdateBattleStats(operations) {
        try {
            if (!operations || operations.length === 0) {
                return { acknowledged: true, modifiedCount: 0 };
            }

            const parallelBatches = [];
            const batchSize = 10;
            
            for (let i = 0; i < operations.length; i += batchSize) {
                const batch = operations.slice(i, i + batchSize);
                parallelBatches.push(this.processBatch(batch));
            }

            const results = await Promise.all(parallelBatches);
            
            const totalModified = results.reduce((sum, r) => sum + (r.modifiedCount || 0), 0);
            
            return {
                acknowledged: true,
                modifiedCount: totalModified
            };
        } catch (error) {
            console.error('❌ Помилка в bulkUpdateBattleStats:', error);
            throw error;
        }
    }

    async processBatch(operations) {
        operations.forEach(op => this.invalidateCache(op.key));
        
        const bulkOps = operations.map(op => ({
            updateOne: {
                filter: { _id: op.key },
                update: op.updates,
                upsert: true
            }
        }));

        return BattleStats.bulkWrite(bulkOps, { ordered: false });
    }

    async updateBattleStats(key, updates) {
        try {
            this.invalidateCache(key);
            
            const result = await BattleStats.updateOne(
                { _id: key }, 
                updates, 
                { upsert: true }
            );
            
            return result;
        } catch (error) {
            console.error('❌ Помилка в updateBattleStats:', error);
            throw error;
        }
    }

    async save(statsDoc) {
        try {
            this.invalidateCache(statsDoc._id);

            const updates = {
                $set: {}
            };

            if (statsDoc.BattleStats instanceof Map) {
                for (const [battleId, battleData] of statsDoc.BattleStats) {
                    updates.$set[`BattleStats.${battleId}`] = battleData;
                    
                    if (battleData.players instanceof Map) {
                        const playersObj = {};
                        for (const [playerId, playerData] of battleData.players) {
                            playersObj[playerId] = playerData;
                        }
                        updates.$set[`BattleStats.${battleId}.players`] = playersObj;
                    }
                }
            }

            if (statsDoc.PlayerInfo instanceof Map) {
                for (const [playerId, playerData] of statsDoc.PlayerInfo) {
                    updates.$set[`PlayerInfo.${playerId}`] = playerData;
                }
            }

            const result = await BattleStats.updateOne(
                { _id: statsDoc._id },
                updates,
                { upsert: true }
            );

            return result;
        } catch (error) {
            console.error('❌ Помилка збереження:', error);
            throw error;
        }
    }

    async clearStats(key) {
        try {
            this.invalidateCache(key);
            const result = await BattleStats.updateOne(
                { _id: key },
                { $set: { BattleStats: {}, PlayerInfo: {} } },
                { upsert: true }
            );
            return result;
        } catch (error) {
            console.error('❌ Помилка очищення статистики:', error);
            throw error;
        }
    }

    async deleteBattle(key, battleId) {
        try {
            this.invalidateCache(key);
            const result = await BattleStats.updateOne(
                { _id: key },
                { $unset: { [`BattleStats.${battleId}`]: "" } }
            );
            return result;
        } catch (error) {
            console.error('❌ Помилка видалення бою:', error);
            throw error;
        }
    }

    async dropDatabase() {
        try {
            this.cache.clear();
            const result = await mongoose.connection.db.dropDatabase();
            return result;
        } catch (error) {
            console.error('❌ Помилка видалення БД:', error);
            throw error;
        }
    }

    async getStatsRaw(key) {
        try {
            const result = await BattleStats.findById(key).lean();
            return result;
        } catch (error) {
            console.error('❌ Помилка в getStatsRaw:', error);
            throw error;
        }
    }

    destroy() {
        clearInterval(this.cleanupInterval);
        this.cache.clear();
    }
}

const repository = new BattleStatsRepository();

process.on('SIGINT', () => repository.destroy());
process.on('SIGTERM', () => repository.destroy());

module.exports = repository;