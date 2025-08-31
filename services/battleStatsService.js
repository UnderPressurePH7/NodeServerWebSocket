const BattleStats = require('../models/BattleStats');
const mongoose = require('mongoose');

class BattleStatsService {
    constructor() {
        this.globalIo = null;
    }

    setIo(io) {
        this.globalIo = io;
        console.log('📡 IO інстанс встановлено в BattleStatsService');
    }

    validateBattleData(battleData) {
        return battleData && typeof battleData === 'object';
    }

    parseMongoValue(value) {
        if (value && typeof value === 'object') {
            if (value.$numberDouble) {
                return parseFloat(value.$numberDouble);
            }
            if (value.$numberInt) {
                return parseInt(value.$numberInt);
            }
            if (value.$numberLong) {
                return parseInt(value.$numberLong);
            }
            return value;
        }
        return value;
    }

    parseMongoObject(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        
        const parsed = {};
        for (const [key, value] of Object.entries(obj)) {
            if (key === 'players' && value && typeof value === 'object') {
                parsed[key] = new Map();
                for (const [playerId, playerData] of Object.entries(value)) {
                    if (playerData && playerData._id) {
                        const parsedPlayerData = {
                            _id: {
                                name: playerData._id.name,
                                damage: this.parseMongoValue(playerData._id.damage),
                                kills: this.parseMongoValue(playerData._id.kills),
                                points: this.parseMongoValue(playerData._id.points),
                                vehicle: playerData._id.vehicle
                            }
                        };
                        parsed[key].set(playerId, parsedPlayerData);
                    }
                }
            } else if (Array.isArray(value)) {
                parsed[key] = value.map(item => this.parseMongoObject(item));
            } else if (value && typeof value === 'object') {
                parsed[key] = this.parseMongoObject(value);
            } else {
                parsed[key] = this.parseMongoValue(value);
            }
        }
        return parsed;
    }

    async processDataAsync(key, playerId, requestData) {
        try {
            const { BattleStats: incomingBattleStats, PlayerInfo: incomingPlayerInfo } = requestData || {};

            if (!incomingBattleStats && !incomingPlayerInfo) {
                return false;
            }

            let statsDoc = await BattleStats.findOneAndUpdate(
                { _id: key },
                { $setOnInsert: { _id: key, BattleStats: new Map(), PlayerInfo: new Map() } },
                { upsert: true, new: true, runValidators: true }
            );

            if (!(statsDoc.BattleStats instanceof Map)) {
                statsDoc.BattleStats = new Map(Object.entries(statsDoc.BattleStats || {}));
            }
            if (!(statsDoc.PlayerInfo instanceof Map)) {
                statsDoc.PlayerInfo = new Map(Object.entries(statsDoc.PlayerInfo || {}));
            }

            for (const [battleId, battleData] of statsDoc.BattleStats) {
                if (battleData && battleData.players && !(battleData.players instanceof Map)) {
                    battleData.players = new Map(Object.entries(battleData.players || {}));
                }
            }
            let needsCleanup = false;
            
            statsDoc.BattleStats.forEach((battle, battleId) => {
                let battleModified = false;
                
                if (battle.duration === undefined || battle.duration === null || isNaN(battle.duration)) {
                    battle.duration = 0;
                    battleModified = true;
                }
                
                if (battle.win === undefined || battle.win === null || isNaN(battle.win)) {
                    battle.win = -1;
                    battleModified = true;
                }
                
                if (battle.startTime === undefined || battle.startTime === null || isNaN(battle.startTime)) {
                    battle.startTime = Date.now();
                    battleModified = true;
                }
                
                if (battleModified) {
                    statsDoc.BattleStats.set(battleId, battle);
                    needsCleanup = true;
                }
            });
            
            if (needsCleanup) {
                statsDoc.markModified('BattleStats');
                await statsDoc.save();
            }

            let modified = false;

            if (incomingPlayerInfo && typeof incomingPlayerInfo === 'object') {
                Object.entries(incomingPlayerInfo).forEach(([pid, pInfo]) => {
                    let playerData;
                    if (typeof pInfo === 'string') {
                        playerData = { _id: pInfo };
                    } else if (pInfo && typeof pInfo === 'object' && pInfo._id) {
                        playerData = { _id: pInfo._id };
                    } else {
                        return;
                    }
                    
                    const current = statsDoc.PlayerInfo.get(pid);
                    if (!current || current._id !== playerData._id) {
                        statsDoc.PlayerInfo.set(pid, playerData);
                        modified = true;
                    }
                });
            }

            if (incomingBattleStats && typeof incomingBattleStats === 'object') {
                Object.entries(incomingBattleStats).forEach(([arenaId, battleData]) => {
                    if (this.validateBattleData(battleData)) {
                        const battleSource = battleData._id || battleData;
                        const existingBattle = statsDoc.BattleStats.get(arenaId);
                        

                        const incomingBattle = {
                            startTime: this.parseMongoValue(battleSource.startTime),
                            duration: this.parseMongoValue(battleSource.duration),
                            win: this.parseMongoValue(battleSource.win),
                            mapName: battleSource.mapName,
                            players: new Map()
                        };
                        
                        let battle;
                        
                        if (existingBattle) {
                            battle = existingBattle;
                            
                            if (!(battle.players instanceof Map)) {
                                battle.players = new Map(Object.entries(battle.players || {}));
                            }
                        } else {
                            battle = {
                                startTime: 0,
                                duration: 0,
                                win: -1,
                                mapName: 'Unknown Map',
                                players: new Map()
                            };
                            
                            statsDoc.BattleStats.set(arenaId, battle);
                        }
                        

                        if (battle.win === undefined || battle.win === null || isNaN(battle.win)) {
                            battle.win = -1;
                        }
                        if (battle.duration === undefined || battle.duration === null || isNaN(battle.duration)) {
                            battle.duration = 0;
                        }
                        if (battle.startTime === undefined || battle.startTime === null || isNaN(battle.startTime)) {
                            battle.startTime = 0;
                        }
                        
                        if (incomingBattle.startTime > battle.startTime) {
                            battle.startTime = incomingBattle.startTime;
                            modified = true;
                        }
                        

                        if (incomingBattle.duration > 0 && incomingBattle.duration > battle.duration) {
                            battle.duration = incomingBattle.duration;
                            modified = true;
                        }
                        
                        if (incomingBattle.win !== -1 && incomingBattle.win !== undefined && incomingBattle.win !== null && !isNaN(incomingBattle.win)) {
                            if (battle.win === -1 || battle.win !== incomingBattle.win) {
                                battle.win = incomingBattle.win;
                                modified = true;
                            }
                        }
                        
                        if (incomingBattle.mapName && 
                            (!battle.mapName || battle.mapName === 'Unknown Map' || battle.mapName === '')) {
                            battle.mapName = incomingBattle.mapName;
                            modified = true;
                        }
                        
                        const playersSource = battleSource.players || {};
                        
                        Object.entries(playersSource).forEach(([playerId, playerData]) => {
                            let actualPlayerData = null;
                            
                            if (playerData && typeof playerData === 'object') {
                                if (playerData._id && typeof playerData._id === 'object') {
                                    if (playerData._id._id && typeof playerData._id._id === 'object') {
                                        actualPlayerData = playerData._id._id;
                                    } else {
                                        actualPlayerData = playerData._id;
                                    }
                                } else {
                                    actualPlayerData = playerData;
                                }
                            }
                            
                            if (!actualPlayerData || typeof actualPlayerData !== 'object') {
                                return;
                            }
                            
                            const incomingPlayer = {
                                name: actualPlayerData.name || 'Unknown Player',
                                damage: this.parseMongoValue(actualPlayerData.damage) || 0,
                                kills: this.parseMongoValue(actualPlayerData.kills || actualPlayerData.frags) || 0,
                                points: this.parseMongoValue(actualPlayerData.points) || 0,
                                vehicle: actualPlayerData.vehicle || 'Unknown Vehicle'
                            };
                                                    
                            const existingPlayer = battle.players.get(playerId);
                            
                            if (!existingPlayer) {
                                battle.players.set(playerId, incomingPlayer);
                                modified = true;
                            } else {
                                const updatedPlayer = {
                                    name: incomingPlayer.name || existingPlayer.name || 'Unknown Player',
                                    damage: Math.max(incomingPlayer.damage || 0, existingPlayer.damage || 0),
                                    kills: Math.max(incomingPlayer.kills || 0, existingPlayer.kills || 0),
                                    points: Math.max(incomingPlayer.points || 0, existingPlayer.points || 0),
                                    vehicle: (existingPlayer.vehicle && existingPlayer.vehicle !== 'Unknown Vehicle') 
                                        ? existingPlayer.vehicle 
                                        : (incomingPlayer.vehicle || existingPlayer.vehicle || 'Unknown Vehicle')       
                                };
                                
                                battle.players.set(playerId, updatedPlayer);
                                modified = true;
                            }
                        });
                    }
                });
            }
            
            if (modified) {
                statsDoc.markModified('BattleStats');
                statsDoc.markModified('PlayerInfo');
                
                for (const [battleId] of statsDoc.BattleStats) {
                    statsDoc.markModified(`BattleStats.${battleId}`);
                    statsDoc.markModified(`BattleStats.${battleId}.players`);
                }
                
                await statsDoc.save();

                if (this.globalIo) {
                    const updateData = {
                        key: key,
                        playerId: playerId,
                        timestamp: Date.now()
                    };
                    
                    setImmediate(() => {
                        try {
                            this.globalIo.emit('statsUpdated', updateData);
                        } catch (error) {
                            console.error('Помилка при розсилці через globalIo:', error);
                        }
                    });
                }
            }

            return true;
        } catch (error) {
            console.error(`❌ Помилка при обробці даних для ключа ${key}:`, error);
            if (error.name === 'ValidationError') {
                console.error('📋 Деталі валідації:', JSON.stringify(error.errors, null, 2));
            }
            if (error.name === 'MongoError' || error.name === 'MongoServerError') {
                console.error('🗄️ Помилка MongoDB:', error.message);
            }
            return false;
        }
    }

    async getStats(key) {
        const statsDoc = await BattleStats.findById(key);

        if (!statsDoc) {
            return {
                success: true,
                BattleStats: {},
                PlayerInfo: {}
            };
        }

        if (!(statsDoc.BattleStats instanceof Map)) {
            const battleStatsMap = new Map();
            if (statsDoc.BattleStats && typeof statsDoc.BattleStats === 'object') {
                Object.entries(statsDoc.BattleStats).forEach(([battleId, battleData]) => {
                    if (battleData) {
                        const actualBattleData = battleData._id || battleData;

                        if (actualBattleData.players && typeof actualBattleData.players === 'object') {
                            actualBattleData.players = new Map(Object.entries(actualBattleData.players));
                        }
                        
                        battleStatsMap.set(battleId, actualBattleData);
                    }
                });
            }
            statsDoc.BattleStats = battleStatsMap;
        } else {
            statsDoc.BattleStats.forEach((battle, battleId) => {
                const actualBattle = battle._id || battle;
                if (actualBattle !== battle) {
                    if (actualBattle.players && !(actualBattle.players instanceof Map) && typeof actualBattle.players === 'object') {
                        actualBattle.players = new Map(Object.entries(actualBattle.players));
                    }
                    statsDoc.BattleStats.set(battleId, actualBattle);
                } else if (battle.players && !(battle.players instanceof Map) && typeof battle.players === 'object') {
                    battle.players = new Map(Object.entries(battle.players));
                }
            });
        }
        
        if (!(statsDoc.PlayerInfo instanceof Map)) {
            const playerInfoMap = new Map();
            if (statsDoc.PlayerInfo && typeof statsDoc.PlayerInfo === 'object') {
                Object.entries(statsDoc.PlayerInfo).forEach(([playerId, playerData]) => {
                    if (playerData) {
                        playerInfoMap.set(playerId, playerData);
                    }
                });
            }
            statsDoc.PlayerInfo = playerInfoMap;
        }
        
        const cleanBattleStats = {};
        if (statsDoc.BattleStats) {
            statsDoc.BattleStats.forEach((battle, battleId) => {
                const battleCore = battle._id || battle;
                
                const playersObj = {};
                
                if (battleCore.players instanceof Map) {
                    battleCore.players.forEach((player, playerId) => {
                        playersObj[playerId] = player;
                    });
                } else if (battleCore.players && typeof battleCore.players === 'object') {
                    Object.entries(battleCore.players).forEach(([playerId, player]) => {
                        playersObj[playerId] = player;
                    });
                }
                
                cleanBattleStats[battleId] = {
                    startTime: battleCore.startTime,
                    duration: battleCore.duration,
                    win: battleCore.win,
                    mapName: battleCore.mapName,
                    players: playersObj
                };
            });
        }

        const cleanPlayerInfo = {};
        if (statsDoc.PlayerInfo) {
            statsDoc.PlayerInfo.forEach((player, playerId) => {
                const playerCore = player._id || player;
                cleanPlayerInfo[playerId] = playerCore;
            });
        }

        return {
            success: true,
            BattleStats: cleanBattleStats,
            PlayerInfo: cleanPlayerInfo
        };
    }

    async getOtherPlayersStats(key, excludePlayerId) {
        const statsDoc = await BattleStats.findById(key);

        if (!statsDoc) {
            return {
                success: true,
                BattleStats: {}
            };
        }

        const cleanBattleStats = {};
        statsDoc.BattleStats.forEach((battle, battleId) => {
            const otherPlayersData = {};
            let hasOtherPlayers = false;

            const playersMap = (battle.players instanceof Map)
                ? battle.players
                : new Map(Object.entries(battle.players || {}));

            playersMap.forEach((playerData, pid) => {
                if (pid !== excludePlayerId) {
                    otherPlayersData[pid] = playerData;
                    hasOtherPlayers = true;
                }
            });

            if (hasOtherPlayers) {
                cleanBattleStats[battleId] = {
                    startTime: battle.startTime,
                    duration: battle.duration,
                    win: battle.win,
                    mapName: battle.mapName,
                    players: otherPlayersData
                };
            }
        });

        return {
            success: true,
            BattleStats: cleanBattleStats
        };
    }

    async importStats(key, importData) {
        if (!importData || typeof importData !== 'object') {
            throw new Error('Невалідні дані для імпорту');
        }

        let statsDoc = await BattleStats.findOneAndUpdate(
            { _id: key },
            { $setOnInsert: { _id: key, BattleStats: new Map(), PlayerInfo: new Map() } },
            { upsert: true, new: true, runValidators: true }
        );

        const { PlayerInfo, BattleStats: importBattleStats } = importData;

        if (PlayerInfo && typeof PlayerInfo === 'object') {
            Object.entries(PlayerInfo).forEach(([playerId, nickname]) => {
                statsDoc.PlayerInfo.set(playerId, nickname);
            });
            statsDoc.markModified('PlayerInfo');
        }

        if (importBattleStats && typeof importBattleStats === 'object') {
            Object.entries(importBattleStats).forEach(([battleId, raw]) => {
                const base = (raw && typeof raw === 'object' && raw._id && typeof raw._id === 'object') ? raw._id : raw;
                const playersSource = (base.players && typeof base.players === 'object')
                    ? base.players
                    : (raw.players && typeof raw.players === 'object')
                        ? raw.players
                        : {};

                const playersMap = new Map();
                Object.entries(playersSource).forEach(([pid, playerData]) => {
                    playersMap.set(pid, playerData);
                });

                const battle = {
                    startTime: base.startTime,
                    duration: base.duration,
                    win: base.win,
                    mapName: base.mapName,
                    players: playersMap
                };
                statsDoc.BattleStats.set(battleId, battle);
            });
            statsDoc.markModified('BattleStats');
        }

        if (statsDoc.isModified()) {
            await statsDoc.save();
        }

        return { success: true };
    }

    async clearStats(key) {
        await BattleStats.updateOne(
            { _id: key },
            { $set: { BattleStats: {}, PlayerInfo: {} } },
            { upsert: true }
        );

        return { success: true };
    }

    async deleteBattle(key, battleId) {
        await BattleStats.updateOne(
            { _id: key },
            { $unset: { [`BattleStats.${battleId}`]: "" } }
        );

        return { success: true };
    }

    async clearDatabase() {
        await mongoose.connection.db.dropDatabase();
        return { success: true, message: 'База даних успішно очищена' };
    }
}

module.exports = new BattleStatsService();