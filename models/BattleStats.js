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
    }
  },
  BattleStats: { 
      type: Map,
      of: battleSchema,
      default: () => new Map()
  },
  PlayerInfo: { 
      type: Map,
      of: playerInfoSchema,
      default: () => new Map()
  }
}, {
  toJSON: { 
    getters: true,
    transform: function(doc, ret) {
      if (ret.BattleStats instanceof Map) {
        ret.BattleStats = Object.fromEntries(ret.BattleStats);
      }
      if (ret.PlayerInfo instanceof Map) {
        ret.PlayerInfo = Object.fromEntries(ret.PlayerInfo);
      }
      return ret;
    }
  },
  strict: false,       
  minimize: false,      
  versionKey: false
});

BattleStatsSchema.index({ 'BattleStats.startTime': -1 });
BattleStatsSchema.index({ 'BattleStats.win': 1 });
BattleStatsSchema.index({ 'PlayerInfo._id': 1 });

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


BattleStatsSchema.statics.findByKey = function(key) {
    return this.findById(key);
};

BattleStatsSchema.statics.createNewStats = function(key) {
    return new this({
        _id: key,
        BattleStats: new Map(),
        PlayerInfo: new Map()
    });
};

BattleStatsSchema.statics.addBattle = function(key, battleId, battleData) {
    return this.updateOne(
        { _id: key },
        { $set: { [`BattleStats.${battleId}`]: battleData } },
        { upsert: true }
    );
};

BattleStatsSchema.statics.removeBattle = function(key, battleId) {
    return this.updateOne(
        { _id: key },
        { $unset: { [`BattleStats.${battleId}`]: "" } }
    );
};

BattleStatsSchema.statics.clearAllStats = function(key) {
    return this.updateOne(
        { _id: key },
        { $set: { BattleStats: {}, PlayerInfo: {} } },
        { upsert: true }
    );
};

module.exports = mongoose.model('BattleStats', BattleStatsSchema);