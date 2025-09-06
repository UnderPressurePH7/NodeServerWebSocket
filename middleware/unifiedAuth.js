const AuthValidationUtils = require('../utils/authValidationUtils');
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

    createHttpMiddleware(requireSecret = false) {
        return async (req, res, next) => {
            if (req.method === 'OPTIONS') return next();
            
            const authData = AuthValidationUtils.extractAuthData(req);
            const clientIp = req.ip || req.connection.remoteAddress || 'unknown';

            const validation = AuthValidationUtils.validateAuthForContext(
                authData, 
                requireSecret, 
                false // playerId validation handled by separate middleware
            );

            if (!validation.isValid) {
                const authResponse = AuthValidationUtils.createAuthResponse(false, validation.errors);
                return ResponseUtils.sendError(res, {
                    statusCode: authResponse.statusCode,
                    message: authResponse.message
                });
            }

            if (!await this.checkRateLimit(validation.keyForRateLimit, clientIp)) {
                return ResponseUtils.sendError(res, {
                    statusCode: 429,
                    message: 'Перевищено ліміт запитів'
                });
            }

            req.apiKey = authData.apiKey;
            if (authData.secretKey) {
                req.secretKey = authData.secretKey;
            }
            next();
        };
    }

    async authenticateSocket(socket, next) {
        const authData = AuthValidationUtils.extractAuthData(socket);
        
        console.log('🔐 WebSocket auth attempt:', { 
            hasKey: !!authData.apiKey, 
            hasSecretKey: !!authData.secretKey, 
            hasPlayerId: !!authData.playerId 
        });
        
        const authType = AuthValidationUtils.determineAuthType(authData);
        
        if (authType.isValid) {
            console.log(`✅ Valid ${authType.type} for WebSocket`);
            const sessionId = await this.createSession(socket.id, authType.key, authData.playerId);
            socket.authKey = authType.key;
            socket.sessionId = sessionId;
            socket.authType = authType.type;
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
        
        // Extract auth data from message
        const messageAuthData = AuthValidationUtils.extractAuthData(data);
        
        // If socket has existing auth, combine with message data
        let finalAuthData = messageAuthData;
        if (socket.authKey) {
            finalAuthData = {
                ...messageAuthData,
                [socket.authType === 'secret_key' ? 'secretKey' : 'apiKey']: socket.authKey
            };
        }

        const validation = AuthValidationUtils.validateAuthForContext(
            finalAuthData,
            socket.authType === 'secret_key' || !!finalAuthData.secretKey,
            requiresPlayerId
        );

        if (!validation.isValid) {
            console.log('❌ Auth validation failed:', validation.errors);
            return false;
        }

        const rateLimitOk = await this.checkRateLimit(validation.keyForRateLimit, socket.id);
        console.log(`Rate limit check: ${rateLimitOk}`);
        return rateLimitOk;
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
    validateKey: (key) => AuthValidationUtils.validateKey(key),
    validateSecretKey: (secretKey) => AuthValidationUtils.validateSecretKey(secretKey),
    createSession: (socketId, key, playerId) => unifiedAuth.createSession(socketId, key, playerId),
    validateSession: (socketId, key, playerId) => unifiedAuth.validateSession(socketId, key, playerId),
    cleanupSession: (socketId) => unifiedAuth.cleanupSession(socketId),
    authenticateSocketMessage: (socket, data) => unifiedAuth.validateSocketMessage(socket, data),
    extractApiKey: (req) => req.headers['x-api-key'],
    extractSecretKey: (req) => req.headers['x-secret-key']
};