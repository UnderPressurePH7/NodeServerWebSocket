const VALID_KEYS = require('../config/validKey');
const ResponseUtils = require('../utils/responseUtils');

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

class UnifiedAuth {
    constructor() {
        this.redisClient = null;
        this.authCache = new AuthCache();
    }

    setRedisClient(client) {
        this.redisClient = client;
    }

    async checkRateLimit(key, identifier) {
        try {
            if (!this.redisClient?.isOpen) {
                console.warn('Redis недоступний - пропускаємо rate limiting');
                return true;
            }
            
            const rateLimitKey = `rate-limit:${key}:${identifier}`;
            const attempts = await this.redisClient.incr(rateLimitKey);
            
            if (attempts === 1) {
                await this.redisClient.expire(rateLimitKey, RATE_LIMIT_TTL);
            }
            
            return attempts <= RATE_LIMIT_MAX;
        } catch (error) {
            console.error('Помилка rate limiting:', error);
            return true;
        }
    }

    validateKey(key) {
        return key && VALID_KEYS.includes(key);
    }

    validateSecretKey(secretKey) {
        return secretKey && secretKey === process.env.SECRET_KEY;
    }

    createHttpMiddleware(requireSecret = false) {
        return async (req, res, next) => {
            if (req.method === 'OPTIONS') return next();
            
            const apiKey = req.headers['x-api-key'];
            const secretKey = req.headers['x-secret-key'];
            const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

            if (requireSecret) {
                if (!secretKey || !this.validateSecretKey(secretKey)) {
                    return ResponseUtils.sendError(res, {
                        statusCode: 401,
                        message: 'Невірний або відсутній секретний ключ'
                    });
                }
                req.secretKey = secretKey;
            }

            if (!apiKey || !this.validateKey(apiKey)) {
                return ResponseUtils.sendError(res, {
                    statusCode: 401,
                    message: 'Невірний або відсутній API ключ'
                });
            }

            const rateLimitKey = requireSecret ? secretKey : apiKey;
            if (!await this.checkRateLimit(rateLimitKey, clientIp)) {
                return ResponseUtils.sendError(res, {
                    statusCode: 429,
                    message: 'Перевищено ліміт запитів'
                });
            }

            req.apiKey = apiKey;
            next();
        };
    }

    async authenticateSocket(socket, next) {
        const key = socket.handshake.query.key || socket.handshake.auth?.key;
        const secretKey = socket.handshake.query.secretKey || socket.handshake.auth?.secretKey;
        const playerId = socket.handshake.query.playerId || socket.handshake.auth?.playerId;
        
        console.log('🔐 WebSocket auth attempt:', { 
            hasKey: !!key, 
            hasSecretKey: !!secretKey, 
            hasPlayerId: !!playerId 
        });
        
        if (secretKey && this.validateSecretKey(secretKey)) {
            console.log('✅ Valid secret key for WebSocket');
            const sessionId = await this.createSession(socket.id, secretKey, playerId);
            socket.authKey = secretKey;
            socket.sessionId = sessionId;
            socket.authType = 'secret_key';
            return next();
        }
        
        if (key && this.validateKey(key)) {
            console.log('✅ Valid API key for WebSocket');
            const sessionId = await this.createSession(socket.id, key, playerId);
            socket.authKey = key;
            socket.sessionId = sessionId;
            socket.authType = 'api_key';
            return next();
        }
        
        console.log('⚠️ WebSocket connection without initial auth - will validate per message');
        socket.authType = 'none';
        socket.authKey = null;
        return next();
    }

    async validateSocketMessage(socket, data, requiresPlayerId = false) {
        if (!data || typeof data !== 'object') {
            console.log('❌ Invalid data format');
            return false;
        }
        
        if (data.secretKey && this.validateSecretKey(data.secretKey)) {
            console.log('✅ Valid secret key provided');
            if (!data.key || !this.validateKey(data.key)) {
                console.log('❌ Invalid API key with secret key');
                return false;
            }
            if (requiresPlayerId && !data.playerId) {
                console.log('❌ Missing playerId for secret key request');
                return false;
            }
            
            const keyForRateLimit = data.secretKey;
            const rateLimitOk = await this.checkRateLimit(keyForRateLimit, socket.id);
            console.log(`Rate limit check (secret): ${rateLimitOk}`);
            return rateLimitOk;
        }
        
        if (data.key && this.validateKey(data.key)) {
            console.log('✅ Valid API key provided');
            if (requiresPlayerId && !data.playerId) {
                console.log('❌ Missing playerId for API key request');
                return false;
            }
            
            const keyForRateLimit = data.key;
            const rateLimitOk = await this.checkRateLimit(keyForRateLimit, socket.id);
            console.log(`Rate limit check (api key): ${rateLimitOk}`);
            return rateLimitOk;
        }
        
        if (socket.authType === 'secret_key' && socket.authKey) {
            console.log('✅ Using socket secret key auth');
            if (!data.key || !this.validateKey(data.key)) {
                console.log('❌ Invalid API key for authenticated socket');
                return false;
            }
            if (requiresPlayerId && !data.playerId) {
                console.log('❌ Missing playerId for authenticated socket');
                return false;
            }
            
            const keyForRateLimit = socket.authKey;
            const rateLimitOk = await this.checkRateLimit(keyForRateLimit, socket.id);
            console.log(`Rate limit check (socket auth): ${rateLimitOk}`);
            return rateLimitOk;
        }
        
        if (socket.authType === 'api_key' && socket.authKey) {
            console.log('✅ Using socket API key auth');
            if (data.key && data.key !== socket.authKey) {
                console.log('❌ Key mismatch with socket auth');
                return false;
            }
            if (requiresPlayerId && !data.playerId) {
                console.log('❌ Missing playerId for API key socket');
                return false;
            }
            
            const keyForRateLimit = socket.authKey;
            const rateLimitOk = await this.checkRateLimit(keyForRateLimit, socket.id);
            console.log(`Rate limit check (socket api): ${rateLimitOk}`);
            return rateLimitOk;
        }
        
        console.log('❌ No valid authentication method found');
        console.log('Data keys:', Object.keys(data));
        console.log('Socket authType:', socket.authType);
        console.log('Socket authKey:', !!socket.authKey);
        
        return false;
    }

    async createSession(socketId, key, playerId) {
        try {
            if (!this.redisClient?.isOpen) {
                const sessionId = `session:${socketId}`;
                this.authCache.setCachedAuth(socketId, key, playerId, true);
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
            
            await this.redisClient.hSet(sessionId, session);
            await this.redisClient.expire(sessionId, SESSION_TTL);
            
            this.authCache.setCachedAuth(socketId, key, playerId, true);
            
            return sessionId;
        } catch (error) {
            console.error('Помилка створення сесії:', error);
            return null;
        }
    }

    async validateSession(socketId, key, playerId) {
        try {
            const cached = this.authCache.getCachedAuth(socketId, key, playerId);
            if (cached !== null) {
                return cached;
            }

            if (!this.redisClient?.isOpen) {
                this.authCache.setCachedAuth(socketId, key, playerId, true);
                return true;
            }
            
            const sessionId = `session:${socketId}`;
            const session = await this.redisClient.hGetAll(sessionId);
            
            if (!session || Object.keys(session).length === 0) {
                this.authCache.setCachedAuth(socketId, key, playerId, false);
                return false;
            }
            
            if (session.socketId !== socketId || session.key !== key) {
                this.authCache.setCachedAuth(socketId, key, playerId, false);
                return false;
            }
            
            await this.redisClient.hSet(sessionId, 'lastActivity', Date.now().toString());
            await this.redisClient.expire(sessionId, SESSION_TTL);
            
            this.authCache.setCachedAuth(socketId, key, playerId, true);
            return true;
        } catch (error) {
            console.error('Помилка валідації сесії:', error);
            return true;
        }
    }

    async cleanupSession(socketId) {
        try {
            this.authCache.invalidate(socketId);
            
            if (!this.redisClient?.isOpen) return;
            
            const sessionId = `session:${socketId}`;
            await this.redisClient.del(sessionId);
        } catch (error) {
            console.error('Помилка очищення сесії:', error);
        }
    }

    destroy() {
        this.authCache.destroy();
    }
}

const unifiedAuth = new UnifiedAuth();

module.exports = {
    unifiedAuth,
    setRedisClient: (client) => unifiedAuth.setRedisClient(client),
    validateKey: (key) => unifiedAuth.validateKey(key),
    validateSecretKey: (secretKey) => unifiedAuth.validateSecretKey(secretKey),
    createSession: (socketId, key, playerId) => unifiedAuth.createSession(socketId, key, playerId),
    validateSession: (socketId, key, playerId) => unifiedAuth.validateSession(socketId, key, playerId),
    cleanupSession: (socketId) => unifiedAuth.cleanupSession(socketId),
    authenticateSocketMessage: (socket, data) => unifiedAuth.validateSocketMessage(socket, data),
    extractApiKey: (req) => req.headers['x-api-key'],
    extractSecretKey: (req) => req.headers['x-secret-key']
};