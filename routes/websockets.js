const { validateKeySocket } = require('../middleware/auth');
const battleStatsService = require('../services/battleStatsService');
const queue = require('../config/queue');
const metrics = require('../config/metrics');

let globalIo;

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 5000;
const RATE_LIMIT_MAX = 10; 

class WebSocketHandler {
    constructor() {
        this.connectedClients = new Map();
    }

    checkRateLimit(socketId) {
        const now = Date.now();
        const socketData = rateLimitMap.get(socketId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
        
        if (now > socketData.resetTime) {
            socketData.count = 1;
            socketData.resetTime = now + RATE_LIMIT_WINDOW;
        } else {
            socketData.count++;
        }
        
        rateLimitMap.set(socketId, socketData);
        return socketData.count <= RATE_LIMIT_MAX;
    }

    cleanupRateLimit(socketId) {
        rateLimitMap.delete(socketId);
    }

    sendError(callback, status, message, error = null) {
        const errorResponse = {
            status,
            success: false,
            message,
            timestamp: new Date().toISOString()
        };
        
        if (error && process.env.NODE_ENV === 'development') {
            errorResponse.error = error.message;
        }
        
        if (typeof callback === 'function') {
            callback(errorResponse);
        }
    }

    sendSuccess(callback, data, status = 200) {
        const response = {
            status,
            success: true,
            timestamp: new Date().toISOString(),
            ...data
        };
        
        if (typeof callback === 'function') {
            callback(response);
        }
    }

    validateRequest(socket, data, callback, requiresPlayerId = false) {
        if (!this.checkRateLimit(socket.id)) {
            this.sendError(callback, 429, 'Перевищено ліміт запитів');
            return false;
        }

        if (!data || typeof data !== 'object') {
            this.sendError(callback, 400, 'Невалідні дані запиту');
            return false;
        }

        if (!data.key || !validateKeySocket(data.key)) {
            this.sendError(callback, 403, 'Невалідний API ключ');
            return false;
        }

        if (requiresPlayerId && !data.playerId) {
            this.sendError(callback, 400, 'Відсутній ID гравця');
            return false;
        }

        return true;
    }

    async handleUpdateStats(socket, data, callback) {
        console.log(`🚀 WS updateStats від ${socket.id} для ключа: ${data?.key}`);
        console.log(`📋 Дані:`, JSON.stringify(data, null, 2));
        console.log(`⏰ Час: ${new Date().toISOString()}`);

        if (!this.validateRequest(socket, data, callback, true)) {
            return;
        }

        try {
            metrics.totalRequests++;

            this.sendSuccess(callback, {
                message: 'Запит прийнято на обробку',
                queueSize: queue.size
            }, 202);

            queue.add(async () => {
                try {
                    const result = await battleStatsService.processDataAsync(
                        data.key, 
                        data.playerId, 
                        data.body || data
                    );

                    if (result) {
                        metrics.successfulRequests++;

                        socket.broadcast.emit('statsUpdated', {
                            key: data.key,
                            playerId: data.playerId,
                            timestamp: Date.now()
                        });
                    } else {
                        metrics.failedRequests++;
                    }
                } catch (error) {
                    metrics.failedRequests++;
                    console.error('❌ Помилка асинхронної обробки:', error);
                    
                    socket.emit('updateError', {
                        key: data.key,
                        playerId: data.playerId,
                        error: error.message,
                        timestamp: Date.now()
                    });
                }
            }).catch(err => {
                metrics.failedRequests++;
                console.error('❌ Помилка в черзі:', err);
                
                socket.emit('queueError', {
                    key: data.key,
                    error: err.message,
                    timestamp: Date.now()
                });
            });

        } catch (error) {
            console.error('❌ Помилка handleUpdateStats:', error);
            this.sendError(callback, 500, 'Внутрішня помилка сервера', error);
        }
    }

    async handleGetStats(socket, data, callback) {
        console.log(`📊 WS getStats від ${socket.id} для ключа: ${data?.key}`);

        if (!this.validateRequest(socket, data, callback)) {
            return;
        }

        try {
            const result = await battleStatsService.getStats(data.key);
            this.sendSuccess(callback, result);
        } catch (error) {
            console.error('❌ Помилка handleGetStats:', error);
            this.sendError(callback, 500, 'Помилка при завантаженні даних', error);
        }
    }

    async handleGetOtherPlayersStats(socket, data, callback) {
        console.log(`👥 WS getOtherPlayersStats від ${socket.id} для ключа: ${data?.key}`);

        if (!this.validateRequest(socket, data, callback, true)) {
            return;
        }

        try {
            const result = await battleStatsService.getOtherPlayersStats(data.key, data.playerId);
            this.sendSuccess(callback, result);
        } catch (error) {
            console.error('❌ Помилка handleGetOtherPlayersStats:', error);
            this.sendError(callback, 500, 'Помилка при завантаженні даних інших гравців', error);
        }
    }

    async handleImportStats(socket, data, callback) {
        console.log(`📥 WS importStats від ${socket.id} для ключа: ${data?.key}`);

        if (!this.validateRequest(socket, data, callback)) {
            return;
        }

        try {
            this.sendSuccess(callback, { message: 'Запит на імпорт прийнято' }, 202);

            await battleStatsService.importStats(data.key, data.body || data.importData);
            
            socket.emit('importCompleted', {
                key: data.key,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('❌ Помилка handleImportStats:', error);
            socket.emit('importError', {
                key: data.key,
                error: error.message,
                timestamp: Date.now()
            });
        }
    }

    async handleClearStats(socket, data, callback) {
        console.log(`🧹 WS clearStats від ${socket.id} для ключа: ${data?.key}`);

        if (!this.validateRequest(socket, data, callback)) {
            return;
        }

        try {
            await battleStatsService.clearStats(data.key);
            this.sendSuccess(callback, { 
                message: `Дані для ключа ${data.key} успішно очищено` 
            });

            globalIo.emit('statsCleared', {
                key: data.key,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('❌ Помилка handleClearStats:', error);
            this.sendError(callback, 500, 'Помилка при очищенні даних', error);
        }
    }

    async handleDeleteBattle(socket, data, callback) {
        console.log(`🗑️ WS deleteBattle від ${socket.id} для ключа: ${data?.key}`);

        if (!this.validateRequest(socket, data, callback)) {
            return;
        }

        if (!data.battleId) {
            this.sendError(callback, 400, 'Відсутній ID бою');
            return;
        }

        try {
            await battleStatsService.deleteBattle(data.key, data.battleId);
            this.sendSuccess(callback, { 
                message: `Бій ${data.battleId} успішно видалено` 
            });

            globalIo.emit('battleDeleted', {
                key: data.key,
                battleId: data.battleId,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('❌ Помилка handleDeleteBattle:', error);
            this.sendError(callback, 500, 'Помилка при видаленні бою', error);
        }
    }

    async handleClearDatabase(socket, data, callback) {
        console.log(`💥 WS clearDatabase від ${socket.id}`);

        try {
            const result = await battleStatsService.clearDatabase();
            this.sendSuccess(callback, result);

            globalIo.emit('databaseCleared', {
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('❌ Помилка handleClearDatabase:', error);
            this.sendError(callback, 500, 'Помилка при очищенні бази даних', error);
        }
    }

    handleGetQueueStatus(socket, callback) {
        const successRate = metrics.totalRequests > 0 
            ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2)
            : '0';

        this.sendSuccess(callback, {
            queueSize: queue.size,
            pendingCount: queue.pending,
            isPaused: queue.isPaused,
            metrics: {
                totalRequests: metrics.totalRequests,
                successfulRequests: metrics.successfulRequests,
                failedRequests: metrics.failedRequests,
                successRate: `${successRate}%`
            }
        });
    }

    handleJoinRoom(socket, data, callback) {
        if (!this.validateRequest(socket, data, callback)) {
            return;
        }

        const roomName = `stats_${data.key}`;
        socket.join(roomName);
        
        this.connectedClients.set(socket.id, {
            key: data.key,
            playerId: data.playerId,
            room: roomName,
            connectedAt: Date.now()
        });

        this.sendSuccess(callback, { 
            message: `Приєднано до кімнати ${roomName}`,
            room: roomName
        });

        console.log(`🏠 Клієнт ${socket.id} приєднався до кімнати ${roomName}`);
    }

    handleLeaveRoom(socket, data, callback) {
        if (!data || !data.key) {
            this.sendError(callback, 400, 'Відсутній ключ кімнати');
            return;
        }

        const roomName = `stats_${data.key}`;
        socket.leave(roomName);

        this.sendSuccess(callback, { 
            message: `Вийшли з кімнати ${roomName}` 
        });

        console.log(`🚪 Клієнт ${socket.id} вийшов з кімнати ${roomName}`);
    }

    handleGetConnectedClients(socket, callback) {
        const clients = Array.from(this.connectedClients.entries()).map(([socketId, info]) => ({
            socketId,
            key: info.key,
            playerId: info.playerId,
            room: info.room,
            connectedAt: info.connectedAt,
            uptime: Date.now() - info.connectedAt
        }));

        this.sendSuccess(callback, { 
            totalClients: globalIo.engine.clientsCount,
            connectedClients: clients
        });
    }
}

function initializeWebSocket(io) {
    globalIo = io;
    const wsHandler = new WebSocketHandler();
    
    battleStatsService.setIo(io);
    
    io.on('connection', (socket) => {
        console.log(`🔌 Клієнт підключився: ${socket.id}`);
        console.log(`🌐 Всього підключених: ${io.engine.clientsCount}`);
        console.log(`📡 Transport: ${socket.conn.transport.name}`);

        socket.emit('connected', {
            socketId: socket.id,
            serverTime: Date.now(),
            message: 'Успішно підключено до BattleStats WebSocket'
        });

        socket.on('updateStats', (data, callback) => {
            wsHandler.handleUpdateStats(socket, data, callback);
        });

        socket.on('getStats', (data, callback) => {
            wsHandler.handleGetStats(socket, data, callback);
        });

        socket.on('getOtherPlayersStats', (data, callback) => {
            wsHandler.handleGetOtherPlayersStats(socket, data, callback);
        });

        socket.on('importStats', (data, callback) => {
            wsHandler.handleImportStats(socket, data, callback);
        });

        socket.on('clearStats', (data, callback) => {
            wsHandler.handleClearStats(socket, data, callback);
        });

        socket.on('deleteBattle', (data, callback) => {
            wsHandler.handleDeleteBattle(socket, data, callback);
        });

        socket.on('clearDatabase', (data, callback) => {
            wsHandler.handleClearDatabase(socket, data, callback);
        });

        socket.on('getQueueStatus', (callback) => {
            wsHandler.handleGetQueueStatus(socket, callback);
        });

        socket.on('joinRoom', (data, callback) => {
            wsHandler.handleJoinRoom(socket, data, callback);
        });

        socket.on('leaveRoom', (data, callback) => {
            wsHandler.handleLeaveRoom(socket, data, callback);
        });

        socket.on('getConnectedClients', (callback) => {
            wsHandler.handleGetConnectedClients(socket, callback);
        });

        socket.on('ping', (callback) => {
            const response = {
                status: 200,
                success: true,
                message: 'pong',
                serverTime: Date.now(),
                clientId: socket.id
            };
            
            if (typeof callback === 'function') {
                callback(response);
            } else {
                socket.emit('pong', response);
            }
        });

        socket.on('disconnect', (reason) => {
            console.log(`❌ Клієнт відключився: ${socket.id}, причина: ${reason}`);
            
            wsHandler.cleanupRateLimit(socket.id);
            wsHandler.connectedClients.delete(socket.id);
            
            console.log(`🌐 Залишилось підключених: ${io.engine.clientsCount - 1}`);
        });

        socket.on('error', (error) => {
            console.error(`🚨 Помилка сокета ${socket.id}:`, error);
        });

        socket.conn.on('error', (error) => {
            console.error(`🔌 Помилка транспорту ${socket.id}:`, error);
        });

        socket.conn.on('close', (reason) => {
            console.log(`🔌 Транспорт закрито ${socket.id}:`, reason);
        });
    });

    io.engine.on('connection_error', (err) => {
        console.error('🚨 Помилка підключення Socket.IO:', err);
    });

    setInterval(() => {
        const now = Date.now();
        for (const [socketId, data] of rateLimitMap.entries()) {
            if (now > data.resetTime + RATE_LIMIT_WINDOW) {
                rateLimitMap.delete(socketId);
            }
        }
    }, 60000);

    console.log('🚀 WebSocket сервер повністю ініціалізовано');
}

function getIo() {
    return globalIo;
}

function broadcastToRoom(room, event, data) {
    if (globalIo) {
        globalIo.to(room).emit(event, data);
    }
}

function broadcastGlobally(event, data) {
    if (globalIo) {
        globalIo.emit(event, data);
    }
}

module.exports = { 
    initializeWebSocket, 
    getIo, 
    broadcastToRoom, 
    broadcastGlobally 
};