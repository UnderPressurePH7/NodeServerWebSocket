const { createClient } = require('redis');

class RedisConnectionPool {
    constructor(url, poolSize = 5) {
        this.url = url;
        this.poolSize = poolSize;
        this.connections = [];
        this.available = [];
        this.waiting = [];
        this.initialized = false;
    }

    async init() {
        if (this.initialized) return;
        
        for (let i = 0; i < this.poolSize; i++) {
            try {
                const client = createClient({ url: this.url });
                await client.connect();
                this.connections.push(client);
                this.available.push(client);
            } catch (error) {
                console.error(`Failed to create Redis connection ${i}:`, error);
            }
        }
        
        this.initialized = true;
        console.log(`Redis pool initialized with ${this.available.length} connections`);
    }

    async acquire() {
        if (!this.initialized) await this.init();
        
        if (this.available.length > 0) {
            return this.available.pop();
        }
        
        return new Promise((resolve) => {
            this.waiting.push(resolve);
        });
    }

    release(client) {
        if (!client || !client.isOpen) return;
        
        if (this.waiting.length > 0) {
            const resolve = this.waiting.shift();
            resolve(client);
        } else {
            this.available.push(client);
        }
    }

    async execute(fn) {
        const client = await this.acquire();
        try {
            return await fn(client);
        } finally {
            this.release(client);
        }
    }

    async destroy() {
        this.waiting.forEach(resolve => resolve(null));
        this.waiting = [];
        
        const closePromises = this.connections.map(client => {
            try {
                return client.quit();
            } catch (error) {
                return Promise.resolve();
            }
        });
        
        await Promise.all(closePromises);
        this.connections = [];
        this.available = [];
        this.initialized = false;
    }

    getStats() {
        return {
            total: this.connections.length,
            available: this.available.length,
            inUse: this.connections.length - this.available.length,
            waiting: this.waiting.length
        };
    }
}

module.exports = RedisConnectionPool;