const { validateKeySocket, validateSecretKeySocket, createSession, validateSession, cleanupSession, authenticateSocketMessage } = require('../middleware/auth');
const battleStatsService = require('../services/battleStatsService');
const queue = require('../config/queue');
const metrics = require('../config/metrics');
const { LRUCache } = require('lru-cache');

const rateLimitCache = new LRUCache({
   max: 10000,
   ttl: 30000
});

const RATE_LIMIT_MAX = 100;
const MAX_PAYLOAD_SIZE = 2 * 1024 * 1024;

class WebSocketHandler {
   constructor(io) {
       this.io = io;
       this.connectedClients = new Map();
   }

   getRateLimitKey(socketId, key, playerId) {
       return `${socketId}:${key}:${playerId || 'anonymous'}`;
   }

   checkRateLimit(socketId, key, playerId) {
       const rateLimitKey = this.getRateLimitKey(socketId, key, playerId);
       const count = rateLimitCache.get(rateLimitKey) || 0;
       
       if (count >= RATE_LIMIT_MAX) {
           return false;
       }
       
       rateLimitCache.set(rateLimitKey, count + 1);
       return true;
   }

   checkPayloadSize(data) {
       const payloadSize = JSON.stringify(data).length;
       return payloadSize <= MAX_PAYLOAD_SIZE;
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
       if (!data || typeof data !== 'object') {
           this.sendError(callback, 400, 'Невалідні дані запиту');
           return false;
       }

       if (!authenticateSocketMessage(socket, data)) {
           this.sendError(callback, 403, 'Помилка автентифікації');
           return false;
       }

       if (socket.authType === 'secret_key' && !data.key) {
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

       const keyForRateLimit = socket.authType === 'secret_key' ? data.secretKey : data.key;
       if (!this.checkRateLimit(socket.id, keyForRateLimit, data.playerId)) {
           this.sendError(callback, 429, 'Перевищено ліміт запитів');
           return false;
       }

       return true;
   }

   async handleUpdateStats(socket, data, callback) {
       if (!this.validateRequest(socket, data, callback, true)) {
           return;
       }

       try {
           metrics.totalRequests++;

           this.sendSuccess(callback, {
               message: 'Запит прийнято на обробку',
               queueSize: queue.size
           }, 202);

           const roomKey = socket.authType === 'secret_key' ? data.gameKey || data.key : data.key;

           await queue.add(async () => {
               try {
                   const result = await battleStatsService.processDataAsync(
                       roomKey, 
                       data.playerId, 
                       data.body || data
                   );

                   if (result) {
                       metrics.successfulRequests++;
                       this.io.to(`stats_${roomKey}`).emit('statsUpdated', {
                           key: roomKey,
                           playerId: data.playerId,
                           timestamp: Date.now()
                       });
                   } else {
                       metrics.failedRequests++;
                   }
               } catch (error) {
                   metrics.failedRequests++;
                   console.error('Помилка асинхронної обробки:', error);
                   
                   socket.emit('updateError', {
                       key: data.key,
                       playerId: data.playerId,
                       error: error.message,
                       timestamp: Date.now()
                   });
               }
           });

       } catch (error) {
           console.error('Помилка handleUpdateStats:', error);
           this.sendError(callback, 500, 'Внутрішня помилка сервера', error);
       }
   }

   async handleGetStats(socket, data, callback) {
       if (!this.validateRequest(socket, data, callback)) {
           return;
       }

       try {
           const result = await battleStatsService.getStats(data.key);
           this.sendSuccess(callback, result);
       } catch (error) {
           console.error('Помилка handleGetStats:', error);
           this.sendError(callback, 500, 'Помилка при завантаженні даних', error);
       }
   }

   async handleGetOtherPlayersStats(socket, data, callback) {
       if (!this.validateRequest(socket, data, callback, true)) {
           return;
       }

       try {
           const result = await battleStatsService.getOtherPlayersStats(data.key, data.playerId);
           this.sendSuccess(callback, result);
       } catch (error) {
           console.error('Помилка handleGetOtherPlayersStats:', error);
           this.sendError(callback, 500, 'Помилка при завантаженні даних інших гравців', error);
       }
   }

   async handleImportStats(socket, data, callback) {
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
           console.error('Помилка handleImportStats:', error);
           socket.emit('importError', {
               key: data.key,
               error: error.message,
               timestamp: Date.now()
           });
       }
   }

   async handleClearStats(socket, data, callback) {
       if (!this.validateRequest(socket, data, callback)) {
           return;
       }

       try {
           await battleStatsService.clearStats(data.key);
           this.sendSuccess(callback, { 
               message: `Дані для ключа ${data.key} успішно очищено` 
           });

           this.io.to(`stats_${data.key}`).emit('statsCleared', {
               key: data.key,
               timestamp: Date.now()
           });

       } catch (error) {
           console.error('Помилка handleClearStats:', error);
           this.sendError(callback, 500, 'Помилка при очищенні даних', error);
       }
   }

   async handleDeleteBattle(socket, data, callback) {
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

           this.io.to(`stats_${data.key}`).emit('battleDeleted', {
               key: data.key,
               battleId: data.battleId,
               timestamp: Date.now()
           });

       } catch (error) {
           console.error('Помилка handleDeleteBattle:', error);
           this.sendError(callback, 500, 'Помилка при видаленні бою', error);
       }
   }

   async handleClearDatabase(socket, data, callback) {
       try {
           const result = await battleStatsService.clearDatabase();
           this.sendSuccess(callback, result);

           this.io.emit('databaseCleared', {
               timestamp: Date.now()
           });

       } catch (error) {
           console.error('Помилка handleClearDatabase:', error);
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

       const roomKey = data.key;
       const roomName = `stats_${roomKey}`;
       socket.join(roomName);
       
       this.connectedClients.set(socket.id, {
           key: roomKey,
           playerId: data.playerId,
           room: roomName,
           connectedAt: Date.now()
       });

       this.sendSuccess(callback, { 
           message: `Приєднано до кімнати ${roomName}`,
           room: roomName
       });
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
           totalClients: this.io.engine.clientsCount,
           connectedClients: clients
       });
   }

   handleDisconnect(socket, reason) {
       const clientInfo = this.connectedClients.get(socket.id);
       if (clientInfo) {
           cleanupSession(socket.id, clientInfo.key, clientInfo.playerId);
           this.connectedClients.delete(socket.id);
       }
       console.log(`Клієнт відключився: ${socket.id}, причина: ${reason}`);
   }
}

function authenticateSocket(socket, next) {
   const key = socket.handshake.query.key || socket.handshake.auth?.key;
   const secretKey = socket.handshake.query.secretKey || socket.handshake.auth?.secretKey;
   const playerId = socket.handshake.query.playerId || socket.handshake.auth?.playerId;
   
   if (key && validateKeySocket(key)) {
       const sessionId = createSession(socket.id, key, playerId);
       socket.authKey = key;
       socket.sessionId = sessionId;
       socket.authType = 'api_key';
       return next();
   }
   
   if (secretKey && validateSecretKeySocket(secretKey)) {
       const sessionId = createSession(socket.id, secretKey, playerId);
       socket.authKey = secretKey;
       socket.sessionId = sessionId;
       socket.authType = 'secret_key';
       return next();
   }
   
   return next(new Error('Невалідний API ключ або секретний ключ'));
}

function initializeWebSocket(io) {
   battleStatsService.setIo(io);
   
   io.use(authenticateSocket);
   
   io.on('connection', (socket) => {
       const wsHandler = new WebSocketHandler(io);
       
       socket.emit('connected', {
           socketId: socket.id,
           sessionId: socket.sessionId,
           authType: socket.authType,
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
               clientId: socket.id,
               authType: socket.authType
           };
           
           if (typeof callback === 'function') {
               callback(response);
           } else {
               socket.emit('pong', response);
           }
       });

       socket.on('disconnect', (reason) => {
           wsHandler.handleDisconnect(socket, reason);
       });

       socket.on('error', (error) => {
           console.error(`Помилка сокета ${socket.id}:`, error);
       });
   });

   io.engine.on('connection_error', (err) => {
       console.error('Помилка підключення Socket.IO:', err);
   });

   console.log('WebSocket сервер ініціалізовано');
}

function getIo() {
   return this.io;
}

function broadcastToRoom(io, room, event, data) {
   if (io) {
       io.to(room).emit(event, data);
   }
}

function broadcastGlobally(io, event, data) {
   if (io) {
       io.emit(event, data);
   }
}

module.exports = { 
   initializeWebSocket, 
   getIo, 
   broadcastToRoom, 
   broadcastGlobally 
};
