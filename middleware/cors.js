const cors = require('cors');

const corsOptions = {
    origin: function (origin, callback) {
        const allowedOrigins = [
            'https://underpressureph7.github.io',
            'http://localhost:3000',
            'http://127.0.0.1:3000',
            'http://localhost:8080',
            'https://localhost:3000'
        ];
        
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(null, true);
        }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Content-Type', 
        'X-API-Key', 
        'X-Player-ID', 
        'X-Secret-Key',
        'Authorization',
        'Accept',
        'Origin',
        'X-Requested-With'
    ],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400
};

const clientCors = cors(corsOptions);

const serverCors = cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
        'Content-Type', 
        'X-API-Key', 
        'X-Player-ID', 
        'X-Secret-Key', 
        'Authorization',
        'Accept',
        'Origin',
        'X-Requested-With'
    ],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400
});

module.exports = { clientCors, serverCors };