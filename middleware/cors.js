const cors = require('cors');

const ALLOWED_ORIGINS = [
    'https://underpressureph7.github.io',
    'http://localhost:3000',
    'http://localhost:8080'
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

const corsOptions = {
    origin: function (origin, callback) {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
        } else {
            callback(null, false);
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: COMMON_HEADERS,
    credentials: false,
    maxAge: 86400,
    optionsSuccessStatus: 200
};

const clientCors = cors(corsOptions);

const serverCors = cors({
    ...corsOptions,
    origin: '*'
});

const createCorsMiddleware = (defaultOrigin = null, additionalMethods = []) => {
    return (req, res, next) => {
        const origin = req.headers.origin;
        
        if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            res.header('Access-Control-Allow-Origin', origin || '*');
        } else if (defaultOrigin) {
            res.header('Access-Control-Allow-Origin', defaultOrigin);
        } else {
            res.header('Access-Control-Allow-Origin', '*');
        }
        
        const methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', ...additionalMethods];
        res.header('Access-Control-Allow-Methods', methods.join(', '));
        res.header('Access-Control-Allow-Headers', COMMON_HEADERS.join(', '));
        res.header('Access-Control-Allow-Credentials', 'false');
        res.header('Access-Control-Max-Age', '86400');
        
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }
        
        next();
    };
};

module.exports = { 
    clientCors, 
    serverCors, 
    ALLOWED_ORIGINS,
    createCorsMiddleware,
    corsOptions
};