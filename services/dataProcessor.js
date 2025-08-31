const MongoParser = require('../utils/mongoParser');
const Validators = require('../utils/validators');

class DataProcessor {
    processPlayerInfo(incomingPlayerInfo, existingPlayerInfo) {
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
                
                const current = existingPlayerInfo.get(pid);
                if (!current || current._id !== playerData._id) {
                    existingPlayerInfo.set(pid, playerData);
                    modified = true;
                }
            });
        }

        return modified;
    }

    processBattleStats(incomingBattleStats, existingBattleStats) {
        let modified = false;

        if (incomingBattleStats && typeof incomingBattleStats === 'object') {
            Object.entries(incomingBattleStats).forEach(([arenaId, battleData]) => {
                if (Validators.validateBattleData(battleData)) {
                    const battleSource = battleData._id || battleData;
                    const existingBattle = existingBattleStats.get(arenaId);
                    
                    const incomingBattle = {
                        startTime: MongoParser.parseValue(battleSource.startTime),
                        duration: MongoParser.parseValue(battleSource.duration),
                        win: MongoParser.parseValue(battleSource.win),
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
                        battle = Validators.sanitizeBattleFields({
                            startTime: 0,
                            duration: 0,
                            win: -1,
                            mapName: 'Unknown Map',
                            players: new Map()
                        });
                        battle.players = new Map();
                        existingBattleStats.set(arenaId, battle);
                    }
                    

                    if (this.mergeBattleFields(battle, incomingBattle)) {
                        modified = true;
                    }
                    
                    if (this.mergePlayers(battle, battleSource.players || {})) {
                        modified = true;
                    }
                }
            });
        }

        return modified;
    }

    mergeBattleFields(existingBattle, incomingBattle) {
        let modified = false;
        
        if (incomingBattle.startTime > existingBattle.startTime) {
            existingBattle.startTime = incomingBattle.startTime;
            modified = true;
        }
        
        if (incomingBattle.duration > 0 && incomingBattle.duration > existingBattle.duration) {
            existingBattle.duration = incomingBattle.duration;
            modified = true;
        }
        
        if (incomingBattle.win !== -1 && incomingBattle.win !== undefined && 
            incomingBattle.win !== null && !isNaN(incomingBattle.win)) {
            if (existingBattle.win === -1 || existingBattle.win !== incomingBattle.win) {
                existingBattle.win = incomingBattle.win;
                modified = true;
            }
        }
        
        if (incomingBattle.mapName && 
            (!existingBattle.mapName || existingBattle.mapName === 'Unknown Map' || existingBattle.mapName === '')) {
            existingBattle.mapName = incomingBattle.mapName;
            modified = true;
        }
        
        return modified;
    }

    mergePlayers(battle, playersSource) {
        let modified = false;
        
        Object.entries(playersSource).forEach(([playerId, playerData]) => {
            const actualPlayerData = this.extractPlayerData(playerData);
            
            if (!actualPlayerData || typeof actualPlayerData !== 'object') {
                return;
            }
            
            const incomingPlayer = {
                name: actualPlayerData.name || 'Unknown Player',
                damage: MongoParser.parseValue(actualPlayerData.damage) || 0,
                kills: MongoParser.parseValue(actualPlayerData.kills || actualPlayerData.frags) || 0,
                points: MongoParser.parseValue(actualPlayerData.points) || 0,
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
        
        return modified;
    }

    extractPlayerData(playerData) {
        if (playerData && typeof playerData === 'object') {
            if (playerData._id && typeof playerData._id === 'object') {
                if (playerData._id._id && typeof playerData._id._id === 'object') {
                    return playerData._id._id;
                } else {
                    return playerData._id;
                }
            } else {
                return playerData;
            }
        }
        return null;
    }

    cleanupBattleFields(existingBattleStats) {
        let needsCleanup = false;
        
        existingBattleStats.forEach((battle, battleId) => {
            let battleModified = false;
            
            const sanitized = Validators.sanitizeBattleFields(battle);
            
            if (battle.duration !== sanitized.duration) {
                battle.duration = sanitized.duration;
                battleModified = true;
            }
            
            if (battle.win !== sanitized.win) {
                battle.win = sanitized.win;
                battleModified = true;
            }
            
            if (battle.startTime !== sanitized.startTime) {
                battle.startTime = sanitized.startTime;
                battleModified = true;
            }
            
            if (battleModified) {
                existingBattleStats.set(battleId, battle);
                needsCleanup = true;
            }
        });
        
        return needsCleanup;
    }
}

module.exports = new DataProcessor();