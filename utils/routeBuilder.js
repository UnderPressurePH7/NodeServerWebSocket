const { unifiedAuth } = require('../middleware/unifiedAuth');
const { clientCors, serverCors } = require('../middleware/cors');
const { version } = require('../package.json');
const ResponseUtils = require('./responseUtils');

class RouteBuilder {
    constructor(app, controller) {
        this.app = app;
        this.controller = controller;
    }

    addClientHeaders = (req, res, next) => {
        res.set({
            'X-API-Version': version,
            'X-Powered-By': 'BattleStats-Client-API',
            'X-Request-ID': `cli_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        next();
    };

    addServerHeaders = (req, res, next) => {
        res.set({
            'X-API-Version': version,
            'X-Powered-By': 'BattleStats-Server-API',
            'X-Request-ID': `srv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        next();
    };

    validatePagination = (req, res, next) => {
        req.pagination = {
            page: parseInt(req.query.page) || 1,
            limit: req.query.limit !== undefined ? parseInt(req.query.limit) : 10
        };
        next();
    };

    validateBattleId = (req, res, next) => {
        if (!req.params.battleId) {
            return ResponseUtils.sendError(res, {
                statusCode: 400,
                message: 'Відсутній ID бою'
            });
        }
        next();
    };

    asyncHandler = (fn) => (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };

    getRouteConfigs() {
        return [
            {
                method: 'post',
                path: '/update-stats',
                handler: this.controller.updateStats,
                middleware: [this.validatePlayerId]
            },
            {
                method: 'get',
                path: '/stats',
                handler: this.controller.getStats,
                middleware: [this.validatePagination]
            },
            {
                method: 'post',
                path: '/import',
                handler: this.controller.importStats,
                middleware: []
            },
            {
                method: 'delete',
                path: '/clear',
                handler: this.controller.clearStats,
                middleware: []
            },
            {
                method: 'delete',
                path: '/battle/:battleId',
                handler: this.controller.deleteBattle,
                middleware: [this.validateBattleId]
            },
            {
                method: 'delete',
                path: '/clear-database',
                handler: this.controller.clearDatabase,
                middleware: [],
                requireSecret: true
            }
        ];
    }

    buildRoutes(basePath, headerMiddleware, corsMiddleware, requireSecret = false, skipCors = false) {
        const routes = this.getRouteConfigs();
        
        routes.forEach(({ method, path, handler, middleware = [], requireSecret: routeRequireSecret = false }) => {
            const fullPath = `${basePath}${path}`;
            const allMiddleware = [
                headerMiddleware,
                unifiedAuth.createHttpMiddleware(requireSecret || routeRequireSecret),
                ...middleware
            ];

            if (!skipCors) {
                allMiddleware.unshift(corsMiddleware);
            }

            this.app[method](fullPath, ...allMiddleware, this.asyncHandler(handler));
        });
    }

    buildClientRoutes() {
        this.buildRoutes('/api/battle-stats', this.addClientHeaders, clientCors, false, false);
    }

    buildServerRoutes() {
        this.buildRoutes('/api/server', this.addServerHeaders, null, true, true);
    }
}

module.exports = RouteBuilder;