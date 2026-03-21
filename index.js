const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Разрешаем всем подключаться
    methods: ["GET", "POST"]
  }
});
const mongoose = require('mongoose');

// Вставь сюда свою ссылку из скриншота, заменив пароль!
const mongoURI = process.env.MONGODB_URI;

mongoose.connect(mongoURI)
  .then(() => console.log('Успешно подключено к MongoDB!'))
  .catch(err => console.error('Ошибка подключения к базе:', err));

// Создаем "Схему" — как будет выглядеть сообщение в базе
const messageSchema = new mongoose.Schema({
  user: String,
  text: String,
  timestamp: { type: Date, default: Date.now }
});

// Создаем модель
const Message = mongoose.model('Message', messageSchema);

io.on('connection', async (socket) => {
  try {
    // Вытягиваем последние 50 сообщений
    const history = await Message.find().sort({ timestamp: 1 }).limit(50);
    // Отправляем конкретному сокету (тому, кто только что подключился)
    socket.emit('history', history);
  } catch (err) {
    console.log('Ошибка при загрузке истории:', err);
  }

  socket.on('message', async (data) => {
  // 1. Создаем объект сообщения на основе нашей модели
  const newMessage = new Message({
    user: data.user,
    text: data.text
  });

  // 2. Сохраняем в облако MongoDB
  await newMessage.save();

  // 3. Рассылаем всем остальным (как и было раньше)
  io.emit('message', data);
});

  socket.on('disconnect', () => {
    console.log('Юзер ушел');
  });
  socket.emit('history', history);
});

// ВХОД: Берем порт, который даст Render, или 3000, если запускаем дома
const PORT = process.env.PORT || 3000;

// Специальный адрес для "будильника"
app.get('/keep-alive', (req, res) => {
  console.log('Кто-то постучал! Не сплю.');
  res.status(200).send('I am alive');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});