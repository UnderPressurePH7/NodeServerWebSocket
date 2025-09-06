const mongoose = require('mongoose');

const battleStatsSchema = new mongoose.Schema({
    battleId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    playerId: {
        type: String,
        required: true,
        index: true
    },
    playerName: {
        type: String,
        required: true
    },
    vehicleName: {
        type: String,
        required: true
    },
    vehicleTier: {
        type: Number,
        required: true
    },
    battleTime: {
        type: Date,
        required: true,
        index: true
    },
    mapName: {
        type: String,
        required: true
    },
    gameMode: {
        type: String,
        required: true
    },
    battleResult: {
        type: String,
        enum: ['victory', 'defeat', 'draw'],
        required: true
    },
    damage: {
        type: Number,
        default: 0
    },
    kills: {
        type: Number,
        default: 0
    },
    spotted: {
        type: Number,
        default: 0
    },
    survivedBattle: {
        type: Boolean,
        default: false
    },
    xp: {
        type: Number,
        default: 0
    },
    credits: {
        type: Number,
        default: 0
    },
    shots: {
        type: Number,
        default: 0
    },
    hits: {
        type: Number,
        default: 0
    },
    penetrations: {
        type: Number,
        default: 0
    },
    damageBlocked: {
        type: Number,
        default: 0
    },
    capturePoints: {
        type: Number,
        default: 0
    },
    droppedCapturePoints: {
        type: Number,
        default: 0
    }
}, {
    timestamps: true,
    versionKey: false
});

battleStatsSchema.index({ playerId: 1, battleTime: -1 });
battleStatsSchema.index({ vehicleName: 1, battleTime: -1 });
battleStatsSchema.index({ battleResult: 1, battleTime: -1 });

battleStatsSchema.virtual('hitRatio').get(function() {
    return this.shots > 0 ? (this.hits / this.shots * 100).toFixed(2) : 0;
});

battleStatsSchema.virtual('penetrationRatio').get(function() {
    return this.hits > 0 ? (this.penetrations / this.hits * 100).toFixed(2) : 0;
});

battleStatsSchema.statics.findByPlayerId = function(playerId, options = {}) {
    const { limit = 50, skip = 0, sort = { battleTime: -1 } } = options;
    return this.find({ playerId })
        .sort(sort)
        .limit(limit)
        .skip(skip)
        .lean();
};

battleStatsSchema.statics.getPlayerStats = function(playerId) {
    return this.aggregate([
        { $match: { playerId } },
        {
            $group: {
                _id: '$playerId',
                totalBattles: { $sum: 1 },
                victories: {
                    $sum: { $cond: [{ $eq: ['$battleResult', 'victory'] }, 1, 0] }
                },
                totalDamage: { $sum: '$damage' },
                totalKills: { $sum: '$kills' },
                totalXP: { $sum: '$xp' },
                avgDamage: { $avg: '$damage' },
                avgXP: { $avg: '$xp' }
            }
        },
        {
            $addFields: {
                winRate: {
                    $multiply: [
                        { $divide: ['$victories', '$totalBattles'] },
                        100
                    ]
                }
            }
        }
    ]);
};

const BattleStatsModel = mongoose.model('BattleStats', battleStatsSchema);

module.exports = BattleStatsModel;