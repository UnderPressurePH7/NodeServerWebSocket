const VALID_KEYS = require('../config/validKey');
const LRU = require('lru-cache');

const rateLimitCache = new LRU({
    max: 10000,
    ttl: 60000
});

const sessionCache = new LRU({
    max: 5000,
    ttl: 3600000
});

const RATE_LIMIT_MAX = 5;
const SESSION_TTL = 3600000;

const extractApiKey = (req) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    
    return req.headers['x-api-key'] || req.headers['x-auth-key'];
};

const checkRateLimit = (key, identifier) => {
    const rateLimitKey = `${key}:${identifier}`;
    const attempts = rateLimitCache.get(rateLimitKey) || 0;
    
    if (attempts >= RATE_LIMIT_MAX) {
        return false;
    }
    
    rateLimitCache.set(rateLimitKey, attempts + 1);
    return true;
};

const validateKey = (req, res, next) => {
    const key = extractApiKey(req);
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    
    if (!key) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Відсутній API ключ в заголовках запиту',
        });
    }

    if (!checkRateLimit(key, clientIp)) {
        return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Перевищено ліміт спроб автентифікації',
        });
    }
    
    if (!VALID_KEYS.includes(key)) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Невірний ключ доступу',
        });
    }
    
    req.apiKey = key;
    next();
};

const validateKeySocket = (key) => {
    return key && VALID_KEYS.includes(key);
};

const createSession = (socketId, key, playerId) => {
    const sessionId = `${socketId}:${key}:${playerId || 'anonymous'}`;
    const session = {
        socketId,
        key,
        playerId,
        createdAt: Date.now(),
        lastActivity: Date.now()
    };
    
    sessionCache.set(sessionId, session);
    return sessionId;
};

const validateSession = (socketId, key, playerId) => {
    const sessionId = `${socketId}:${key}:${playerId || 'anonymous'}`;
    const session = sessionCache.get(sessionId);
    
    if (!session) {
        return false;
    }
    
    if (session.socketId !== socketId || session.key !== key) {
        return false;
    }
    
    session.lastActivity = Date.now();
    sessionCache.set(sessionId, session);
    return true;
};

const cleanupSession = (socketId, key, playerId) => {
    const sessionId = `${socketId}:${key}:${playerId || 'anonymous'}`;
    sessionCache.delete(sessionId);
};

const authenticateSocketMessage = (socket, data) => {
    if (!data || !data.key) {
        return false;
    }
    
    if (!validateKeySocket(data.key)) {
        return false;
    }
    
    if (!validateSession(socket.id, data.key, data.playerId)) {
        return false;
    }
    
    return true;
};

module.exports = {
    validateKey,
    validateKeySocket,
    createSession,
    validateSession,
    cleanupSession,
    authenticateSocketMessage,
    extractApiKey
};