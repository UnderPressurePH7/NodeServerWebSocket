const battleStatsRepository = require('../repositories/battleStatsRepository');
const notificationService = require('./notificationService');
const dataProcessor = require('./dataProcessor');
const DataTransformer = require('../utils/dataTransformer');

class BattleStatsService {
    setIo(io) {
        notificationService.setIo(io);
        console.log('📡 IO інстанс передано в BattleStatsService');
    }

    async processDataAsync(key, playerId, requestData) {
        try {
            const { BattleStats: incomingBattleStats, PlayerInfo: incomingPlayerInfo } = requestData || {};
            if (!incomingBattleStats && !incomingPlayerInfo) {
                return false;
            }

            const updates = { $set: {}, $unset: {} };
            let modified = false;

            if (incomingPlayerInfo) {
                 for (const [pid, pInfo] of Object.entries(incomingPlayerInfo)) {
                    let playerData;
                    if (typeof pInfo === 'string') {
                        playerData = { _id: pInfo };
                    } else if (pInfo && typeof pInfo === 'object' && pInfo._id) {
                        playerData = { _id: pInfo._id };
                    }
                    if (playerData) {
                        updates.$set[`PlayerInfo.${pid}`] = playerData;
                        modified = true;
                    }
                }
            }

            if (incomingBattleStats) {
                for (const [arenaId, battleData] of Object.entries(incomingBattleStats)) {
                    if (dataProcessor.validateBattleData(battleData)) {
                        const battleSource = battleData._id || battleData;
                        const sanitizedBattle = dataProcessor.sanitizeBattleFields(battleSource);
                         updates.$set[`BattleStats.${arenaId}.startTime`] = sanitizedBattle.startTime;
                         updates.$set[`BattleStats.${arenaId}.duration`] = sanitizedBattle.duration;
                         updates.$set[`BattleStats.${arenaId}.win`] = sanitizedBattle.win;
                         updates.$set[`BattleStats.${arenaId}.mapName`] = sanitizedBattle.mapName;

                        if (battleSource.players) {
                            for (const [pId, pData] of Object.entries(battleSource.players)) {
                                const actualPlayerData = dataProcessor.extractPlayerData(pData);
                                if (actualPlayerData && typeof actualPlayerData === 'object') {
                                    updates.$set[`BattleStats.${arenaId}.players.${pId}`] = {
                                        name: actualPlayerData.name || 'Unknown Player',
                                        damage: dataProcessor.parseValue(actualPlayerData.damage) || 0,
                                        kills: dataProcessor.parseValue(actualPlayerData.kills || actualPlayerData.frags) || 0,
                                        points: dataProcessor.parseValue(actualPlayerData.points) || 0,
                                        vehicle: actualPlayerData.vehicle || 'Unknown Vehicle'
                                    };
                                }
                            }
                        }
                        modified = true;
                    }
                }
            }

            if (modified) {
                await battleStatsRepository.updateBattleStats(key, updates);
                notificationService.notifyStatsUpdated(key, playerId);
            }

            return true;
        } catch (error) {
            console.error(`❌ Помилка при обробці даних для ключа ${key}:`, error);
            return false;
        }
    }

    async getStats(key, page, limit) {
        let statsDoc;
        if (limit === 0) {
            statsDoc = await battleStatsRepository.findByKey(key);
        } else {
            const results = await battleStatsRepository.getPaginatedBattles(key, page, limit);
            statsDoc = results[0];
        }

        if (!statsDoc) {
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
    }

    async getOtherPlayersStats(key, excludePlayerId) {
        const statsDoc = await battleStatsRepository.findByKey(key);

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

        let statsDoc = await battleStatsRepository.findOrCreate(key);
        const { PlayerInfo, BattleStats: importBattleStats } = importData;

        if (PlayerInfo && typeof PlayerInfo === 'object') {
            Object.entries(PlayerInfo).forEach(([playerId, nickname]) => {
                statsDoc.PlayerInfo.set(playerId, nickname);
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
        }

        await battleStatsRepository.save(statsDoc);
        return { success: true };
    }

    async clearStats(key) {
        await battleStatsRepository.clearStats(key);
        notificationService.notifyStatsCleared(key);
        return { success: true };
    }

    async deleteBattle(key, battleId) {
        await battleStatsRepository.deleteBattle(key, battleId);
        notificationService.notifyBattleDeleted(key, battleId);
        return { success: true };
    }

    async clearDatabase() {
        await battleStatsRepository.dropDatabase();
        notificationService.notifyDatabaseCleared();
        return { success: true, message: 'База даних успішно очищена' };
    }
}

module.exports = new BattleStatsService();