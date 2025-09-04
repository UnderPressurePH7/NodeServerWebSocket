const simpleCors = (req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigins = [
        'https://underpressureph7.github.io',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'https://localhost:3000'
    ];

    if (!origin || allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin || 'https://underpressureph7.github.io');
    } else {
        res.header('Access-Control-Allow-Origin', 'https://underpressureph7.github.io');
    }
    
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Player-ID, X-Secret-Key, Authorization, Accept, Origin, X-Requested-With');
    res.header('Access-Control-Allow-Credentials', 'false');
    res.header('Access-Control-Max-Age', '86400');
    
    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    
    next();
};

module.exports = { clientCors: simpleCors, serverCors: simpleCors };