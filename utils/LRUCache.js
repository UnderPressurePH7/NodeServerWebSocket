class LRUCache {
    constructor(maxSize = 100, maxMemoryMB = 50) {
        this.maxSize = maxSize;
        this.maxMemory = maxMemoryMB * 1024 * 1024;
        this.cache = new Map();
        this.memoryUsage = 0;
    }

    estimateSize(value) {
        try {
            return Buffer.from(JSON.stringify(value)).length;
        } catch {
            return 1024;
        }
    }

    get(key) {
        if (!this.cache.has(key)) return null;
        
        const item = this.cache.get(key);
        if (Date.now() > item.expiry) {
            this.delete(key);
            return null;
        }
        
        this.cache.delete(key);
        this.cache.set(key, item);
        return item.value;
    }

    set(key, value, ttl = 300000) {
        if (this.cache.has(key)) {
            const oldItem = this.cache.get(key);
            this.memoryUsage -= oldItem.size;
            this.cache.delete(key);
        }

        const size = this.estimateSize(value);
        const item = {
            value,
            size,
            expiry: Date.now() + ttl
        };

        while (this.memoryUsage + size > this.maxMemory || this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (!firstKey) break;
            this.delete(firstKey);
        }

        this.cache.set(key, item);
        this.memoryUsage += size;
    }

    delete(key) {
        if (!this.cache.has(key)) return false;
        const item = this.cache.get(key);
        this.memoryUsage -= item.size;
        return this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
        this.memoryUsage = 0;
    }

    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            memoryUsage: this.memoryUsage,
            maxMemory: this.maxMemory,
            memoryUsageMB: Math.round(this.memoryUsage / 1024 / 1024 * 100) / 100
        };
    }

    cleanup() {
        const now = Date.now();
        for (const [key, item] of this.cache) {
            if (now > item.expiry) {
                this.delete(key);
            }
        }
    }
}

module.exports = LRUCache;