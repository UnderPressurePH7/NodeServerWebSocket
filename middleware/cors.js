const cors = require('cors');

const clientCors = cors({
    origin: 'https://underpressureph7.github.io',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Player-ID'],
    credentials: false
});

const serverCors = cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Player-ID', 'X-Secret-Key'],
    credentials: false
});

module.exports = { clientCors, serverCors };
