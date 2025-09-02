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

const extractApiKey = (req) => {
    return req.headers['x-api-key'];
};

const extractSecretKey = (req) => {
    return req.headers['x-secret-key'];
};

const checkRateLimit = async (key, identifier) => {
    if (!redisClient || !redisClient.isOpen) return true;
    const rateLimitKey = `rate-limit:${key}:${identifier}`;
    const attempts = await redisClient.incr(rateLimitKey);
    
    if (attempts === 1) {
        await redisClient.expire(rateLimitKey, RATE_LIMIT_TTL);
    }
    
    return attempts <= RATE_LIMIT_MAX;
};

const validateKey = async (req, res, next) => {
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
    if (!redisClient || !redisClient.isOpen) return null;
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
    return sessionId;
};

const validateSession = async (socketId, key, playerId) => {
    if (!redisClient || !redisClient.isOpen) return true;
    const sessionId = `session:${socketId}`;
    const session = await redisClient.hGetAll(sessionId);
    
    if (!session || Object.keys(session).length === 0) {
        return false;
    }
    
    if (session.socketId !== socketId || session.key !== key) {
        return false;
    }
    
    await redisClient.hSet(sessionId, 'lastActivity', Date.now().toString());
    await redisClient.expire(sessionId, SESSION_TTL);
    return true;
};

const cleanupSession = async (socketId) => {
    if (!redisClient || !redisClient.isOpen) return;
    const sessionId = `session:${socketId}`;
    await redisClient.del(sessionId);
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
    extractSecretKey
};