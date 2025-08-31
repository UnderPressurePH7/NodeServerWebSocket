const VALID_KEYS = require('../config/validKey');

const validateKey = (req, res, next) => {
    const key = req.params.key;
    
    if (!key || !VALID_KEYS.includes(key)) {
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Невірний ключ доступу',
        });
    }
    
    next();
};

// Функція валідації для WebSocket
const validateKeySocket = (key) => {
    return key && VALID_KEYS.includes(key);
};

module.exports = {
    validateKey,
    validateKeySocket
};
