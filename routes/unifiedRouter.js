const express = require('express');
const ResponseUtils = require('../utils/responseUtils');
const { clientCors, serverCors } = require('../middleware/cors');
const { unifiedAuth } = require('../middleware/unifiedAuth');
const { version } = require('../package.json');

class UnifiedRouter {
    constructor() {
        this.router = express.Router();
    }

    setupRoute(config) {
        const {
            method,
            path,
            controller,
            requireSecret = false,
            requirePlayerId = false,
            cors = 'client',
            additionalMiddleware = []
        } = config;

        const corsMiddleware = cors === 'server' ? serverCors : clientCors;
        const authMiddleware = unifiedAuth.createHttpMiddleware(requireSecret);
        
        const middlewares = [
            corsMiddleware,
            this.addHeaders(cors),
            this.logRequest,
            authMiddleware,
            ...additionalMiddleware
        ];

        if (requirePlayerId) {
            middlewares.push(this.validatePlayerId);
        }

        this.router[method](path, middlewares, this.asyncHandler(controller));
    }

    addHeaders(type) {
        return (req, res, next) => {
            const prefix = type === 'server' ? 'srv' : 'cli';
            res.set({
                'X-API-Version': version,
                'X-Powered-By': `BattleStats-${type === 'server' ? 'Server' : 'Client'}-API`,
                'X-Request-ID': req.id || `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                'Cache-Control': 'no-cache, no-store, must-revalidate'
            });
            next();
        };
    }

    logRequest(req, res, next) {
        if (req.method === 'OPTIONS') return next();
        
        const bodySize = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
        const prefix = req.route?.path?.includes('/server/') ? 'SERVER-TO-SERVER' : 'CLIENT API';
        
        console.log(`${prefix} ${req.method} ${req.originalUrl}`);
        console.log(`Data size: ${bodySize} bytes`);
        console.log(`Time: ${new Date().toISOString()}`);
        console.log(`User-Agent: ${req.get('User-Agent')}`);
        console.log(`IP: ${req.ip}`);
        next();
    }

    validatePlayerId(req, res, next) {
        const playerId = req.headers['x-player-id'];
        if (!playerId) {
            return ResponseUtils.sendError(res, {
                statusCode: 400,
                message: 'Відсутній ID гравця в заголовку запиту (X-Player-ID)'
            });
        }
        req.playerId = playerId;
        next();
    }

    validatePagination(req, res, next) {
        req.pagination = {
            page: parseInt(req.query.page) || 1,
            limit: req.query.limit !== undefined ? parseInt(req.query.limit) : 10
        };
        next();
    }

    validateBattleId(req, res, next) {
        if (!req.params.battleId) {
            return ResponseUtils.sendError(res, {
                statusCode: 400,
                message: 'Відсутній ID бою'
            });
        }
        next();
    }

    asyncHandler(fn) {
        return (req, res, next) => {
            Promise.resolve(fn(req, res, next)).catch(next);
        };
    }

    getRouter() {
        return this.router;
    }
}

module.exports = UnifiedRouter;