const VALID_KEYS = require('../config/validKey');

const SECRET_KEY = process.env.SECRET_KEY;
let redisClient;

const setRedisClient = (client) => {
    redisClient = client;
    console.log('Redis client has been set in auth middleware.');
};

const RATE_LIMIT_MAX = 600;
const RATE_LIMIT_TTL = 300; 
const SESSION_TTL = 3600;

class AuthCache {
    constructor() {
        this.wsAuthCache = new Map();
        this.cacheTimeout = 300000;
        this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
    }

    cleanup() {
        const now = Date.now();
        for (const [key, value] of this.wsAuthCache.entries()) {
            if (now - value.timestamp > this.cacheTimeout) {
                this.wsAuthCache.delete(key);
            }
        }
    }

    getCachedAuth(socketId, key, playerId) {
        const cacheKey = `${socketId}:${key}:${playerId || 'anonymous'}`;
        const cached = this.wsAuthCache.get(cacheKey);
        
        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            return cached.result;
        }
        
        return null;
    }

    setCachedAuth(socketId, key, playerId, result) {
        const cacheKey = `${socketId}:${key}:${playerId || 'anonymous'}`;
        this.wsAuthCache.set(cacheKey, {
            result,
            timestamp: Date.now()
        });
    }

    invalidate(socketId) {
        for (const key of this.wsAuthCache.keys()) {
            if (key.startsWith(`${socketId}:`)) {
                this.wsAuthCache.delete(key);
            }
        }
    }

    destroy() {
        clearInterval(this.cleanupInterval);
        this.wsAuthCache.clear();
    }
}

const authCache = new AuthCache();

const extractApiKey = (req) => {
    return req.headers['x-api-key'];
};

const extractSecretKey = (req) => {
    return req.headers['x-secret-key'];
};

const checkRateLimit = async (key, identifier) => {
    try {
        if (!redisClient || !redisClient.isOpen) {
            console.warn('Redis недоступний - пропускаємо rate limiting');
            return true;
        }
        
        const rateLimitKey = `rate-limit:${key}:${identifier}`;
        const attempts = await redisClient.incr(rateLimitKey);
        
        if (attempts === 1) {
            await redisClient.expire(rateLimitKey, RATE_LIMIT_TTL);
        }
        
        return attempts <= RATE_LIMIT_MAX;
    } catch (error) {
        console.error('Помилка rate limiting:', error);
        return true;
    }
};

const validateKey = async (req, res, next) => {
    if (req.method === 'OPTIONS') {
        return next();
    }
    
    const key = extractApiKey(req);
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    
    if (!key) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Відсутній API ключ в заголовках запиту',
        });
    }

    if (!await checkRateLimit(key, clientIp)) {
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

const validateSecretKey = async (req, res, next) => {
    if (req.method === 'OPTIONS') {
        return next();
    }
    
    const secretKey = extractSecretKey(req);
    const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
    
    if (!secretKey) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Відсутній X-Secret-Key в заголовках запиту',
        });
    }

    if (!await checkRateLimit(secretKey, clientIp)) {
        return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Перевищено ліміт спроб автентифікації',
        });
    }
    
    if (secretKey !== SECRET_KEY) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Невірний секретний ключ',
        });
    }
    
    req.secretKey = secretKey;
    next();
};

const validateKeySocket = (key) => {
    return key && VALID_KEYS.includes(key);
};

const validateSecretKeySocket = (secretKey) => {
    return secretKey && secretKey === SECRET_KEY;
};

const createSession = async (socketId, key, playerId) => {
    try {
        if (!redisClient || !redisClient.isOpen) {
            const sessionId = `session:${socketId}`;
            authCache.setCachedAuth(socketId, key, playerId, true);
            return sessionId;
        }
        
        const sessionId = `session:${socketId}`;
        const session = {
            socketId,
            key,
            playerId: playerId || 'anonymous',
            createdAt: Date.now().toString(),
            lastActivity: Date.now().toString()
        };
        
        await redisClient.hSet(sessionId, session);
        await redisClient.expire(sessionId, SESSION_TTL);
        
        authCache.setCachedAuth(socketId, key, playerId, true);
        
        return sessionId;
    } catch (error) {
        console.error('Помилка створення сесії:', error);
        return null;
    }
};

const validateSession = async (socketId, key, playerId) => {
    try {
        const cached = authCache.getCachedAuth(socketId, key, playerId);
        if (cached !== null) {
            return cached;
        }

        if (!redisClient || !redisClient.isOpen) {
            authCache.setCachedAuth(socketId, key, playerId, true);
            return true;
        }
        
        const sessionId = `session:${socketId}`;
        const session = await redisClient.hGetAll(sessionId);
        
        if (!session || Object.keys(session).length === 0) {
            authCache.setCachedAuth(socketId, key, playerId, false);
            return false;
        }
        
        if (session.socketId !== socketId || session.key !== key) {
            authCache.setCachedAuth(socketId, key, playerId, false);
            return false;
        }
        
        await redisClient.hSet(sessionId, 'lastActivity', Date.now().toString());
        await redisClient.expire(sessionId, SESSION_TTL);
        
        authCache.setCachedAuth(socketId, key, playerId, true);
        return true;
    } catch (error) {
        console.error('Помилка валідації сесії:', error);
        return true;
    }
};

const cleanupSession = async (socketId) => {
    try {
        authCache.invalidate(socketId);
        
        if (!redisClient || !redisClient.isOpen) return;
        
        const sessionId = `session:${socketId}`;
        await redisClient.del(sessionId);
    } catch (error) {
        console.error('Помилка очищення сесії:', error);
    }
};

const authenticateSocketMessage = async (socket, data) => {
    if (!data || typeof data !== 'object') {
        return false;
    }
    
    if (socket.authType === 'secret_key') {
        if (!data.secretKey || data.secretKey !== SECRET_KEY) {
            return false;
        }
        if (!data.key || !VALID_KEYS.includes(data.key)) {
            return false;
        }
        return await validateSession(socket.id, socket.authKey, data.playerId);
    }
    
    if (!data.key || !validateKeySocket(data.key)) {
        return false;
    }
    
    return await validateSession(socket.id, data.key, data.playerId);
};

process.on('SIGINT', () => {
    authCache.destroy();
});

process.on('SIGTERM', () => {
    authCache.destroy();
});

module.exports = {
    setRedisClient, 
    validateKey,
    validateKeySocket,
    validateSecretKey,
    validateSecretKeySocket,
    createSession,
    validateSession,
    cleanupSession,
    authenticateSocketMessage,
    extractApiKey,
    extractSecretKey,
    redisClient,
    authCache
};