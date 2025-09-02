const BattleStats = require('../models/BattleStats');
const mongoose = require('mongoose');

class BattleStatsRepository {
    async findByKey(key) {
        return await BattleStats.findById(key);
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
        
        const fullDoc = await BattleStats.findById(key);
        if (!fullDoc) {
            return [];
        }

        const result = await BattleStats.aggregate([
            { $match: { _id: key } },
            { $project: {
                battles: { $objectToArray: "$BattleStats" }
            }},
            { $unwind: "$battles" },
            { $sort: { "battles.v.startTime": -1 } },
            { $skip: skip },
            { $limit: limit },
            { $group: {
                _id: "$_id",
                BattleStats: { $push: "$battles" }
            }},
            { $project: {
                _id: 1,
                BattleStats: { $arrayToObject: "$BattleStats" }
            }}
        ]);

        if (result.length > 0) {
            result[0].PlayerInfo = fullDoc.PlayerInfo;
        }

        return result;
    }

    async updateBattleStats(key, updates) {
        return await BattleStats.updateOne({ _id: key }, updates, { upsert: true });
    }

    async save(statsDoc) {
        if (statsDoc.BattleStats instanceof Map) {
            statsDoc.markModified('BattleStats');
            for (const [battleId] of statsDoc.BattleStats) {
                statsDoc.markModified(`BattleStats.${battleId}`);
                statsDoc.markModified(`BattleStats.${battleId}.players`);
            }
        }
        
        if (statsDoc.PlayerInfo instanceof Map) {
            statsDoc.markModified('PlayerInfo');
        }
        
        return await statsDoc.save();
    }

    async clearStats(key) {
        return await BattleStats.updateOne(
            { _id: key },
            { $set: { BattleStats: {}, PlayerInfo: {} } },
            { upsert: true }
        );
    }

    async deleteBattle(key, battleId) {
        return await BattleStats.updateOne(
            { _id: key },
            { $unset: { [`BattleStats.${battleId}`]: "" } }
        );
    }

    async dropDatabase() {
        return await mongoose.connection.db.dropDatabase();
    }
}

module.exports = new BattleStatsRepository();