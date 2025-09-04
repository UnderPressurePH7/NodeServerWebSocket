const BattleStats = require('../models/BattleStats');
const mongoose = require('mongoose');

class BattleStatsRepository {
    async findByKey(key) {
        try {
            const result = await BattleStats.findById(key);
            console.log('🔍 findByKey результат:', {
                key,
                found: !!result,
                battleStatsType: result ? typeof result.BattleStats : 'none',
                playerInfoType: result ? typeof result.PlayerInfo : 'none',
                battleStatsKeys: result && result.BattleStats ? Object.keys(result.BattleStats) : [],
                playerInfoKeys: result && result.PlayerInfo ? Object.keys(result.PlayerInfo) : []
            });
            return result;
        } catch (error) {
            console.error('❌ Помилка в findByKey:', error);
            throw error;
        }
    }

    async findOrCreate(key) {
        let statsDoc = await this.findByKey(key);
        if (!statsDoc) {
            console.log('📄 Створюємо новий документ для ключа:', key);
            statsDoc = new BattleStats({
                _id: key,
                BattleStats: new Map(),
                PlayerInfo: new Map()
            });
        }
        return statsDoc;
    }

    async getPaginatedBattles(key, page = 1, limit = 10) {
        console.log('📊 getPaginatedBattles початок:', { key, page, limit });
        
        try {
            const fullDoc = await this.findByKey(key);
            
            if (!fullDoc) {
                console.log('❌ Документ не знайдено для пагінації');
                return [];
            }

            console.log('📊 Повний документ отримано:', {
                hasBattleStats: !!fullDoc.BattleStats,
                hasPlayerInfo: !!fullDoc.PlayerInfo,
                battleStatsType: typeof fullDoc.BattleStats,
                playerInfoType: typeof fullDoc.PlayerInfo
            });

            let battlesArray = [];
            
            if (fullDoc.BattleStats) {
                if (fullDoc.BattleStats instanceof Map) {
                    console.log('🔄 BattleStats це Map, конвертуємо...');
                    for (const [battleId, battleData] of fullDoc.BattleStats) {
                        battlesArray.push({
                            battleId,
                            battleData,
                            startTime: battleData.startTime || 0
                        });
                    }
                } else if (typeof fullDoc.BattleStats === 'object') {
                    console.log('🔄 BattleStats це Object, конвертуємо...');
                    for (const [battleId, battleData] of Object.entries(fullDoc.BattleStats)) {
                        battlesArray.push({
                            battleId,
                            battleData,
                            startTime: battleData.startTime || 0
                        });
                    }
                }
            }

            console.log('📊 Масив боїв створено:', {
                totalBattles: battlesArray.length,
                sampleBattles: battlesArray.slice(0, 3).map(b => ({
                    id: b.battleId,
                    startTime: b.startTime
                }))
            });

            battlesArray.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

            const skip = (page - 1) * limit;
            const paginatedBattles = battlesArray.slice(skip, skip + limit);

            console.log('📊 Пагінація застосована:', {
                total: battlesArray.length,
                skip,
                limit,
                returned: paginatedBattles.length
            });

            const result = {
                _id: key,
                BattleStats: new Map(),
                PlayerInfo: fullDoc.PlayerInfo || new Map()
            };

            paginatedBattles.forEach(({ battleId, battleData }) => {
                result.BattleStats.set(battleId, battleData);
            });

            console.log('✅ getPaginatedBattles завершено:', {
                resultBattleStatsSize: result.BattleStats.size,
                resultPlayerInfoSize: result.PlayerInfo ? result.PlayerInfo.size : 0
            });

            return [result];
            
        } catch (error) {
            console.error('❌ Помилка в getPaginatedBattles:', error);
            
            console.log('🔄 Fallback: повертаємо весь документ');
            const fallbackDoc = await this.findByKey(key);
            return fallbackDoc ? [fallbackDoc] : [];
        }
    }

    async updateBattleStats(key, updates) {
        try {
            console.log('💾 updateBattleStats:', {
                key,
                setOperations: Object.keys(updates.$set || {}).length,
                unsetOperations: Object.keys(updates.$unset || {}).length
            });
            
            const result = await BattleStats.updateOne({ _id: key }, updates, { upsert: true });
            
            console.log('✅ updateBattleStats результат:', {
                acknowledged: result.acknowledged,
                matchedCount: result.matchedCount,
                modifiedCount: result.modifiedCount,
                upsertedCount: result.upsertedCount
            });
            
            return result;
        } catch (error) {
            console.error('❌ Помилка в updateBattleStats:', error);
            throw error;
        }
    }

    async save(statsDoc) {
        try {
            console.log('💾 Збереження документа:', {
                id: statsDoc._id,
                battleStatsSize: statsDoc.BattleStats instanceof Map ? statsDoc.BattleStats.size : Object.keys(statsDoc.BattleStats || {}).length,
                playerInfoSize: statsDoc.PlayerInfo instanceof Map ? statsDoc.PlayerInfo.size : Object.keys(statsDoc.PlayerInfo || {}).length
            });

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
            
            const result = await statsDoc.save();
            console.log('✅ Документ збережено успішно');
            return result;
        } catch (error) {
            console.error('❌ Помилка збереження:', error);
            throw error;
        }
    }

    async clearStats(key) {
        try {
            console.log('🗑️ Очищення статистики для ключа:', key);
            const result = await BattleStats.updateOne(
                { _id: key },
                { $set: { BattleStats: {}, PlayerInfo: {} } },
                { upsert: true }
            );
            console.log('✅ Статистика очищена:', result);
            return result;
        } catch (error) {
            console.error('❌ Помилка очищення статистики:', error);
            throw error;
        }
    }

    async deleteBattle(key, battleId) {
        try {
            console.log('🗑️ Видалення бою:', { key, battleId });
            const result = await BattleStats.updateOne(
                { _id: key },
                { $unset: { [`BattleStats.${battleId}`]: "" } }
            );
            console.log('✅ Бій видалено:', result);
            return result;
        } catch (error) {
            console.error('❌ Помилка видалення бою:', error);
            throw error;
        }
    }

    async dropDatabase() {
        try {
            console.log('🗑️ Видалення всієї бази даних');
            const result = await mongoose.connection.db.dropDatabase();
            console.log('✅ База даних видалена');
            return result;
        } catch (error) {
            console.error('❌ Помилка видалення БД:', error);
            throw error;
        }
    }

    async getStatsRaw(key) {
        try {
            const result = await BattleStats.findById(key).lean();
            console.log('🔍 getStatsRaw:', {
                key,
                found: !!result,
                battleStatsKeys: result ? Object.keys(result.BattleStats || {}) : [],
                playerInfoKeys: result ? Object.keys(result.PlayerInfo || {}) : []
            });
            return result;
        } catch (error) {
            console.error('❌ Помилка в getStatsRaw:', error);
            throw error;
        }
    }
}

module.exports = new BattleStatsRepository();