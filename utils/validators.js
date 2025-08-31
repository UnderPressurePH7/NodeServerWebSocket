class Validators {
    static validateBattleData(battleData) {
        return battleData && typeof battleData === 'object';
    }

    static validatePlayerData(playerData) {
        return playerData && 
               typeof playerData === 'object' && 
               typeof playerData.name === 'string';
    }

    static validateBattleFields(battle) {
        const errors = [];
        
        if (battle.duration === undefined || battle.duration === null || isNaN(battle.duration)) {
            errors.push('Invalid duration');
        }
        
        if (battle.win === undefined || battle.win === null || isNaN(battle.win)) {
            errors.push('Invalid win status');
        }
        
        if (battle.startTime === undefined || battle.startTime === null || isNaN(battle.startTime)) {
            errors.push('Invalid startTime');
        }
        
        return errors;
    }

    static sanitizeBattleFields(battle) {
        return {
            duration: battle.duration || 0,
            win: battle.win !== undefined ? battle.win : -1,
            startTime: battle.startTime || Date.now(),
            mapName: battle.mapName || 'Unknown Map'
        };
    }
}

module.exports = Validators;