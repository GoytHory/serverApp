require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const activeTokens = new Map();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
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

// Легкая схема для тестового эндпоинта
const chatUserSchema = new mongoose.Schema({
  username: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const ChatUser = mongoose.model('ChatUser', chatUserSchema);

// Схема аккаунта для авторизации
const authUserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  avatar: {
    type: String,
    default: 'https://cdn-icons-png.flaticon.com/512/149/149071.png'
  },
  status: { type: String, enum: ['online', 'offline'], default: 'offline' },
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const AuthUser = mongoose.model('AuthUser', authUserSchema);

const sanitizeUser = (userDoc) => ({
  id: userDoc._id,
  username: userDoc.username,
  avatar: userDoc.avatar,
  status: userDoc.status,
  createdAt: userDoc.createdAt
});

const getUserByToken = async (token) => {
  if (!token || !activeTokens.has(token)) {
    return null;
  }

  const userId = activeTokens.get(token);
  const user = await AuthUser.findById(userId);

  if (!user) {
    activeTokens.delete(token);
    return null;
  }

  return user;
};

app.post('/api/auth/register', async (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';

  if (username.length < 3) {
    return res.status(400).json({ error: 'Имя пользователя должно быть минимум 3 символа' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
  }

  try {
    const existingUser = await AuthUser.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ error: 'Пользователь с таким именем уже существует' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const createdUser = await AuthUser.create({
      username,
      password: hashedPassword,
      status: 'online'
    });

    const token = crypto.randomBytes(24).toString('hex');
    activeTokens.set(token, createdUser._id.toString());

    return res.status(201).json({
      token,
      user: sanitizeUser(createdUser)
    });
  } catch (err) {
    console.error('❌ Ошибка регистрации:', err);
    return res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Нужно передать username и password' });
  }

  try {
    const user = await AuthUser.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
    }

    user.status = 'online';
    await user.save();

    const token = crypto.randomBytes(24).toString('hex');
    activeTokens.set(token, user._id.toString());

    return res.status(200).json({
      token,
      user: sanitizeUser(user)
    });
  } catch (err) {
    console.error('❌ Ошибка входа:', err);
    return res.status(500).json({ error: 'Ошибка сервера при входе' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    const user = await getUserByToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    return res.status(200).json({ user: sanitizeUser(user) });
  } catch (err) {
    console.error('❌ Ошибка auth/me:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/test-user', async (req, res) => {
  const { username } = req.body;
  try {
    await ChatUser.deleteMany({ username });
    const newUser = new ChatUser({ username });
    await newUser.save();
    res.status(200).send({ message: "Успешно!", id: newUser._id });
  } catch (e) {
    res.status(500).send({ error: "Ошибка сервера" });
  }
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const user = await getUserByToken(token);

    if (!user) {
      return next(new Error('Требуется авторизация'));
    }

    socket.data.user = sanitizeUser(user);
    return next();
  } catch (err) {
    console.error('❌ Ошибка socket auth:', err);
    return next(new Error('Ошибка авторизации сокета'));
  }
});

// --- ЛОГИКА РАБОТЫ (SOCKET.IO) ---
io.on('connection', async (socket) => {
  console.log('📱 Подключен:', socket.id, socket.data.user?.username);

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

      const username = socket.data.user?.username;
      if (!username) return;

      const newMessage = new Message({
        chatId: data.chatId, // <--- Сохраняем привязку к чату
        user: username,
        text: data.text
      });

      await newMessage.save();
      
      // Рассылаем всем. Фронтенд сам отфильтрует, в какой чат это вывести
      io.emit('message', {
        ...data,
        senderName: username,
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