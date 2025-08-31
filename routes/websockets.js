const { validateKey, validateKeySocket } = require('../middleware/auth');
const battleStatsController = require('../controllers/battleStatsController');
const queue = require('../config/queue');
const metrics = require('../config/metrics');

// Глобальна змінна для зберігання io інстансу
let globalIo;

// Rate limiting для WebSocket
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 5000; // 5 секунд замість 100ms
const RATE_LIMIT_MAX = 10; // 10 запитів замість 5

function checkRateLimit(socketId) {
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

// Адаптери для виклику методів контролера з WebSocket
const adaptController = (handler) => async (socket, data, callback) => {
    try {
        // Емуляція об'єктів req та res для сумісності з існуючим контролером
        const req = {
            params: { key: data.key, battleId: data.battleId },
            headers: { 'x-player-id': data.playerId || socket.id },
            body: data.body || data,
            socket: socket, // Передаємо socket в req для доступу в контролері
        };

        let responseSent = false;
        const res = {
            status: (statusCode) => ({
                json: (payload) => {
                    if (!responseSent) {
                        responseSent = true;
                        if (typeof callback === 'function') {
                            callback({
                                status: statusCode,
                                body: payload,
                            });
                        }
                    }
                },
            }),
        };
        
        await handler(req, res);

    } catch (error) {
        console.error(`Помилка обробника WebSocket:`, error);
        if (typeof callback === 'function') {
            callback({
                status: 500,
                body: { error: 'Internal Server Error', message: error.message },
            });
        }
    }
};

function initializeWebSocket(io) {
    // Зберігаємо io інстанс глобально
    globalIo = io;
    
    // Передаємо io інстанс в контролер
    battleStatsController.setIo(io);
    
    io.on('connection', (socket) => {
        console.log(`🔌 Клієнт підключився: ${socket.id}`);
        console.log(`🌐 Всього підключених клієнтів: ${io.engine.clientsCount}`);
        console.log(`📡 Transport: ${socket.conn.transport.name}`);

        // Переносимо всі маршрути на WebSocket події
        socket.on('updateStats', (data, callback) => {
            console.log(`� ОТРИМАНО updateStats від ${socket.id}:`, data?.key);
            console.log(`📋 Дані для оновлення:`, JSON.stringify(data, null, 2));
            console.log(`⏰ Час отримання: ${new Date().toISOString()}`);
            
            // Перевірка rate limiting
            if (!checkRateLimit(socket.id)) {
                console.log(`⚠️ Rate limit exceeded for ${socket.id}`);
                return callback?.({ 
                    status: 429, 
                    body: { error: 'Too Many Requests', message: 'Перевищено ліміт запитів' } 
                });
            }
            
            if (!data?.key || !validateKeySocket(data.key)) {
                console.log(`❌ Невалідний ключ: ${data?.key}`);
                return callback?.({ status: 403, body: { error: 'Forbidden', message: 'Невалідний API ключ' } });
            }
            
            console.log(`✅ Передаю updateStats в контролер для ключа: ${data.key}`);
            adaptController(battleStatsController.updateStats)(socket, data, callback);
        });

        socket.on('getStats', (data, callback) => {
            console.log(`📊 getStats від ${socket.id}:`, data?.key);
            if (!data?.key || !validateKeySocket(data.key)) {
                return callback?.({ status: 403, body: { error: 'Forbidden', message: 'Невалідний API ключ' } });
            }
            
            console.log(`🔍 Виконую getStats для ключа: ${data.key}`);
            adaptController(battleStatsController.getStats)(socket, data, callback);
        });

        socket.on('getOtherPlayersStats', (data, callback) => {
            console.log(`👥 getOtherPlayersStats від ${socket.id}:`, data?.key);
            if (!data?.key || !validateKeySocket(data.key)) {
                return callback?.({ status: 403, body: { error: 'Forbidden', message: 'Невалідний API ключ' } });
            }
            adaptController(battleStatsController.getOtherPlayersStats)(socket, data, callback);
        });

        socket.on('importStats', (data, callback) => {
            console.log(`📥 importStats від ${socket.id}:`, data?.key);
            if (!data?.key || !validateKeySocket(data.key)) {
                return callback?.({ status: 403, body: { error: 'Forbidden', message: 'Невалідний API ключ' } });
            }
            adaptController(battleStatsController.importStats)(socket, data, callback);
        });

        socket.on('clearStats', (data, callback) => {
            console.log(`🧹 clearStats від ${socket.id}:`, data?.key);
            if (!data?.key || !validateKeySocket(data.key)) {
                return callback?.({ status: 403, body: { error: 'Forbidden', message: 'Невалідний API ключ' } });
            }
            adaptController(battleStatsController.clearStats)(socket, data, callback);
        });

        socket.on('deleteBattle', (data, callback) => {
            console.log(`🗑️ deleteBattle від ${socket.id}:`, data?.key);
            if (!data?.key || !validateKeySocket(data.key)) {
                return callback?.({ status: 403, body: { error: 'Forbidden', message: 'Невалідний API ключ' } });
            }
            adaptController(battleStatsController.deleteBattle)(socket, data, callback);
        });

        socket.on('clearDatabase', (data, callback) => {
            console.log(`💥 clearDatabase від ${socket.id}`);
            adaptController(battleStatsController.clearDatabase)(socket, data, callback);
        });

        socket.on('disconnect', (reason) => {
            console.log(`❌ Клієнт відключився: ${socket.id}, причина: ${reason}`);
            // Очищуємо rate limit дані для відключеного клієнта
            rateLimitMap.delete(socket.id);
        });

        socket.on('error', (error) => {
            console.error(`🚨 Помилка сокета ${socket.id}:`, error);
        });
    });

    console.log('🚀 WebSocket сервер ініціалізовано');
}

// Експортуємо функцію для отримання io інстансу
function getIo() {
    return globalIo;
}

module.exports = { initializeWebSocket, getIo };
