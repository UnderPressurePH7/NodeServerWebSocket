const PQueue = require('p-queue').default;

const concurrency = process.env.NODE_ENV === 'production' ? 50 : 20;
const timeout = parseInt(process.env.QUEUE_TIMEOUT) || 30000;
const intervalCap = parseInt(process.env.QUEUE_INTERVAL_CAP) || 1000;
const interval = parseInt(process.env.QUEUE_INTERVAL) || 100;
const maxQueueSize = 5000;

class PerKeyQueueManager {
    constructor() {
        this.queues = new Map();
        this.defaultQueue = new PQueue({
            concurrency,
            timeout,
            throwOnTimeout: false,
            intervalCap,
            interval,
            carryoverConcurrencyCount: false
        });
        this.batchProcessor = new Map();
        this.batchTimeouts = new Map();
        this.batchSize = 50;
        this.batchDelay = 100;
    }

    getQueue(key) {
        if (!this.queues.has(key)) {
            const queue = new PQueue({
                concurrency: Math.floor(concurrency / 2),
                timeout,
                throwOnTimeout: false,
                intervalCap: Math.floor(intervalCap / 2),
                interval,
                carryoverConcurrencyCount: false
            });

            queue.on('idle', () => {
                setTimeout(() => {
                    if (queue.size === 0 && queue.pending === 0) {
                        this.queues.delete(key);
                    }
                }, 60000);
            });

            this.queues.set(key, queue);
        }
        return this.queues.get(key);
    }

    async addToBatch(key, task, options = {}) {
        if (!this.batchProcessor.has(key)) {
            this.batchProcessor.set(key, []);
        }

        const batch = this.batchProcessor.get(key);
        batch.push({ task, options });

        if (batch.length >= this.batchSize) {
            this.processBatch(key);
        } else if (!this.batchTimeouts.has(key)) {
            const timeoutId = setTimeout(() => {
                this.processBatch(key);
            }, this.batchDelay);
            this.batchTimeouts.set(key, timeoutId);
        }

        return new Promise((resolve, reject) => {
            task.resolve = resolve;
            task.reject = reject;
        });
    }

    async processBatch(key) {
        const batch = this.batchProcessor.get(key);
        if (!batch || batch.length === 0) return;

        this.batchProcessor.set(key, []);
        
        if (this.batchTimeouts.has(key)) {
            clearTimeout(this.batchTimeouts.get(key));
            this.batchTimeouts.delete(key);
        }

        const queue = this.getQueue(key);
        
        const batchPromise = queue.add(async () => {
            const results = [];
            for (const { task, options } of batch) {
                try {
                    const result = await task();
                    results.push(result);
                    if (task.resolve) task.resolve(result);
                } catch (error) {
                    if (task.reject) task.reject(error);
                    results.push({ error });
                }
            }
            return results;
        }, { priority: 5 });

        return batchPromise;
    }

    isQueueFull(key) {
        const queue = key ? this.getQueue(key) : this.defaultQueue;
        return queue.size >= maxQueueSize;
    }

    async addWithRetry(key, task, options = {}) {
        const { retries = 3, retryDelay = 1000, priority = 0, batch = false } = options;
        
        if (batch) {
            return this.addToBatch(key, task, options);
        }

        const queue = key ? this.getQueue(key) : this.defaultQueue;
        
        return queue.add(
            () => this.withRetry(task, retries, retryDelay),
            { priority }
        );
    }

    async withRetry(task, maxRetries = 3, delay = 1000) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await task();
            } catch (error) {
                lastError = error;
                
                if (attempt === maxRetries) {
                    throw error;
                }
                
                if (error.name === 'TimeoutError') {
                    throw error;
                }
                
                const backoffDelay = delay * Math.pow(2, attempt - 1);
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
            }
        }
        
        throw lastError;
    }

    addCritical(key, task, options = {}) {
        const queue = key ? this.getQueue(key) : this.defaultQueue;
        return queue.add(task, { priority: 10, ...options });
    }

    getQueueStats() {
        const stats = {
            defaultQueue: {
                size: this.defaultQueue.size,
                pending: this.defaultQueue.pending,
                isPaused: this.defaultQueue.isPaused
            },
            perKeyQueues: {}
        };

        for (const [key, queue] of this.queues) {
            stats.perKeyQueues[key] = {
                size: queue.size,
                pending: queue.pending,
                isPaused: queue.isPaused
            };
        }

        return stats;
    }

    async gracefulShutdown() {
        console.log('Вимкнення черг...');
        
        this.defaultQueue.pause();
        for (const queue of this.queues.values()) {
            queue.pause();
        }

        for (const key of this.batchProcessor.keys()) {
            await this.processBatch(key);
        }

        const allQueues = [this.defaultQueue, ...this.queues.values()];
        const shutdownPromises = allQueues.map(queue => {
            if (queue.size > 0 || queue.pending > 0) {
                return Promise.race([
                    queue.onIdle(),
                    new Promise(resolve => setTimeout(resolve, 30000))
                ]);
            }
            return Promise.resolve();
        });

        try {
            await Promise.all(shutdownPromises);
            console.log('Всі завдання черги завершено');
        } catch (error) {
            console.error('Помилка під час завершення роботи черги:', error);
        }

        this.queues.clear();
        this.batchProcessor.clear();
        this.batchTimeouts.clear();
    }
}

const queueManager = new PerKeyQueueManager();

module.exports = {
    queue: queueManager.defaultQueue,
    queueManager,
    addWithRetry: (key, task, options) => queueManager.addWithRetry(key, task, options),
    addCritical: (key, task, options) => queueManager.addCritical(key, task, options),
    gracefulShutdown: () => queueManager.gracefulShutdown(),
    isQueueFull: (key) => queueManager.isQueueFull(key),
    getQueueStats: () => queueManager.getQueueStats()
};