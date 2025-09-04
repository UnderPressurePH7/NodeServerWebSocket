const cors = require('cors');

const clientCors = cors({
    origin: ['https://underpressureph7.github.io', 'http://localhost:3000', 'http://127.0.0.1:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Player-ID', 'Authorization'],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 204
});

const serverCors = cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Player-ID', 'X-Secret-Key', 'Authorization'],
    credentials: false,
    preflightContinue: false,
    optionsSuccessStatus: 204
});

module.exports = { clientCors, serverCors };