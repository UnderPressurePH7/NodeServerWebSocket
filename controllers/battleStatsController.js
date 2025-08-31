const BattleStats = require('../models/BattleStats');
const queue = require('../config/queue');
const metrics = require('../config/metrics');
const mongoose = require('mongoose');

let globalIo = null;

function validateBattleData(battleData) {
    return battleData && typeof battleData === 'object';
}

function parseMongoValue(value) {
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

function parseMongoObject(obj) {
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
                            damage: parseMongoValue(playerData._id.damage),
                            kills: parseMongoValue(playerData._id.kills),
                            points: parseMongoValue(playerData._id.points),
                            vehicle: playerData._id.vehicle
                        }
                    };
                    parsed[key].set(playerId, parsedPlayerData);
                }
            }
        } else if (Array.isArray(value)) {
            parsed[key] = value.map(parseMongoObject);
        } else if (value && typeof value === 'object') {
            parsed[key] = parseMongoObject(value);
        } else {
            parsed[key] = parseMongoValue(value);
        }
    }
    return parsed;
}

async function processDataAsync(key, playerId, requestData) {
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

        // Переконуємося, що Map структури правильно відновлені
        if (!(statsDoc.BattleStats instanceof Map)) {
            statsDoc.BattleStats = new Map(Object.entries(statsDoc.BattleStats || {}));
        }
        if (!(statsDoc.PlayerInfo instanceof Map)) {
            statsDoc.PlayerInfo = new Map(Object.entries(statsDoc.PlayerInfo || {}));
        }

        // Також переконуємося, що players в кожному бою є Map
        for (const [battleId, battleData] of statsDoc.BattleStats) {
            if (battleData && battleData.players && !(battleData.players instanceof Map)) {
                battleData.players = new Map(Object.entries(battleData.players || {}));
            }
        }

        // Очистка існуючих неправильних значень в BattleStats
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
                if (validateBattleData(battleData)) {
                    const battleSource = battleData._id || battleData;
                    const existingBattle = statsDoc.BattleStats.get(arenaId);
                    
                    // Парсимо дані MongoDB типів
                    const incomingBattle = {
                        startTime: parseMongoValue(battleSource.startTime),
                        duration: parseMongoValue(battleSource.duration),
                        win: parseMongoValue(battleSource.win),
                        mapName: battleSource.mapName,
                        players: new Map()
                    };
                    
                    // Працюємо з оригінальним об'єктом
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
                    
                    // Переконуємося що battle має правильні типи
                    if (battle.win === undefined || battle.win === null || isNaN(battle.win)) {
                        battle.win = -1;
                    }
                    if (battle.duration === undefined || battle.duration === null || isNaN(battle.duration)) {
                        battle.duration = 0;
                    }
                    if (battle.startTime === undefined || battle.startTime === null || isNaN(battle.startTime)) {
                        battle.startTime = 0;
                    }
                    
                    // Оновлюємо startTime
                    if (incomingBattle.startTime > battle.startTime) {
                        battle.startTime = incomingBattle.startTime;
                        modified = true;
                    }
                    
                    // Оновлюємо duration
                    if (incomingBattle.duration > 0 && incomingBattle.duration > battle.duration) {
                        battle.duration = incomingBattle.duration;
                        modified = true;
                    }
                    
                    // Оновлюємо win
                    if (incomingBattle.win !== -1 && incomingBattle.win !== undefined && incomingBattle.win !== null && !isNaN(incomingBattle.win)) {
                        if (battle.win === -1 || battle.win !== incomingBattle.win) {
                            battle.win = incomingBattle.win;
                            modified = true;
                        }
                    }
                    
                    // Оновлюємо mapName
                    if (incomingBattle.mapName && 
                        (!battle.mapName || battle.mapName === 'Unknown Map' || battle.mapName === '')) {
                        battle.mapName = incomingBattle.mapName;
                        modified = true;
                    }
                    
                    // Обробляємо гравців
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
                        
                        // if (!statsDoc.PlayerInfo.has(playerId)) {
                        //     return;
                        // }
                        
                        const incomingPlayer = {
                            name: actualPlayerData.name || 'Unknown Player',
                            damage: parseMongoValue(actualPlayerData.damage) || 0,
                            kills: parseMongoValue(actualPlayerData.kills || actualPlayerData.frags) || 0,
                            points: parseMongoValue(actualPlayerData.points) || 0,
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
            // Примусово позначаємо всі Map поля як змінені
            statsDoc.markModified('BattleStats');
            statsDoc.markModified('PlayerInfo');
            
            // Додатково позначаємо кожен конкретний шлях як змінений
            for (const [battleId] of statsDoc.BattleStats) {
                statsDoc.markModified(`BattleStats.${battleId}`);
                statsDoc.markModified(`BattleStats.${battleId}.players`);
            }
            
            await statsDoc.save();

            if (globalIo) {
                const updateData = {
                    key: key,
                    playerId: playerId,
                    timestamp: Date.now()
                };
                
                setImmediate(() => {
                    try {
                        globalIo.emit('statsUpdated', updateData);
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

const battleStatsController = {
    updateStats: (req, res) => {
        const key = req.params.key;
        const playerId = req.headers['x-player-id'];

        if (!playerId) {
            return res.status(400).json({
                error: 'Bad Request',
                message: 'Відсутній ID гравця в заголовку запиту (X-Player-ID)',
            });
        }

        metrics.totalRequests++;
        res.status(202).json({
            success: true,
            message: 'Запит прийнято на обробку',
            queueSize: queue.size
        });

        queue.add(async () => {
            try {
                const result = await processDataAsync(key, playerId, req.body);
                if (result) {
                    metrics.successfulRequests++;
                } else {
                    metrics.failedRequests++;
                }
            } catch (error) {
                metrics.failedRequests++;
                console.error('Помилка асинхронної обробки:', error);
            }
        }).catch(err => {
            metrics.failedRequests++;
            console.error('Помилка в черзі:', err);
        });
    },

    getStats: async (req, res) => {
        try {
            const key = req.params.key;
            
            const statsDoc = await BattleStats.findById(key);

            if (!statsDoc) {
                return res.status(200).json({
                    success: true,
                    BattleStats: {},
                    PlayerInfo: {}
                });
            }

            // Відновлюємо Map структури після завантаження з MongoDB
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

            res.status(200).json({
                success: true,
                BattleStats: cleanBattleStats,
                PlayerInfo: cleanPlayerInfo
            });
        } catch (error) {
            console.error('Помилка при завантаженні даних:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Помилка при завантаженні даних'
            });
        }
    },

    getOtherPlayersStats: async (req, res) => {
        try {
            const key = req.params.key;
            const excludePlayerId = req.headers['x-player-id'];

            if (!excludePlayerId) {
                return res.status(400).json({
                    success: false,
                    message: 'Відсутній ID гравця в заголовку запиту (X-Player-ID)'
                });
            }

            const statsDoc = await BattleStats.findById(key);

            if (!statsDoc) {
                return res.status(200).json({
                    success: true,
                    BattleStats: {}
                });
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

            res.status(200).json({
                success: true,
                BattleStats: cleanBattleStats
            });
            
        } catch (error) {
            console.error('Помилка при завантаженні даних інших гравців:', error);
            res.status(500).json({
                error: 'Internal Server Error',
                message: 'Помилка при завантаженні даних інших гравців'
            });
        }
    },

    importStats: async (req, res) => {
        const key = req.params.key;

        res.status(202).json({
            success: true,
            message: 'Запит на імпорт прийнято'
        });

        try {
            const importData = req.body;

            if (!importData || typeof importData !== 'object') {
                return;
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
        } catch (error) {
            console.error('Помилка при імпорті даних:', error);
        }
    },

    clearStats: async (req, res) => {
        const key = req.params.key;
        res.status(200).json({
            success: true,
            message: `Запит на очищення даних для ключа ${key} прийнято`
        });

        try {
            await BattleStats.updateOne(
                { _id: key },
                { $set: { BattleStats: {}, PlayerInfo: {} } },
                { upsert: true }
            );
        } catch (error) {
            console.error('Помилка при очищенні даних:', error);
        }
    },

    deleteBattle: async (req, res) => {
        const key = req.params.key;
        const battleId = req.params.battleId;

        res.status(202).json({
            success: true,
            message: `Запит на видалення бою ${battleId} прийнято`
        });

        try {
            await BattleStats.updateOne(
                { _id: key },
                { $unset: { [`BattleStats.${battleId}`]: "" } }
            );
        } catch (error) {
            console.error('Помилка при видаленні бою:', error);
        }
    },

    clearDatabase: async (req, res) => {
        try {
            await mongoose.connection.db.dropDatabase();
            res.status(200).json({
                success: true,
                message: 'База даних успішно очищена',
            });
        } catch (error) {
            console.error('Помилка при очищенні бази даних:', error);
            res.status(500).json({
                success: false,
                message: 'Помилка при очищенні бази даних',
            });
        }
    },

    setIo: (io) => {
        globalIo = io;
        console.log('📡 IO інстанс встановлено в battleStatsController');
    }
};


module.exports = battleStatsController;
