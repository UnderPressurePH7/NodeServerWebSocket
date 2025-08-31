class MongoParser {
    static parseValue(value) {
        if (value && typeof value === 'object') {
            if (value.$numberDouble) return parseFloat(value.$numberDouble);
            if (value.$numberInt) return parseInt(value.$numberInt);
            if (value.$numberLong) return parseInt(value.$numberLong);
            return value;
        }
        return value;
    }

    static parseObject(obj) {
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
                                damage: this.parseValue(playerData._id.damage),
                                kills: this.parseValue(playerData._id.kills),
                                points: this.parseValue(playerData._id.points),
                                vehicle: playerData._id.vehicle
                            }
                        };
                        parsed[key].set(playerId, parsedPlayerData);
                    }
                }
            } else if (Array.isArray(value)) {
                parsed[key] = value.map(item => this.parseObject(item));
            } else if (value && typeof value === 'object') {
                parsed[key] = this.parseObject(value);
            } else {
                parsed[key] = this.parseValue(value);
            }
        }
        return parsed;
    }
}

module.exports = MongoParser;