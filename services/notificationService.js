class NotificationService {
    constructor() {
        this.globalIo = null;
    }

    setIo(io) {
        this.globalIo = io;
        console.log('📡 IO інстанс встановлено в NotificationService');
    }

    notifyStatsUpdated(key, playerId) {
        if (!this.globalIo) return;
        
        const updateData = {
            key,
            playerId,
            timestamp: Date.now()
        };
        
        setImmediate(() => {
            try {
                this.globalIo.emit('statsUpdated', updateData);
            } catch (error) {
                console.error('Помилка при розсилці через WebSocket:', error);
            }
        });
    }

    notifyStatsCleared(key) {
        if (!this.globalIo) return;
        
        this.globalIo.emit('statsCleared', {
            key,
            timestamp: Date.now()
        });
    }

    notifyBattleDeleted(key, battleId) {
        if (!this.globalIo) return;
        
        this.globalIo.emit('battleDeleted', {
            key,
            battleId,
            timestamp: Date.now()
        });
    }

    notifyDatabaseCleared() {
        if (!this.globalIo) return;
        
        this.globalIo.emit('databaseCleared', {
            timestamp: Date.now()
        });
    }
}

module.exports = new NotificationService();