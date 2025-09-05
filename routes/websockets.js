const { validateKeySocket, validateSecretKeySocket, createSession, cleanupSession, authenticateSocketMessage } = require('../middleware/auth');
const battleStatsService = require('../services/battleStatsService');
const { queue, isQueueFull } = require('../config/queue');
const metrics = require('../config/metrics');

const RATE_LIMIT_MAX = 500;
const RATE_LIMIT_TTL = 20;
const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024;

let redisClient;

const setRedisClient = (client) => {
    redisClient = client;
};

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

    async checkRateLimit(socketId, key, playerId) {
        try {
            if (!redisClient || !redisClient.isOpen) return true;
            const rateLimitKey = `rate-limit-ws:${socketId}:${key}:${playerId || 'anonymous'}`;
            const count = await redisClient.incr(rateLimitKey);
            if (count === 1) await redisClient.expire(rateLimitKey, RATE_LIMIT_TTL);
            return count <= RATE_LIMIT_MAX;
        } catch (error) {
            console.error('Помилка WebSocket rate limiting:', error);
            return true;
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

    sendError(callback, status, message, error = null) {
        const errorResponse = {
            status,
            success: false,
            message,
            timestamp: new Date().toISOString()
        };
        if (error && process.env.NODE_ENV === 'development') errorResponse.error = error.message;
        if (typeof callback === 'function') callback(errorResponse);
    }

    sendSuccess(callback, data, status = 200) {
        const response = {
            status,
            success: true,
            timestamp: new Date().toISOString(),
            ...data
        };
        if (typeof callback === 'function') callback(response);
    }

    async validateRequest(socket, data, callback, requiresPlayerId = false) {
        if (!data || typeof data !== 'object') {
            this.sendError(callback, 400, 'Невалідні дані запиту');
            return false;
        }
        if (!await authenticateSocketMessage(socket, data)) {
            this.sendError(callback, 403, 'Помилка автентифікації');
            return false;
        }
        if (socket.authType === 'secret_key' && !socket.authKey) {
            this.sendError(callback, 400, 'Відсутній API ключ для server-to-server запиту');
            return false;
        }
        if (requiresPlayerId && !data.playerId) {
            this.sendError(callback, 400, 'Відсутній ID гравця');
            return false;
        }
        if (!this.checkPayloadSize(data)) {
            this.sendError(callback, 413, 'Розмір даних перевищує ліміт');
            return false;
        }
        const keyForRateLimit = socket.authType === 'secret_key' ? data.secretKey : socket.authKey;
        if (!await this.checkRateLimit(socket.id, keyForRateLimit, data.playerId)) {
            this.sendError(callback, 429, 'Перевищено ліміт запитів');
            return false;
        }
        return true;
    }

    async handleUpdateStats(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback, true)) return;
        if (isQueueFull()) return this.sendError(callback, 503, 'Сервер перевантажено, спробуйте пізніше');
        try {
            metrics.totalRequests++;
            this.sendSuccess(callback, { message: 'Запит прийнято на обробку', queueSize: queue.size }, 202);
            const roomKey = socket.authType === 'secret_key' ? data.gameKey || socket.authKey : socket.authKey;
            await queue.add(async () => {
                try {
                    const result = await battleStatsService.processDataAsync(roomKey, data.playerId, data.body || data);
                    if (result) {
                        metrics.successfulRequests++;
                        this.io.to(`stats_${roomKey}`).emit('statsUpdated', { key: roomKey, playerId: data.playerId, timestamp: Date.now() });
                    } else {
                        metrics.failedRequests++;
                        socket.emit('updateError', { key: roomKey, playerId: data.playerId, error: 'Обробка не вдалася', timestamp: Date.now() });
                    }
                } catch (error) {
                    metrics.failedRequests++;
                    socket.emit('updateError', { key: roomKey, playerId: data.playerId, error: error.message, timestamp: Date.now() });
                }
            });
        } catch (error) {
            this.sendError(callback, 500, 'Внутрішня помилка сервера', error);
        }
    }

    async handleGetStats(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback)) return;
        try {
            const page = parseInt(data.page) || 1;
            const limit = data.limit !== undefined ? parseInt(data.limit) : 100;
            const result = await battleStatsService.getStats(socket.authKey, page, limit);
            this.sendSuccess(callback, result);
        } catch (error) {
            this.sendError(callback, 500, 'Помилка при завантаженні даних', error);
        }
    }

    async handleGetOtherPlayersStats(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback, true)) return;
        try {
            const result = await battleStatsService.getOtherPlayersStats(socket.authKey, data.playerId);
            this.sendSuccess(callback, result);
        } catch (error) {
            this.sendError(callback, 500, 'Помилка при завантаженні даних інших гравців', error);
        }
    }

    async handleImportStats(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback)) return;
        try {
            this.sendSuccess(callback, { message: 'Запит на імпорт прийнято' }, 202);
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
            this.sendSuccess(callback, { message: `Дані для ключа ${socket.authKey} успішно очищено` });
            this.io.to(`stats_${socket.authKey}`).emit('statsCleared', { key: socket.authKey, timestamp: Date.now() });
        } catch (error) {
            this.sendError(callback, 500, 'Помилка при очищенні даних', error);
        }
    }

    async handleDeleteBattle(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback)) return;
        if (!data.battleId) {
            this.sendError(callback, 400, 'Відсутній ID бою');
            return;
        }
        try {
            await battleStatsService.deleteBattle(socket.authKey, data.battleId);
            this.sendSuccess(callback, { message: `Бій ${data.battleId} успішно видалено` });
            this.io.to(`stats_${socket.authKey}`).emit('battleDeleted', { key: socket.authKey, battleId: data.battleId, timestamp: Date.now() });
        } catch (error) {
            this.sendError(callback, 500, 'Помилка при видаленні бою', error);
        }
    }

    async handleClearDatabase(socket, data, callback) {
        try {
            const result = await battleStatsService.clearDatabase();
            this.sendSuccess(callback, result);
            this.io.emit('databaseCleared', { timestamp: Date.now() });
        } catch (error) {
            this.sendError(callback, 500, 'Помилка при очищенні бази даних', error);
        }
    }

    handleGetQueueStatus(socket, callback) {
        const successRate = metrics.totalRequests > 0 ? ((metrics.successfulRequests / metrics.totalRequests) * 100).toFixed(2) : '0';
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

    async handleJoinRoom(socket, data, callback) {
        if (!await this.validateRequest(socket, data, callback)) return;
        const roomKey = socket.authKey;
        const roomName = `stats_${roomKey}`;
        socket.join(roomName);
        this.connectedClients.set(socket.id, { key: roomKey, playerId: data.playerId, room: roomName, connectedAt: Date.now() });
        this.sendSuccess(callback, { message: `Приєднано до кімнати ${roomName}`, room: roomName });
    }

    handleLeaveRoom(socket, data, callback) {
        if (!data || !socket.authKey) {
            this.sendError(callback, 400, 'Відсутній ключ кімнати');
            return;
        }
        const roomName = `stats_${socket.authKey}`;
        socket.leave(roomName);
        this.sendSuccess(callback, { message: `Вийшли з кімнати ${roomName}` });
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
        this.sendSuccess(callback, { totalClients: this.io.engine.clientsCount, connectedClients: clients });
    }

    async handleDisconnect(socket, reason) {
        const clientInfo = this.connectedClients.get(socket.id);
        if (clientInfo) {
            await cleanupSession(socket.id);
            this.connectedClients.delete(socket.id);
        }
    }
}

async function authenticateSocket(socket, next) {
    const key = socket.handshake.query.key || socket.handshake.auth?.key;
    const secretKey = socket.handshake.query.secretKey || socket.handshake.auth?.secretKey;
    const playerId = socket.handshake.query.playerId || socket.handshake.auth?.playerId;
    if (key && validateKeySocket(key)) {
        const sessionId = await createSession(socket.id, key, playerId);
        socket.authKey = key;
        socket.sessionId = sessionId;
        socket.authType = 'api_key';
        return next();
    }
    if (secretKey && validateSecretKeySocket(secretKey)) {
        const sessionId = await createSession(socket.id, secretKey, playerId);
        socket.authKey = secretKey;
        socket.sessionId = sessionId;
        socket.authType = 'secret_key';
        return next();
    }
    return next(new Error('Невалідний API ключ або секретний ключ'));
}

function initializeWebSocket(io, redisClientInstance) {
    if (redisClientInstance) {
        setRedisClient(redisClientInstance);
    }
    
    battleStatsService.setIo(io);
    const wsHandler = new WebSocketHandler(io);
    io.use(authenticateSocket);
    io.on('connection', (socket) => {
        socket.emit('connected', { socketId: socket.id, sessionId: socket.sessionId, authType: socket.authType, serverTime: Date.now(), message: 'Успішно підключено до BattleStats WebSocket' });
        socket.on('updateStats', (data, callback) => wsHandler.handleUpdateStats(socket, data, callback));
        socket.on('getStats', (data, callback) => wsHandler.handleGetStats(socket, data, callback));
        socket.on('getOtherPlayersStats', (data, callback) => wsHandler.handleGetOtherPlayersStats(socket, data, callback));
        socket.on('importStats', (data, callback) => wsHandler.handleImportStats(socket, data, callback));
        socket.on('clearStats', (data, callback) => wsHandler.handleClearStats(socket, data, callback));
        socket.on('deleteBattle', (data, callback) => wsHandler.handleDeleteBattle(socket, data, callback));
        socket.on('clearDatabase', (data, callback) => wsHandler.handleClearDatabase(socket, data, callback));
        socket.on('getQueueStatus', (callback) => wsHandler.handleGetQueueStatus(socket, callback));
        socket.on('joinRoom', (data, callback) => wsHandler.handleJoinRoom(socket, data, callback));
        socket.on('leaveRoom', (data, callback) => wsHandler.handleLeaveRoom(socket, data, callback));
        socket.on('getConnectedClients', (callback) => wsHandler.handleGetConnectedClients(socket, callback));
        socket.on('ping', (callback) => {
            const response = { status: 200, success: true, message: 'pong', serverTime: Date.now(), clientId: socket.id, authType: socket.authType };
            if (typeof callback === 'function') callback(response); else socket.emit('pong', response);
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