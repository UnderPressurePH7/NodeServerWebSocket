const cors = require('cors');

const ALLOWED_ORIGINS = [
    'https://underpressureph7.github.io'
];

const COMMON_HEADERS = [
    'Content-Type', 
    'X-API-Key', 
    'X-Player-ID', 
    'X-Secret-Key', 
    'Authorization', 
    'Accept', 
    'Origin', 
    'X-Requested-With'
];

const createCorsMiddleware = (defaultOrigin = null, additionalMethods = []) => {
    return (req, res, next) => {
        const origin = req.headers.origin;
        
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin || defaultOrigin || '*');
        } else {
            res.header('Access-Control-Allow-Origin', defaultOrigin || '*');
        }
        
        const methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', ...additionalMethods];
        res.header('Access-Control-Allow-Methods', methods.join(', '));
        res.header('Access-Control-Allow-Headers', COMMON_HEADERS.join(', '));
        res.header('Access-Control-Allow-Credentials', 'false');
        res.header('Access-Control-Max-Age', '86400');
        
        if (req.method === 'OPTIONS') {
            return res.status(204).end();
        }
        
        next();
    };
};

const clientCors = createCorsMiddleware('https://underpressureph7.github.io');

const serverCors = createCorsMiddleware('*', ['PATCH']);

const globalCors = createCorsMiddleware('*');

module.exports = { 
    clientCors, 
    serverCors, 
    globalCors,
    ALLOWED_ORIGINS,
    createCorsMiddleware 
};