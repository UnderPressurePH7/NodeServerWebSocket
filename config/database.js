const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;

const connectDB = async (retryCount = 0) => {
  const options = {
    connectTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
    minPoolSize: 2,
    maxIdleTimeMS: 30000,
    bufferCommands: false,
    retryWrites: true,
    retryReads: true
  };

  try {
    await mongoose.connect(MONGODB_URI, options);
    console.log(`✅ MongoDB підключено: ${mongoose.connection.host}`);

    if (retryCount > 0) {
      console.log(`Успішно перепідключено після ${retryCount} спроб`);
    }
  } catch (error) {
    console.error(`❌ Помилка підключення до MongoDB (спроба ${retryCount + 1}/${MAX_RETRIES}):`, error.message);

    if (retryCount < MAX_RETRIES - 1) {
      const delay = RETRY_DELAY * Math.pow(2, retryCount);
      console.log(`Повторна спроба підключення через ${delay}ms...`);

      await new Promise(resolve => setTimeout(resolve, delay));
      return connectDB(retryCount + 1);
    } else {
      console.error('🚨 Вичерпано всі спроби підключення до MongoDB');
      throw error;
    }
  }
};

mongoose.connection.on('error', (err) => {
  console.error('Помилка з\'єднання MongoDB:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB відключено');
});

mongoose.connection.on('reconnected', () => {
  console.log('🔄 MongoDB перепідключено');
});

mongoose.connection.on('close', () => {
  console.log('❎ З\'єднання з MongoDB закрито');
});

module.exports = connectDB;