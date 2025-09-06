class ShutdownManager {
    constructor() {
        this.resources = [];
        this.isShuttingDown = false;
        this.setupSignalHandlers();
    }

    registerResource(name, shutdownFn) {
        this.resources.push({ name, shutdownFn });
    }

    setupSignalHandlers() {
        process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
        
        process.on('unhandledRejection', (reason) => {
            console.error('UNHANDLED REJECTION:', reason);
        });
        
        process.on('uncaughtException', (err) => {
            console.error('UNCAUGHT EXCEPTION:', err);
            this.gracefulShutdown('UNCAUGHT_EXCEPTION');
        });
    }

    async gracefulShutdown(signal) {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        console.log(`🔻 Signal ${signal} received. Shutting down gracefully...`);

        const shutdownTimeout = setTimeout(() => {
            console.error('⚠️ Forced shutdown due to timeout');
            process.exit(1);
        }, 30000);

        try {
            for (const { name, shutdownFn } of this.resources) {
                try {
                    console.log(`Shutting down ${name}...`);
                    await shutdownFn();
                    console.log(`✅ ${name} closed`);
                } catch (error) {
                    console.error(`❌ Error closing ${name}:`, error.message);
                }
            }
            
            clearTimeout(shutdownTimeout);
            console.log('✅ Graceful shutdown completed');
            process.exit(0);
        } catch (error) {
            console.error('❌ Shutdown error:', error);
            process.exit(1);
        }
    }
}

const shutdownManager = new ShutdownManager();
module.exports = shutdownManager;