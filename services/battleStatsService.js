const battleStatsRepository = require('../repositories/battleStatsRepository');
const notificationService = require('./notificationService');
const dataProcessor = require('./dataProcessor');
const DataTransformer = require('../utils/dataTransformer');
const Validators = require('../utils/validators');

class BattleStatsService {
    constructor() {
        this.pendingUpdates = new Map();
        this.updateTimeouts = new Map();
        this.batchSize = 100;
        this.batchDelay = 200;
        this.maxPendingTime = 10000;
        this.cleanupInterval = setInterval(() => this.cleanupStaleUpdates(), 30000);
    }

    setIo(io) {
        notificationService.setIo(io);
    }

    cleanupStaleUpdates() {
        const now = Date.now();
        for (const [key, updates] of this.pendingUpdates) {
            if (updates.length > 0 && updates[0].timestamp && (now - updates[0].timestamp) > this.maxPendingTime) {
                this.processPendingUpdates(key);
            }
        }
    }

    async addToPendingUpdates(key, updates) {
        if (!this.pendingUpdates.has(key)) {
            this.pendingUpdates.set(key, []);
        }

        const pending = this.pendingUpdates.get(key);
        pending.push({ ...updates, timestamp: Date.now() });

        if (pending.length >= this.batchSize) {
            await this.processPendingUpdates(key);
        } else if (!this.updateTimeouts.has(key)) {
            const timeoutId = setTimeout(() => {
                this.processPendingUpdates(key);
            }, this.batchDelay);
            this.updateTimeouts.set(key, timeoutId);
        }
    }

    async processPendingUpdates(key) {
        const pending = this.pendingUpdates.get(key);
        if (!pending || pending.length === 0) return;

        this.pendingUpdates.delete(key);
        
        if (this.updateTimeouts.has(key)) {
            clearTimeout(this.updateTimeouts.get(key));
            this.updateTimeouts.delete(key);
        }

        const mergedUpdate = { $set: {}, $unset: {} };

        for (const update of pending) {
            if (update.$set) {
                Object.assign(mergedUpdate.$set, update.$set);
            }
            if (update.$unset) {
                Object.assign(mergedUpdate.$unset, update.$unset);
            }
        }

        if (Object.keys(mergedUpdate.$unset).length === 0) {
            delete mergedUpdate.$unset;
        }

        await battleStatsRepository.updateBattleStats(key, mergedUpdate);
    }

    async processBatchDataAsync(batchData) {
        const operations = [];
        const parallelProcessing = [];
        
        for (const { key, requestData } of batchData) {
            parallelProcessing.push(
                this.prepareUpdates(key, requestData).then(updates => {
                    if (updates && (Object.keys(updates.$set).length > 0 || Object.keys(updates.$unset || {}).length > 0)) {
                        operations.push({ key, updates });
                    }
                }).catch(error => {
                    console.error(`Помилка обробки для ${key}:`, error);
                })
            );
        }

        await Promise.all(parallelProcessing);

        if (operations.length > 0) {
            const result = await battleStatsRepository.bulkUpdateBattleStats(operations);
            
            for (const { key } of batchData) {
                notificationService.notifyStatsUpdated(key);
            }
            
            return result;
        }

        return { acknowledged: true, modifiedCount: 0 };
    }

    async prepareUpdates(key, requestData) {
        const { BattleStats: incomingBattleStats, PlayerInfo: incomingPlayerInfo } = requestData || {};
        
        if (!incomingBattleStats && !incomingPlayerInfo) {
            return null;
        }

        const updates = { $set: {}, $unset: {} };

        if (incomingPlayerInfo) {
            for (const [pid, pInfo] of Object.entries(incomingPlayerInfo)) {
                let playerData;
                if (typeof pInfo === 'string') {
                    playerData = { _id: pInfo };
                } else if (pInfo && typeof pInfo === 'object' && pInfo._id) {
                    playerData = { _id: pInfo._id };
                } else {
                    continue;
                }
                
                if (playerData) {
                    updates.$set[`PlayerInfo.${pid}`] = playerData;
                }
            }
        }

        if (incomingBattleStats) {
            for (const [arenaId, battleData] of Object.entries(incomingBattleStats)) {
                if (Validators.validateBattleData(battleData)) {
                    const battleSource = battleData._id || battleData;
                    const sanitizedBattle = Validators.sanitizeBattleFields(battleSource);
                    
                    updates.$set[`BattleStats.${arenaId}.startTime`] = sanitizedBattle.startTime;
                    updates.$set[`BattleStats.${arenaId}.duration`] = sanitizedBattle.duration;
                    updates.$set[`BattleStats.${arenaId}.win`] = sanitizedBattle.win;
                    updates.$set[`BattleStats.${arenaId}.mapName`] = sanitizedBattle.mapName;

                    if (battleSource.players) {
                        for (const [pId, pData] of Object.entries(battleSource.players)) {
                            const actualPlayerData = dataProcessor.extractPlayerData(pData);
                            
                            if (actualPlayerData && typeof actualPlayerData === 'object') {
                                const processedPlayerData = {
                                    name: actualPlayerData.name || 'Unknown Player',
                                    damage: this.parseValue(actualPlayerData.damage) || 0,
                                    kills: this.parseValue(actualPlayerData.kills || actualPlayerData.frags) || 0,
                                    points: this.parseValue(actualPlayerData.points) || 0,
                                    vehicle: actualPlayerData.vehicle || 'Unknown Vehicle'
                                };
                                
                                updates.$set[`BattleStats.${arenaId}.players.${pId}`] = processedPlayerData;
                            }
                        }
                    }
                }
            }
        }

        return updates;
    }

    async processDataAsync(key, requestData) {
        try {
            const updates = await this.prepareUpdates(key, requestData);
            
            if (!updates || (Object.keys(updates.$set).length === 0 && Object.keys(updates.$unset || {}).length === 0)) {
                return false;
            }

            await this.addToPendingUpdates(key, updates);
            notificationService.notifyStatsUpdated(key);
            
            return true;
        } catch (error) {
            console.error(`Критична помилка в processDataAsync для ключа ${key}:`, error);
            return false;
        }
    }

    parseValue(value) {
        if (value && typeof value === 'object') {
            if (value.$numberDouble) {
                const parsed = parseFloat(value.$numberDouble);
                return isNaN(parsed) ? 0 : parsed;
            }
            if (value.$numberInt) {
                const parsed = parseInt(value.$numberInt);
                return isNaN(parsed) ? 0 : parsed;
            }
            if (value.$numberLong) {
                const parsed = Number(value.$numberLong);
                return isNaN(parsed) ? 0 : parsed;
            }
            return value;
        }
        return value;
    }

    async getStats(key, page, limit) {
        let statsDoc;
        let fullDoc = await battleStatsRepository.findByKey(key);

        try {
            if (limit === 0) {
                statsDoc = fullDoc || {};
            } else {
                const results = await battleStatsRepository.getPaginatedBattles(key, page, limit);
                statsDoc = results.length > 0 ? results[0] : {};
            }
            
            statsDoc.PlayerInfo = fullDoc ? fullDoc.PlayerInfo : {};
            
            if (!statsDoc || Object.keys(statsDoc).length === 0) {
                return {
                    success: true,
                    BattleStats: {},
                    PlayerInfo: {}
                };
            }
            
            DataTransformer.ensureMapStructure(statsDoc);
            const { cleanBattleStats, cleanPlayerInfo } = DataTransformer.convertMapsToObjects(statsDoc);

            return {
                success: true,
                BattleStats: cleanBattleStats,
                PlayerInfo: cleanPlayerInfo
            };
        } catch (error) {
            console.error('Помилка в getStats:', error);
            throw error;
        }
    }

    async getOtherPlayersStats(key, excludePlayerId) {
        try {
            const statsDoc = await battleStatsRepository.findByKey(key);

            if (!statsDoc) {
                return {
                    success: true,
                    BattleStats: {}
                };
            }

            const cleanBattleStats = {};

            if (statsDoc.BattleStats instanceof Map) {
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
            } else if (statsDoc.BattleStats && typeof statsDoc.BattleStats === 'object') {
                Object.entries(statsDoc.BattleStats).forEach(([battleId, battle]) => {
                    const otherPlayersData = {};
                    let hasOtherPlayers = false;

                    if (battle && battle.players) {
                        Object.entries(battle.players).forEach(([pid, playerData]) => {
                            if (pid !== excludePlayerId) {
                                otherPlayersData[pid] = playerData;
                                hasOtherPlayers = true;
                            }
                        });
                    }

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
            }

            return {
                success: true,
                BattleStats: cleanBattleStats
            };
        } catch (error) {
            console.error('Помилка в getOtherPlayersStats:', error);
            throw error;
        }
    }

    async importStats(key, importData) {
        if (!importData || typeof importData !== 'object') {
            throw new Error('Невалідні дані для імпорту');
        }

        try {
            const updates = { $set: {} };
            const { PlayerInfo, BattleStats: importBattleStats } = importData;

            if (PlayerInfo && typeof PlayerInfo === 'object') {
                Object.entries(PlayerInfo).forEach(([playerId, nickname]) => {
                    updates.$set[`PlayerInfo.${playerId}`] = { _id: nickname };
                });
            }

            if (importBattleStats && typeof importBattleStats === 'object') {
                Object.entries(importBattleStats).forEach(([battleId, raw]) => {
                    const base = (raw && typeof raw === 'object' && raw._id && typeof raw._id === 'object') ? raw._id : raw;
                    const playersSource = (base.players && typeof base.players === 'object')
                        ? base.players
                        : (raw.players && typeof raw.players === 'object')
                            ? raw.players
                            : {};

                    const playersObj = {};
                    Object.entries(playersSource).forEach(([pid, playerData]) => {
                        playersObj[pid] = playerData;
                    });

                    updates.$set[`BattleStats.${battleId}`] = {
                        startTime: base.startTime,
                        duration: base.duration,
                        win: base.win,
                        mapName: base.mapName,
                        players: playersObj
                    };
                });
            }

            await battleStatsRepository.updateBattleStats(key, updates);
            
            return { success: true };
        } catch (error) {
            console.error('Помилка в importStats:', error);
            throw error;
        }
    }

    async clearStats(key) {
        try {
            await battleStatsRepository.clearStats(key);
            notificationService.notifyStatsCleared(key);
            return { success: true };
        } catch (error) {
            console.error('Помилка в clearStats:', error);
            throw error;
        }
    }

    async deleteBattle(key, battleId) {
        try {
            await battleStatsRepository.deleteBattle(key, battleId);
            notificationService.notifyBattleDeleted(key, battleId);
            return { success: true };
        } catch (error) {
            console.error('Помилка в deleteBattle:', error);
            throw error;
        }
    }

    async clearDatabase() {
        try {
            await battleStatsRepository.dropDatabase();
            notificationService.notifyDatabaseCleared();
            return { success: true, message: 'База даних успішно очищена' };
        } catch (error) {
            console.error('Помилка в clearDatabase:', error);
            throw error;
        }
    }

    async flushPendingUpdates() {
        const promises = [];
        for (const key of this.pendingUpdates.keys()) {
            promises.push(this.processPendingUpdates(key));
        }
        await Promise.all(promises);
    }

    destroy() {
        clearInterval(this.cleanupInterval);
        this.flushPendingUpdates();
    }
}

const battleStatsService = new BattleStatsService();

module.exports = battleStatsService;