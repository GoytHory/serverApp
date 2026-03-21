require('dotenv').config(); // 1. Загружаем переменные из .env (для локальной разработки)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);

// 2. Настройка Socket.io с CORS для работы с мобильными устройствами
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// 3. Подключение к базе данных MongoDB
// Убедись, что в .env или в настройках Render переменная MONGODB_URI указана верно
const mongoURI = process.env.MONGODB_URI;

mongoose.connect(mongoURI)
  .then(() => console.log('✅ Успешно подключено к MongoDB!'))
  .catch(err => console.error('❌ Ошибка подключения к базе:', err));

// 4. Описание схемы сообщения (что и как храним в базе)
const messageSchema = new mongoose.Schema({
  user: { type: String, required: true },
  text: { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

// 5. Логика работы через WebSockets
io.on('connection', async (socket) => {
  console.log('📱 Пользователь подключился. ID сокета:', socket.id);

  // ПРИ ПОДКЛЮЧЕНИИ: Отправляем историю сообщений
  try {
    // Берем последние 50 сообщений, сортируем по времени (от старых к новым)
    const historyData = await Message.find().sort({ timestamp: 1 }).limit(50);
    
    // Отправляем ТОЛЬКО тому, кто только что зашел
    socket.emit('history', historyData);
    console.log(`📜 История отправлена: ${historyData.length} сообщений.`);
  } catch (err) {
    console.error('❌ Ошибка при загрузке истории:', err);
  }

  // ПРИ НОВОМ СООБЩЕНИИ: Сохраняем и рассылаем всем
  socket.on('message', async (data) => {
    try {
      console.log('📩 Получено сообщение с фронтенда:', data);

      // Проверка: если текста нет, не сохраняем
      if (!data.text || data.text.trim() === "") {
        console.log("⚠️ Попытка отправить пустое сообщение проигнорирована.");
        return;
      }

      // 1. Создаем объект сообщения для базы
      // Поддерживаем разные форматы (senderName от Expo или user от старых билдов)
      const newMessage = new Message({
        user: data.senderName || data.user || 'Аноним',
        text: data.text
      });

      // 2. Сохраняем в облако MongoDB
      await newMessage.save();
      console.log('💾 Сообщение успешно сохранено в MongoDB');

      // 3. Рассылаем сообщение ВСЕМ подключенным пользователям
      // Добавляем ID из базы, чтобы фронтенд мог использовать его как ключ (key)
      io.emit('message', {
        ...data,
        id: newMessage._id,
        timestamp: newMessage.timestamp
      });

    } catch (err) {
      console.error('❌ Ошибка при обработке сообщения:', err);
    }
  });

  // ПРИ ОТКЛЮЧЕНИИ
  socket.on('disconnect', () => {
    console.log('🔌 Пользователь покинул чат');
  });
});

// 6. Запуск сервера на порту (Render сам назначит PORT, либо 3000 локально)
const PORT = process.env.PORT || 3000;

// Специальный адрес для проверки работоспособности (Health Check)
app.get('/keep-alive', (req, res) => {
  res.status(200).send('Server is running');
});

// Слушаем на 0.0.0.0, чтобы Render мог "видеть" сервер снаружи
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен и готов к работе на порту ${PORT}`);
});