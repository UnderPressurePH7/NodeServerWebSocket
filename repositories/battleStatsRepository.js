const BattleStats = require('../models/BattleStats');
const mongoose = require('mongoose');

class BattleStatsRepository {
    async findByKey(key) {
        return await BattleStats.findById(key);
    }

    async findOrCreate(key) {
        return await BattleStats.findOneAndUpdate(
            { _id: key },
            { $setOnInsert: { _id: key, BattleStats: new Map(), PlayerInfo: new Map() } },
            { upsert: true, new: true, runValidators: true }
        );
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