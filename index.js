require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const mongoURI = process.env.MONGODB_URI;
mongoose.connect(mongoURI)
  .then(() => console.log('✅ Успешно подключено к MongoDB!'))
  .catch(err => console.error('❌ Ошибка подключения к базе:', err));

// --- ИЗМЕНЕНИЕ 1: СХЕМА СООБЩЕНИЯ ---
// Мы добавили поле chatId. Теперь каждое сообщение знает, в какой "папке" оно лежит.
const messageSchema = new mongoose.Schema({
  chatId: { type: String, required: true }, // <--- НОВОЕ ПОЛЕ
  user: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

// (Схема User остается без изменений)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

app.post('/api/test-user', async (req, res) => {
  const { username } = req.body;
  try {
    await User.deleteMany({ username });
    const newUser = new User({ username });
    await newUser.save();
    res.status(200).send({ message: "Успешно!", id: newUser._id });
  } catch (e) {
    res.status(500).send({ error: "Ошибка сервера" });
  }
});

// --- ЛОГИКА РАБОТЫ (SOCKET.IO) ---
io.on('connection', async (socket) => {
  console.log('📱 Подключен:', socket.id);

  // --- ИЗМЕНЕНИЕ 2: ЗАГРУЗКА ИСТОРИИ ПО ID ЧАТА ---
  // Теперь при входе клиент говорит: "Дай историю для ЧАТА Х"
  socket.on('joinChat', async (chatId) => {
    try {
      // Ищем в базе только те сообщения, где chatId совпадает
      const historyData = await Message.find({ chatId: chatId })
                                       .sort({ timestamp: 1 })
                                       .limit(50);
      
      socket.emit('history', historyData);
      console.log(`📜 Отправлена история для чата: ${chatId}`);
    } catch (err) {
      console.error('❌ Ошибка загрузки истории:', err);
    }
  });

  // --- ИЗМЕНЕНИЕ 3: СОХРАНЕНИЕ С УЧЕТОМ ID ЧАТА ---
  socket.on('message', async (data) => {
    try {
      // Ожидаем, что фронтенд пришлет { text, senderName, chatId }
      if (!data.text || !data.chatId) return;

      const newMessage = new Message({
        chatId: data.chatId, // <--- Сохраняем привязку к чату
        user: data.senderName || data.user || 'Аноним',
        text: data.text
      });

      await newMessage.save();
      
      // Рассылаем всем. Фронтенд сам отфильтрует, в какой чат это вывести
      io.emit('message', {
        ...data,
        id: newMessage._id,
        timestamp: newMessage.timestamp
      });

    } catch (err) {
      console.error('❌ Ошибка сообщения:', err);
    }
  });

  socket.on('disconnect', () => console.log('🔌 Отключен'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});