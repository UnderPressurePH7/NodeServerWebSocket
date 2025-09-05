const mongoose = require('mongoose');
const VALID_KEYS = require('../config/validKey');

const playerStatsSchema = new mongoose.Schema({
    name: { type: String, required: true },
    damage: { type: Number, default: 0 },
    kills: { type: Number, default: 0 },
    points: { type: Number, default: 0 },
    vehicle: { type: String, default: 'Unknown Vehicle' }
}, { _id: false, strict: false });

const battleSchema = new mongoose.Schema({
    startTime: { type: Number, default: Date.now, index: true },
    duration: { type: Number, default: 0 },
    win: { type: Number, default: -1, index: true },
    mapName: { type: String, default: 'Unknown Map' },
    players: { type: Map, of: playerStatsSchema }
}, { 
    _id: false, 
    strict: false,
    minimize: false  
});

const playerInfoSchema = new mongoose.Schema({
    _id: { type: String, required: true }
}, { _id: false, strict: false });

const BattleStatsSchema = new mongoose.Schema({
  _id: { 
    type: String,
    required: true,
    validate: {
      validator: function(v) {
        return VALID_KEYS.includes(v);
      },
      message: props => `${props.value} не є валідним ключем`
    },
    index: true
  },
  BattleStats: { 
      type: Map,
      of: battleSchema
  },
  PlayerInfo: { 
      type: Map,
      of: playerInfoSchema
  }
}, {
  toJSON: { getters: true },
  strict: false,       
  minimize: false,      
  versionKey: false
});

BattleStatsSchema.index({ '_id': 1, 'BattleStats.startTime': -1 });
BattleStatsSchema.index({ '_id': 1, 'BattleStats.win': 1 });
BattleStatsSchema.index({ '_id': 1, 'PlayerInfo._id': 1 });

BattleStatsSchema.pre('save', function() {
    if (this.BattleStats instanceof Map) {
        this.markModified('BattleStats');
        for (const [battleId, battle] of this.BattleStats) {
            this.markModified(`BattleStats.${battleId}`);
            if (battle && battle.players instanceof Map) {
                this.markModified(`BattleStats.${battleId}.players`);
                for (const [playerId] of battle.players) {
                    this.markModified(`BattleStats.${battleId}.players.${playerId}`);
                }
            }
        }
    }
    if (this.PlayerInfo instanceof Map) {
        this.markModified('PlayerInfo');
        for (const [playerId] of this.PlayerInfo) {
            this.markModified(`PlayerInfo.${playerId}`);
        }
    }
});

module.exports = mongoose.model('BattleStats', BattleStatsSchema);