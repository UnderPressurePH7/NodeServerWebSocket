const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const MONGODB_URI = 'mongodb+srv://mrfilthyvv:SUJlDOMr4qP2zOIm@underdb.oyw0ym2.mongodb.net/battlestats?retryWrites=true&w=majority&appName=underDB';

    const options = {
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    };

    const conn = await mongoose.connect(MONGODB_URI, options);
    console.log(`MongoDB Atlas підключено: ${conn.connection.host}`);

    mongoose.connection.on('connected', () => {
      console.log('Mongoose підключено до MongoDB Atlas');
    });

    mongoose.connection.on('error', (err) => {
      console.error('Помилка підключення Mongoose:', err);
    });

    mongoose.connection.on('disconnected', () => {
      console.log('Mongoose відключено від MongoDB Atlas');
    });

  } catch (error) {
    console.error('Помилка підключення до MongoDB:', error);
  }
};

process.on('SIGINT', async () => {
  try {
    await mongoose.connection.close();
    console.log('Mongoose підключення закрито через завершення програми');
    process.exit(0);
  } catch (err) {
    console.error('Помилка при закритті підключення:', err);
    process.exit(1);
  }
});

module.exports = connectDB;
