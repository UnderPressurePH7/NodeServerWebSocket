const VALID_KEYS = require('../config/validKey');

class AuthValidationUtils {
    static validateKey(key) {
        return key && VALID_KEYS.includes(key);
    }

    static validateSecretKey(secretKey) {
        return secretKey && secretKey === process.env.SECRET_KEY;
    }

    static extractAuthData(source) {
        // For HTTP requests
        if (source.headers) {
            return {
                apiKey: source.headers['x-api-key'],
                secretKey: source.headers['x-secret-key'],
                playerId: source.headers['x-player-id']
            };
        }
        
        // For WebSocket handshake
        if (source.handshake) {
            return {
                apiKey: source.handshake.query.key || source.handshake.auth?.key,
                secretKey: source.handshake.query.secretKey || source.handshake.auth?.secretKey,
                playerId: source.handshake.query.playerId || source.handshake.auth?.playerId
            };
        }
        
        // For WebSocket message data
        if (source.key || source.secretKey) {
            return {
                apiKey: source.key,
                secretKey: source.secretKey,
                playerId: source.playerId
            };
        }
        
        return { apiKey: null, secretKey: null, playerId: null };
    }

    static determineAuthType(authData) {
        const { apiKey, secretKey } = authData;
        
        if (secretKey && this.validateSecretKey(secretKey)) {
            return { type: 'secret_key', key: secretKey, isValid: true };
        }
        
        if (apiKey && this.validateKey(apiKey)) {
            return { type: 'api_key', key: apiKey, isValid: true };
        }
        
        return { type: 'none', key: null, isValid: false };
    }

    static validateAuthForContext(authData, requiresSecret = false, requiresPlayerId = false) {
        const { apiKey, secretKey, playerId } = authData;
        const errors = [];

        // Check secret key requirement
        if (requiresSecret) {
            if (!secretKey || !this.validateSecretKey(secretKey)) {
                errors.push('Невірний або відсутній секретний ключ');
            }
            if (!apiKey || !this.validateKey(apiKey)) {
                errors.push('Невірний або відсутній API ключ для server-to-server запиту');
            }
        } else {
            // Regular API key validation
            if (!apiKey || !this.validateKey(apiKey)) {
                errors.push('Невірний або відсутній API ключ');
            }
        }

        // Check player ID requirement
        if (requiresPlayerId && !playerId) {
            errors.push('Відсутній ID гравця');
        }

        return {
            isValid: errors.length === 0,
            errors,
            authType: this.determineAuthType(authData).type,
            keyForRateLimit: requiresSecret ? secretKey : apiKey
        };
    }

    static createAuthResponse(isValid, errors = [], statusCode = null) {
        if (isValid) {
            return { success: true };
        }
        
        return {
            success: false,
            statusCode: statusCode || (errors.some(e => e.includes('секретний')) ? 401 : 400),
            message: errors.join('; ')
        };
    }
}

module.exports = AuthValidationUtils;