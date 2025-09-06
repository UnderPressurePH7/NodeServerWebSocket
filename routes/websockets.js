const { unifiedAuth, cleanupSession } = require('../middleware/unifiedAuth');
const battleStatsService = require('../services/battleStatsService');
const { queue, isQueueFull } = require('../config/queue');
const metrics = require('../config/metrics');
const ResponseUtils = require('../utils/responseUtils');
const AuthValidationUtils = require('../utils/authValidationUtils');

const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024;

class WebSocketHandler {
    constructor(io) {
        this.io = io;
        this.connectedClients = new Map();
        setInterval(() => this.cleanupDeadClients(), 300000);
    }

    async cleanupDeadClients() {
        if (!this.io) return;
        
        try {
            const connectedSocketIds = new Set(Object.keys(this.io.sockets.sockets));
            const cleanupPromises = [];
            
            for (const socketId of this.connectedClients.keys()) {
                if (!connectedSocketIds.has(socketId)) {
                    this.connectedClients.delete(socketId);
                    cleanupPromises.push(cleanupSession(socketId));
                }
            }
            
            await Promise.allSettled(cleanupPromises);
        } catch (error) {
            console.error('Помилка при очищенні клієнтів:', error);
        }
    }

    checkPayloadSize(data) {
        try {
            const size = JSON.stringify(data).length;
            return size <= MAX_PAYLOAD_SIZE;
        } catch (error) {
            console.error('Помилка при перевірці розміру payload:', error);
            return false;
        }
    }

    async validateRequest(socket, data, callback, requiresPlayerId = false) {
        if (!data || typeof data !== 'object') {
            ResponseUtils.wsError(callback, 400, 'Невалідні дані запиту');
            return false;
        }

        if (!this.checkPayloadSize(data)) {
            ResponseUtils.wsError(callback, 413, 'Розмір даних перевищує ліміт');
            return false;
        }

        const messageAuthData = AuthValidationUtils.extractAuthData(data);
        
        let finalAuthData = messageAuthData;
        if (socket.authKey) {
            finalAuthData = {
                ...messageAuthData,
                [socket.authType === 'secret_key' ? 'secretKey' : 'apiKey']: socket.authKey
            };
        }

        const isServerMode = socket.authType === 'secret_key' || !!finalAuthData.secretKey;
        
        const validation = AuthValidationUtils.validateAuthForContext(
            finalAuthData,
            isServerMode, 
            requiresPlayerId
        );

        if (!validation.isValid) {
            ResponseUtils.wsError(callback, 403, validation.errors.join('; '));
            return false;
        }

        if (!await unifiedAuth.validateSocketMessage(socket, data, requiresPlayerId)) {
            ResponseUtils.wsError(callback, 429, 'Перевищено ліміт запитів або помилка автентифікації');
            return false;
        }

        return true;
    }

    async handleUpdateStats(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback, false)) return;
        if (isQueueFull()) return ResponseUtils.wsError(callback, 503, 'Сервер перевантажено, спробуйте пізніше');
        
        try {
            metrics.totalRequests++;
            
            if (typeof callback === 'function') {
                callback({
                    status: 202,
                    success: true,
                    message: 'Запит прийнято на обробку',
                    queueSize: queue.size,
                    timestamp: new Date().toISOString()
                });
            }
            
            const roomKey = socket.authType === 'secret_key' ? data.gameKey || socket.authKey : socket.authKey;
            
            await queue.add(async () => {
                try {
                    const result = await battleStatsService.processDataAsync(roomKey, data.body || data);
                    if (result) {
                        metrics.successfulRequests++;
                        this.io.to(`stats_${roomKey}`).emit('statsUpdated', { 
                            key: roomKey, 
                            timestamp: Date.now() 
                        });
                    } else {
                        metrics.failedRequests++;
                        socket.emit('updateError', { 
                            key: roomKey, 
                            error: 'Обробка не вдалася', 
                            timestamp: Date.now() 
                        });
                    }
                } catch (error) {
                    metrics.failedRequests++;
                    socket.emit('updateError', { 
                        key: roomKey, 
                        error: error.message, 
                        timestamp: Date.now() 
                    });
                }
            });
        } catch (error) {
            ResponseUtils.wsError(callback, 500, 'Внутрішня помилка сервера', error);
        }
    }

    async handleGetStats(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback)) return;
        try {
            const page = parseInt(data.page) || 1;
            const limit = data.limit !== undefined ? parseInt(data.limit) : 100;
            const result = await battleStatsService.getStats(socket.authKey, page, limit);
            
            if (typeof callback === 'function') {
                callback({
                    status: 200,
                    success: true,
                    ...result,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            ResponseUtils.wsError(callback, 500, 'Помилка при завантаженні даних', error);
        }
    }

    async handleImportStats(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback)) return;
        try {
            if (typeof callback === 'function') {
                callback({
                    status: 202,
                    success: true,
                    message: 'Запит на імпорт прийнято',
                    timestamp: new Date().toISOString()
                });
            }
            await battleStatsService.importStats(socket.authKey, data.body || data.importData);
            socket.emit('importCompleted', { key: socket.authKey, timestamp: Date.now() });
        } catch (error) {
            socket.emit('importError', { key: socket.authKey, error: error.message, timestamp: Date.now() });
        }
    }

    async handleClearStats(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback)) return;
        try {
            await battleStatsService.clearStats(socket.authKey);
            
            if (typeof callback === 'function') {
                callback({
                    status: 200,
                    success: true,
                    message: `Дані для ключа ${socket.authKey} успішно очищено`,
                    timestamp: new Date().toISOString()
                });
            }
            
            this.io.to(`stats_${socket.authKey}`).emit('statsCleared', { key: socket.authKey, timestamp: Date.now() });
        } catch (error) {
            ResponseUtils.wsError(callback, 500, 'Помилка при очищенні даних', error);
        }
    }

    async handleDeleteBattle(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback)) return;
        if (!data.battleId) {
            ResponseUtils.wsError(callback, 400, 'Відсутній ID бою');
            return;
        }
        try {
            await battleStatsService.deleteBattle(socket.authKey, data.battleId);
            
            if (typeof callback === 'function') {
                callback({
                    status: 200,
                    success: true,
                    message: `Бій ${data.battleId} успішно видалено`,
                    timestamp: new Date().toISOString()
                });
            }
            
            this.io.to(`stats_${socket.authKey}`).emit('battleDeleted', { key: socket.authKey, battleId: data.battleId, timestamp: Date.now() });
        } catch (error) {
            ResponseUtils.wsError(callback, 500, 'Помилка при видаленні бою', error);
        }
    }

    async handleClearDatabase(socket, data, callback) {
        const authData = AuthValidationUtils.extractAuthData(data);
        const validation = AuthValidationUtils.validateAuthForContext(authData, true, false);
        
        if (!validation.isValid) {
            ResponseUtils.wsError(callback, 403, 'Операція потребує секретний ключ');
            return;
        }

        try {
            const result = await battleStatsService.clearDatabase();
            
            if (typeof callback === 'function') {
                callback({
                    status: 200,
                    success: true,
                    ...result,
                    timestamp: new Date().toISOString()
                });
            }
            
            this.io.emit('databaseCleared', { timestamp: Date.now() });
        } catch (error) {
            ResponseUtils.wsError(callback, 500, 'Помилка при очищенні бази даних', error);
        }
    }

    handleGetQueueStatus(socket, callback) {
        const successRate = metrics.totalRequests > 0 ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2) : '0';
        
        if (typeof callback === 'function') {
            callback({
                status: 200,
                success: true,
                queueSize: queue.size,
                pendingCount: queue.pending,
                isPaused: queue.isPaused,
                metrics: {
                    totalRequests: metrics.totalRequests,
                    successfulRequests: metrics.successfulRequests,
                    failedRequests: metrics.failedRequests,
                    successRate: `${successRate}%`
                },
                timestamp: new Date().toISOString()
            });
        }
    }

    async handleJoinRoom(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback, false)) return;
        const roomKey = socket.authKey;
        const roomName = `stats_${roomKey}`;
        socket.join(roomName);
        this.connectedClients.set(socket.id, { key: roomKey, room: roomName, connectedAt: Date.now() });
        
        if (typeof callback === 'function') {
            callback({
                status: 200,
                success: true,
                message: `Приєднано до кімнати ${roomName}`,
                room: roomName,
                timestamp: new Date().toISOString()
            });
        }
    }

    handleLeaveRoom(socket, data, callback) {
        if (!data || !socket.authKey) {
            ResponseUtils.wsError(callback, 400, 'Відсутній ключ кімнати');
            return;
        }
        const roomName = `stats_${socket.authKey}`;
        socket.leave(roomName);
        
        if (typeof callback === 'function') {
            callback({
                status: 200,
                success: true,
                message: `Вийшли з кімнати ${roomName}`,
                timestamp: new Date().toISOString()
            });
        }
    }

    handleGetConnectedClients(socket, callback) {
        const clients = Array.from(this.connectedClients.entries()).map(([socketId, info]) => ({
            socketId,
            key: info.key,
            room: info.room,
            connectedAt: info.connectedAt,
            uptime: Date.now() - info.connectedAt
        }));
        
        if (typeof callback === 'function') {
            callback({
                status: 200,
                success: true,
                totalClients: this.io.engine.clientsCount,
                connectedClients: clients,
                timestamp: new Date().toISOString()
            });
        }
    }

    async handleDisconnect(socket, reason) {
        const clientInfo = this.connectedClients.get(socket.id);
        if (clientInfo) {
            await cleanupSession(socket.id);
            this.connectedClients.delete(socket.id);
        }
    }
}

function initializeWebSocket(io, redisClientInstance) {
    if (redisClientInstance) {
        unifiedAuth.setRedisClient(redisClientInstance);
    }
    
    battleStatsService.setIo(io);
    const wsHandler = new WebSocketHandler(io);
    
    io.use((socket, next) => unifiedAuth.authenticateSocket(socket, next));
    
    io.on('connection', (socket) => {
        socket.emit('connected', { 
            socketId: socket.id, 
            sessionId: socket.sessionId, 
            authType: socket.authType, 
            serverTime: Date.now(), 
            message: 'Успішно підключено до BattleStats WebSocket' 
        });
        
        socket.on('updateStats', (data, callback) => wsHandler.handleUpdateStats(socket, data, callback));
        socket.on('getStats', (data, callback) => wsHandler.handleGetStats(socket, data, callback));
        socket.on('importStats', (data, callback) => wsHandler.handleImportStats(socket, data, callback));
        socket.on('clearStats', (data, callback) => wsHandler.handleClearStats(socket, data, callback));
        socket.on('deleteBattle', (data, callback) => wsHandler.handleDeleteBattle(socket, data, callback));
        socket.on('clearDatabase', (data, callback) => wsHandler.handleClearDatabase(socket, data, callback));
        socket.on('getQueueStatus', (callback) => wsHandler.handleGetQueueStatus(socket, callback));
        socket.on('joinRoom', (data, callback) => wsHandler.handleJoinRoom(socket, data, callback));
        socket.on('leaveRoom', (data, callback) => wsHandler.handleLeaveRoom(socket, data, callback));
        socket.on('getConnectedClients', (callback) => wsHandler.handleGetConnectedClients(socket, callback));
        socket.on('ping', (callback) => {
            const response = { 
                status: 200, 
                success: true, 
                message: 'pong', 
                serverTime: Date.now(), 
                clientId: socket.id, 
                authType: socket.authType 
            };
            if (typeof callback === 'function') callback(response); 
            else socket.emit('pong', response);
        });
        socket.on('disconnect', (reason) => wsHandler.handleDisconnect(socket, reason));
        socket.on('error', (error) => {});
    });
    
    io.engine.on('connection_error', (err) => {});
}

function getIo() {
    return this.io;
}

function broadcastToRoom(io, room, event, data) {
    if (io) io.to(room).emit(event, data);
}

function broadcastGlobally(io, event, data) {
    if (io) io.emit(event, data);
}

module.exports = { initializeWebSocket, getIo, broadcastToRoom, broadcastGlobally };