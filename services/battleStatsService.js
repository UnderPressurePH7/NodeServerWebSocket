const battleStatsRepository = require('../repositories/battleStatsRepository');
const notificationService = require('./notificationService');
const dataProcessor = require('./dataProcessor');
const DataTransformer = require('../utils/dataTransformer');
const Validators = require('../utils/validators');

class BattleStatsService {
    setIo(io) {
        notificationService.setIo(io);
        console.log('📡 IO інстанс передано в BattleStatsService');
    }

    async processDataAsync(key, playerId, requestData) {
        console.log('🔄 BattleStatsService.processDataAsync початок:', {
            timestamp: new Date().toISOString(),
            key: key,
            playerId: playerId,
            hasRequestData: !!requestData,
            requestDataType: typeof requestData,
            requestDataKeys: requestData ? Object.keys(requestData) : [],
            requestDataStringified: requestData ? JSON.stringify(requestData).substring(0, 500) + '...' : 'null'
        });

        try {
            const { BattleStats: incomingBattleStats, PlayerInfo: incomingPlayerInfo } = requestData || {};
            
            console.log('📊 Розбір вхідних даних:', {
                hasBattleStats: !!incomingBattleStats,
                hasPlayerInfo: !!incomingPlayerInfo,
                battleStatsType: typeof incomingBattleStats,
                playerInfoType: typeof incomingPlayerInfo,
                battleStatsKeys: incomingBattleStats ? Object.keys(incomingBattleStats) : [],
                playerInfoKeys: incomingPlayerInfo ? Object.keys(incomingPlayerInfo) : [],
                battleStatsLength: incomingBattleStats ? Object.keys(incomingBattleStats).length : 0,
                playerInfoLength: incomingPlayerInfo ? Object.keys(incomingPlayerInfo).length : 0
            });

            if (!incomingBattleStats && !incomingPlayerInfo) {
                console.log('⚠️ Немає даних для обробки - ні BattleStats, ні PlayerInfo');
                return false;
            }

            const updates = { $set: {}, $unset: {} };
            let modified = false;

            if (incomingPlayerInfo) {
                console.log('🔄 Початок обробки PlayerInfo...');
                let playerInfoProcessed = 0;
                
                for (const [pid, pInfo] of Object.entries(incomingPlayerInfo)) {
                    console.log(`🔍 Обробка PlayerInfo для ${pid}:`, {
                        pInfo: pInfo,
                        pInfoType: typeof pInfo
                    });

                    let playerData;
                    if (typeof pInfo === 'string') {
                        playerData = { _id: pInfo };
                        console.log(`✅ PlayerInfo як рядок для ${pid}:`, playerData);
                    } else if (pInfo && typeof pInfo === 'object' && pInfo._id) {
                        playerData = { _id: pInfo._id };
                        console.log(`✅ PlayerInfo як об'ект для ${pid}:`, playerData);
                    } else {
                        console.log(`⚠️ Неправильний формат PlayerInfo для ${pid}:`, pInfo);
                        continue;
                    }
                    
                    if (playerData) {
                        updates.$set[`PlayerInfo.${pid}`] = playerData;
                        modified = true;
                        playerInfoProcessed++;
                        console.log(`✅ PlayerInfo додано до updates для ${pid}:`, playerData);
                    }
                }
                
                console.log(`📈 PlayerInfo обробка завершена: ${playerInfoProcessed} записів оброблено`);
            }

            if (incomingBattleStats) {
                console.log('🔄 Початок обробки BattleStats...');
                let battleStatsProcessed = 0;
                
                for (const [arenaId, battleData] of Object.entries(incomingBattleStats)) {
                    console.log(`🔍 Обробка BattleStats для ${arenaId}:`, {
                        battleData: battleData,
                        battleDataType: typeof battleData,
                        battleDataKeys: battleData ? Object.keys(battleData) : [],
                        hasPlayers: battleData && battleData.players ? true : false,
                        playersCount: battleData && battleData.players ? Object.keys(battleData.players).length : 0
                    });

                    if (Validators.validateBattleData(battleData)) {
                        console.log(`✅ Валідація пройдена для ${arenaId}`);
                        
                        const battleSource = battleData._id || battleData;
                        const sanitizedBattle = Validators.sanitizeBattleFields(battleSource);
                        
                        console.log(`📊 Санітизовані дані бою ${arenaId}:`, sanitizedBattle);
                        
                        updates.$set[`BattleStats.${arenaId}.startTime`] = sanitizedBattle.startTime;
                        updates.$set[`BattleStats.${arenaId}.duration`] = sanitizedBattle.duration;
                        updates.$set[`BattleStats.${arenaId}.win`] = sanitizedBattle.win;
                        updates.$set[`BattleStats.${arenaId}.mapName`] = sanitizedBattle.mapName;

                        console.log(`💾 Додано основні поля бою ${arenaId} до updates`);

                        if (battleSource.players) {
                            console.log(`🔄 Обробка гравців у бою ${arenaId}, кількість: ${Object.keys(battleSource.players).length}`);
                            let playersProcessed = 0;
                            
                            for (const [pId, pData] of Object.entries(battleSource.players)) {
                                console.log(`🔍 Обробка гравця ${pId} у бою ${arenaId}:`, {
                                    pData: pData,
                                    pDataType: typeof pData
                                });

                                const actualPlayerData = dataProcessor.extractPlayerData(pData);
                                console.log(`📊 Витягнуті дані гравця ${pId}:`, actualPlayerData);
                                
                                if (actualPlayerData && typeof actualPlayerData === 'object') {
                                    const processedPlayerData = {
                                        name: actualPlayerData.name || 'Unknown Player',
                                        damage: this.parseValue(actualPlayerData.damage) || 0,
                                        kills: this.parseValue(actualPlayerData.kills || actualPlayerData.frags) || 0,
                                        points: this.parseValue(actualPlayerData.points) || 0,
                                        vehicle: actualPlayerData.vehicle || 'Unknown Vehicle'
                                    };
                                    
                                    updates.$set[`BattleStats.${arenaId}.players.${pId}`] = processedPlayerData;
                                    playersProcessed++;
                                    
                                    console.log(`✅ Гравець ${pId} оброблений для бою ${arenaId}:`, processedPlayerData);
                                } else {
                                    console.log(`⚠️ Неможливо обробити дані гравця ${pId}:`, actualPlayerData);
                                }
                            }
                            
                            console.log(`📈 Гравці у бою ${arenaId} оброблені: ${playersProcessed} з ${Object.keys(battleSource.players).length}`);
                        } else {
                            console.log(`⚠️ Немає гравців у бою ${arenaId}`);
                        }
                        
                        modified = true;
                        battleStatsProcessed++;
                        console.log(`✅ Бій ${arenaId} повністю оброблений`);
                    } else {
                        console.log(`❌ Валідація не пройдена для ${arenaId}:`, battleData);
                    }
                }
                
                console.log(`📈 BattleStats обробка завершена: ${battleStatsProcessed} боїв оброблено`);
            }

            console.log('📊 Загальний стан обробки:', {
                modified: modified,
                updatesSetKeys: Object.keys(updates.$set),
                updatesUnsetKeys: Object.keys(updates.$unset),
                totalSetOperations: Object.keys(updates.$set).length,
                totalUnsetOperations: Object.keys(updates.$unset).length
            });

            if (modified) {
                console.log('💾 Починаємо збереження в БД для ключа:', key);
                console.log('🔍 Updates для БД:', {
                    setOperations: updates.$set,
                    unsetOperations: updates.$unset
                });
                
                const result = await battleStatsRepository.updateBattleStats(key, updates);
                console.log('✅ Дані збережено в БД:', {
                    key: key,
                    result: result,
                    acknowledged: result.acknowledged,
                    matchedCount: result.matchedCount,
                    modifiedCount: result.modifiedCount,
                    upsertedCount: result.upsertedCount,
                    upsertedId: result.upsertedId
                });
                
                console.log('📡 Відправляємо WebSocket нотифікацію...');
                notificationService.notifyStatsUpdated(key, playerId);
                console.log('✅ WebSocket нотифікацію відправлено');
            } else {
                console.log('⚠️ Немає змін для збереження - modified = false');
            }

            console.log('✅ processDataAsync завершено успішно:', {
                key: key,
                playerId: playerId,
                result: true,
                timestamp: new Date().toISOString()
            });

            return true;
        } catch (error) {
            console.error(`❌ Критична помилка в processDataAsync для ключа ${key}:`, {
                key: key,
                playerId: playerId,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            return false;
        }
    }

    parseValue(value) {
        console.log('🔧 Парсинг значення:', { value, type: typeof value });
        
        if (value && typeof value === 'object') {
            if (value.$numberDouble) {
                const parsed = parseFloat(value.$numberDouble);
                console.log(`✅ Парсинг $numberDouble: ${value.$numberDouble} -> ${parsed}`);
                return isNaN(parsed) ? 0 : parsed;
            }
            if (value.$numberInt) {
                const parsed = parseInt(value.$numberInt);
                console.log(`✅ Парсинг $numberInt: ${value.$numberInt} -> ${parsed}`);
                return isNaN(parsed) ? 0 : parsed;
            }
            if (value.$numberLong) {
                const parsed = Number(value.$numberLong);
                console.log(`✅ Парсинг $numberLong: ${value.$numberLong} -> ${parsed}`);
                return isNaN(parsed) ? 0 : parsed;
            }
            console.log(`🔄 Повертаємо об'єкт як є:`, value);
            return value;
        }
        console.log(`🔄 Повертаємо значення як є:`, value);
        return value;
    }

    async getStats(key, page, limit) {
        console.log('📤 BattleStatsService.getStats початок:', {
            timestamp: new Date().toISOString(),
            key: key,
            page: page,
            limit: limit
        });

        let statsDoc;
        let fullDoc;
        try {
            console.log('🔍 Перевіряємо, що зберігається в БД...');
            const rawData = await battleStatsRepository.getStatsRaw(key);
            console.log('📊 Сирі дані з БД:', {
                hasRawData: !!rawData,
                rawBattleStatsType: rawData ? typeof rawData.BattleStats : 'none',
                rawPlayerInfoType: rawData ? typeof rawData.PlayerInfo : 'none',
                rawBattleStatsKeys: rawData && rawData.BattleStats ? Object.keys(rawData.BattleStats) : [],
                rawPlayerInfoKeys: rawData && rawData.PlayerInfo ? Object.keys(rawData.PlayerInfo) : []
            });

            if (limit === 0) {
                console.log('📊 Отримуємо всі дані (limit = 0)');
                statsDoc = await battleStatsRepository.findByKey(key);
            } else {
                console.log('📊 Отримуємо дані з пагінацією');
                const results = await battleStatsRepository.getPaginatedBattles(key, page, limit);
                
                fullDoc = await battleStatsRepository.findByKey(key);
                statsDoc = results[0];
                statsDoc.PlayerInfo = fullDoc ? fullDoc.PlayerInfo : {};
            }

            console.log('📊 Результат з репозиторію:', {
                hasStatsDoc: !!statsDoc,
                statsDocType: typeof statsDoc,
                battleStatsType: statsDoc ? typeof statsDoc.BattleStats : 'none',
                playerInfoType: statsDoc ? typeof statsDoc.PlayerInfo : 'none',
                battleStatsIsMap: statsDoc ? statsDoc.BattleStats instanceof Map : false,
                playerInfoIsMap: statsDoc ? statsDoc.PlayerInfo instanceof Map : false
            });

            if (!statsDoc) {
                console.log('⚠️ Документ не знайдено, повертаємо порожній результат');
                return {
                    success: true,
                    BattleStats: {},
                    PlayerInfo: {}
                };
            }
            
            console.log('🔧 Забезпечуємо структуру Map...');
            DataTransformer.ensureMapStructure(statsDoc);
            
            console.log('📊 Після ensureMapStructure:', {
                battleStatsIsMap: statsDoc.BattleStats instanceof Map,
                playerInfoIsMap: statsDoc.PlayerInfo instanceof Map,
                battleStatsSize: statsDoc.BattleStats instanceof Map ? statsDoc.BattleStats.size : Object.keys(statsDoc.BattleStats || {}).length,
                playerInfoSize: statsDoc.PlayerInfo instanceof Map ? statsDoc.PlayerInfo.size : Object.keys(statsDoc.PlayerInfo || {}).length
            });
            
            console.log('🔧 Конвертуємо Maps у Objects...');
            const { cleanBattleStats, cleanPlayerInfo } = DataTransformer.convertMapsToObjects(statsDoc);

            console.log('✅ Результат після convertMapsToObjects:', {
                cleanBattleStatsKeys: Object.keys(cleanBattleStats),
                cleanPlayerInfoKeys: Object.keys(cleanPlayerInfo),
                battleStatsCount: Object.keys(cleanBattleStats).length,
                playerInfoCount: Object.keys(cleanPlayerInfo).length,
                sampleBattleStats: Object.keys(cleanBattleStats).slice(0, 3).map(key => ({
                    id: key,
                    data: cleanBattleStats[key]
                })),
                samplePlayerInfo: Object.keys(cleanPlayerInfo).slice(0, 3).map(key => ({
                    id: key,
                    data: cleanPlayerInfo[key]
                }))
            });

            const result = {
                success: true,
                BattleStats: cleanBattleStats,
                PlayerInfo: cleanPlayerInfo
            };

            console.log('📤 getStats завершено успішно');
            return result;
        } catch (error) {
            console.error('❌ Помилка в getStats:', {
                key: key,
                page: page,
                limit: limit,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async diagnoseData(key) {
        console.log('🔬 Діагностика даних для ключа:', key);
        
        try {
            const rawData = await battleStatsRepository.getStatsRaw(key);
            console.log('1️⃣ Сирі дані:', rawData);
            
            const foundData = await battleStatsRepository.findByKey(key);
            console.log('2️⃣ Знайдені дані:', {
                hasFound: !!foundData,
                battleStatsType: foundData ? typeof foundData.BattleStats : 'none',
                playerInfoType: foundData ? typeof foundData.PlayerInfo : 'none'
            });
            
            const paginatedData = await battleStatsRepository.getPaginatedBattles(key, 1, 10);
            console.log('3️⃣ Пагіновані дані:', {
                hasPaginated: paginatedData.length > 0,
                paginatedLength: paginatedData.length,
                firstResult: paginatedData[0] ? {
                    battleStatsType: typeof paginatedData[0].BattleStats,
                    playerInfoType: typeof paginatedData[0].PlayerInfo
                } : null
            });
            
            return {
                rawData,
                foundData: !!foundData,
                paginatedData: paginatedData.length > 0
            };
        } catch (error) {
            console.error('❌ Помилка діагностики:', error);
            throw error;
        }
    }

    async getOtherPlayersStats(key, excludePlayerId) {
        console.log('📤 BattleStatsService.getOtherPlayersStats початок:', {
            timestamp: new Date().toISOString(),
            key: key,
            excludePlayerId: excludePlayerId
        });

        try {
            const statsDoc = await battleStatsRepository.findByKey(key);

            if (!statsDoc) {
                console.log('⚠️ Документ не знайдено для getOtherPlayersStats');
                return {
                    success: true,
                    BattleStats: {}
                };
            }

            console.log('🔧 Фільтруємо дані інших гравців...');
            const cleanBattleStats = {};
            let totalBattles = 0;
            let filteredBattles = 0;

            if (statsDoc.BattleStats instanceof Map) {
                statsDoc.BattleStats.forEach((battle, battleId) => {
                    totalBattles++;
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
                        filteredBattles++;
                    }
                });
            } else if (statsDoc.BattleStats && typeof statsDoc.BattleStats === 'object') {
                Object.entries(statsDoc.BattleStats).forEach(([battleId, battle]) => {
                    totalBattles++;
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
                        filteredBattles++;
                    }
                });
            }

            console.log('✅ getOtherPlayersStats завершено:', {
                totalBattles: totalBattles,
                filteredBattles: filteredBattles,
                excludePlayerId: excludePlayerId
            });

            return {
                success: true,
                BattleStats: cleanBattleStats
            };
        } catch (error) {
            console.error('❌ Помилка в getOtherPlayersStats:', {
                key: key,
                excludePlayerId: excludePlayerId,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async importStats(key, importData) {
        console.log('📥 BattleStatsService.importStats початок:', {
            timestamp: new Date().toISOString(),
            key: key,
            hasImportData: !!importData,
            importDataType: typeof importData,
            importDataKeys: importData ? Object.keys(importData) : []
        });

        if (!importData || typeof importData !== 'object') {
            console.log('❌ Невалідні дані для імпорту');
            throw new Error('Невалідні дані для імпорту');
        }

        try {
            let statsDoc = await battleStatsRepository.findByKey(key);
            if (!statsDoc) {
                console.log('📄 Створюємо новий документ для імпорту');
                const BattleStats = require('../models/BattleStats');
                statsDoc = new BattleStats({
                    _id: key,
                    BattleStats: new Map(),
                    PlayerInfo: new Map()
                });
            }

            const { PlayerInfo, BattleStats: importBattleStats } = importData;

            console.log('🔧 Імпорт PlayerInfo...');
            if (PlayerInfo && typeof PlayerInfo === 'object') {
                let playerInfoImported = 0;
                Object.entries(PlayerInfo).forEach(([playerId, nickname]) => {
                    statsDoc.PlayerInfo.set(playerId, { _id: nickname });
                    playerInfoImported++;
                    console.log(`✅ PlayerInfo імпортовано: ${playerId} -> ${nickname}`);
                });
                console.log(`📈 PlayerInfo імпорт завершено: ${playerInfoImported} записів`);
            }

            console.log('🔧 Імпорт BattleStats...');
            if (importBattleStats && typeof importBattleStats === 'object') {
                let battleStatsImported = 0;
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
                    battleStatsImported++;
                    console.log(`✅ BattleStats імпортовано: ${battleId}`);
                });
                console.log(`📈 BattleStats імпорт завершено: ${battleStatsImported} боїв`);
            }

            console.log('💾 Зберігаємо імпортовані дані...');
            await battleStatsRepository.save(statsDoc);
            console.log('✅ Імпорт завершено успішно');
            
            return { success: true };
        } catch (error) {
            console.error('❌ Помилка в importStats:', {
                key: key,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async clearStats(key) {
        console.log('🗑️ BattleStatsService.clearStats початок:', {
            timestamp: new Date().toISOString(),
            key: key
        });

        try {
            await battleStatsRepository.clearStats(key);
            console.log('✅ Дані очищено для ключа:', key);
            
            notificationService.notifyStatsCleared(key);
            console.log('📡 WebSocket нотифікацію про очищення відправлено');
            
            return { success: true };
        } catch (error) {
            console.error('❌ Помилка в clearStats:', {
                key: key,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async deleteBattle(key, battleId) {
        console.log('🗑️ BattleStatsService.deleteBattle початок:', {
            timestamp: new Date().toISOString(),
            key: key,
            battleId: battleId
        });

        try {
            await battleStatsRepository.deleteBattle(key, battleId);
            console.log('✅ Бій видалено:', { key, battleId });
            
            notificationService.notifyBattleDeleted(key, battleId);
            console.log('📡 WebSocket нотифікацію про видалення бою відправлено');
            
            return { success: true };
        } catch (error) {
            console.error('❌ Помилка в deleteBattle:', {
                key: key,
                battleId: battleId,
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    async clearDatabase() {
        console.log('🗑️ BattleStatsService.clearDatabase початок:', {
            timestamp: new Date().toISOString()
        });

        try {
            await battleStatsRepository.dropDatabase();
            console.log('✅ База даних очищена повністю');
            
            notificationService.notifyDatabaseCleared();
            console.log('📡 WebSocket нотифікацію про очищення БД відправлено');
            
            return { success: true, message: 'База даних успішно очищена' };
        } catch (error) {
            console.error('❌ Помилка в clearDatabase:', {
                error: error.message,
                stack: error.stack,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }
}

module.exports = new BattleStatsService();