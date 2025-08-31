const PQueue = require('p-queue').default;

const concurrency = process.env.NODE_ENV === 'production' ? 50 : 20;
const timeout = parseInt(process.env.QUEUE_TIMEOUT) || 15000;
const intervalCap = parseInt(process.env.QUEUE_INTERVAL_CAP) || 100;
const interval = parseInt(process.env.QUEUE_INTERVAL) || 1000;

const queue = new PQueue({
   concurrency,
   timeout,
   throwOnTimeout: false,
   intervalCap,
   interval,
   carryoverConcurrencyCount: false
});

const withRetry = async (task, maxRetries = 3, delay = 1000) => {
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
};

const addWithRetry = (task, options = {}) => {
   const { retries = 3, retryDelay = 1000, priority = 0 } = options;
   
   return queue.add(
       () => withRetry(task, retries, retryDelay),
       { priority }
   );
};

const addCritical = (task, options = {}) => {
   return queue.add(task, { priority: 10, ...options });
};

queue.on('active', () => {
   if (queue.size > 100 || queue.pending > 20) {
       console.log(`Перевантаження черги: size=${queue.size}, pending=${queue.pending}`);
   }
});

queue.on('idle', () => {
   if (process.env.NODE_ENV !== 'production') {
       console.log('Черга вільна');
   }
});

const gracefulShutdown = async () => {
   console.log('Вимкнення черги...');
   
   queue.pause();
   
   if (queue.size > 0 || queue.pending > 0) {
       console.log(`Очікування завершення ${queue.size + queue.pending} завдань...`);

       const shutdownTimeout = setTimeout(() => {
           console.log('Примусове зупинення черги через тайм-аут');
           queue.clear();
       }, 30000);
       
       try {
           await queue.onIdle();
           clearTimeout(shutdownTimeout);
           console.log('Всі завдання черги завершено');
       } catch (error) {
           console.error('Помилка під час завершення роботи черги:', error);
       }
   }
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

module.exports = {
   queue,
   addWithRetry,
   addCritical,
   gracefulShutdown
};