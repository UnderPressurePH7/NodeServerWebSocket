const PQueue = require('p-queue').default;

const queue = new PQueue({
    concurrency: process.env.NODE_ENV === 'production' ? 50 : 20, 
    timeout: 8000, 
    throwOnTimeout: true, 
    intervalCap: 100, 
    interval: 1000,
    carryoverConcurrencyCount: true 
});

queue.on('active', () => {
    console.log(`Queue size: ${queue.size}, pending: ${queue.pending}`);
});

queue.on('idle', () => {
    console.log('Queue is idle');
});

queue.on('error', (error) => {
    console.error('Queue error:', error);
});

queue.onSizeLessThan = (limit) => {
    return new Promise((resolve) => {
        const check = () => {
            if (queue.size < limit) {
                resolve();
            } else {
                setTimeout(check, 100);
            }
        };
        check();
    });
};

module.exports = queue;
