class DataTransformer {
    static ensureMapStructure(data) {
        if (!(data.BattleStats instanceof Map)) {
            data.BattleStats = new Map(Object.entries(data.BattleStats || {}));
        }
        
        if (!(data.PlayerInfo instanceof Map)) {
            data.PlayerInfo = new Map(Object.entries(data.PlayerInfo || {}));
        }

        for (const [battleId, battleData] of data.BattleStats) {
            if (battleData && battleData.players && !(battleData.players instanceof Map)) {
                battleData.players = new Map(Object.entries(battleData.players || {}));
            }
        }
        
        return data;
    }

    static convertMapsToObjects(statsDoc) {
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

        return { cleanBattleStats, cleanPlayerInfo };
    }
}

module.exports = DataTransformer;