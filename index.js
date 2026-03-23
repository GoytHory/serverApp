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
const onlineConnections = new Map();

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const mongoURI = process.env.MONGODB_URI;
mongoose.connect(mongoURI)
  .then(() => console.log('✅ Успешно подключено к MongoDB!'))
  .catch(err => console.error('❌ Ошибка подключения к базе:', err));

// --- PRESENCE TRACKING ---
const userLastActivity = new Map(); // userId -> lastActivityTime
const INACTIVITY_TIMEOUT = 35000; // 35 seconds

const recordActivity = (userId) => {
  if (userId) {
    userLastActivity.set(userId.toString(), Date.now());
  }
};

const cleanupInactiveUsers = async () => {
  const now = Date.now();
  for (const [userId, lastActivity] of userLastActivity.entries()) {
    if (now - lastActivity > INACTIVITY_TIMEOUT) {
      userLastActivity.delete(userId);
      onlineConnections.delete(userId);
      await ensureUserOnlineStatus(userId, false);
      console.log(`⏱️  Пользователь ${userId} неактивен, статус: offline`);
    }
  }
};

// Запускаем cleanup каждые 20 секунд
setInterval(cleanupInactiveUsers, 20000);

// --- СХЕМА СООБЩЕНИЯ ---
const messageSchema = new mongoose.Schema({
  chatId:    { type: String, required: true, index: true },
  sender:    { type: mongoose.Schema.Types.ObjectId, ref: 'AuthUser', required: true },
  text:      { type: String, required: true },
  timestamp: { type: Date, default: Date.now }
}, { versionKey: false });

const Message = mongoose.model('Message', messageSchema);

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

const directChatSchema = new mongoose.Schema({
  chatId:       { type: String, required: true, unique: true },
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'AuthUser', required: true }],
  lastMessage:  {
    text:      String,
    sender:    { type: mongoose.Schema.Types.ObjectId, ref: 'AuthUser' },
    timestamp: Date
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });

const DirectChat = mongoose.model('DirectChat', directChatSchema);

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

const getTokenFromAuthHeader = (authHeader) => {
  if (!authHeader) return null;
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
};

const authMiddleware = async (req, res, next) => {
  try {
    const token = getTokenFromAuthHeader(req.headers.authorization || '');
    const user = await getUserByToken(token);

    if (!user) {
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    req.authUser = user;
    req.authToken = token;
    return next();
  } catch (err) {
    console.error('❌ Ошибка auth middleware:', err);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
};

const buildDirectChatId = (firstUserId, secondUserId) => {
  const sortedIds = [firstUserId.toString(), secondUserId.toString()].sort();
  return `dm:${sortedIds[0]}:${sortedIds[1]}`;
};

const ensureUserOnlineStatus = async (userId, isOnline) => {
  try {
    await AuthUser.findByIdAndUpdate(userId, {
      status: isOnline ? 'online' : 'offline'
    });
  } catch (err) {
    console.error('❌ Ошибка обновления статуса:', err);
  }
};

app.post('/api/auth/register', async (req, res) => {
  console.log('🔄 [REGISTER] Начало обработки регистрации');
  const startTime = Date.now();
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';

  if (username.length < 3) {
    return res.status(400).json({ error: 'Имя пользователя должно быть минимум 3 символа' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
  }

  try {
    console.log(`⏱️  [REGISTER] Ищу пользователя "${username}" в БД...`);
    const existingUser = await AuthUser.findOne({ username });
    if (existingUser) {
      console.log(`⏱️  [REGISTER] Пользователь уже существует (${Date.now() - startTime}ms)`);
      return res.status(409).json({ error: 'Пользователь с таким именем уже существует' });
    }

    console.log(`⏱️  [REGISTER] Хэширую пароль...`);
    const hashedPassword = await bcrypt.hash(password, 10);
    
    console.log(`⏱️  [REGISTER] Создаю пользователя в БД...`);
    const createdUser = await AuthUser.create({
      username,
      password: hashedPassword,
      status: 'online'
    });

    console.log(`⏱️  [REGISTER] Генерирую токен...`);
    const token = crypto.randomBytes(24).toString('hex');
    activeTokens.set(token, createdUser._id.toString());

    const totalTime = Date.now() - startTime;
    console.log(`✅ [REGISTER] Готово за ${totalTime}ms`);

    return res.status(201).json({
      token,
      user: sanitizeUser(createdUser)
    });
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [REGISTER] Ошибка за ${totalTime}ms:`, err.message);
    return res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  console.log('🔄 [LOGIN] Начало обработки входа');
  const startTime = Date.now();
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Нужно передать username и password' });
  }

  try {
    console.log(`⏱️  [LOGIN] Ищу пользователя "${username}" в БД...`);
    const user = await AuthUser.findOne({ username });
    if (!user) {
      const time = Date.now() - startTime;
      console.log(`❌ [LOGIN] Пользователь не найден (${time}ms)`);
      return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
    }

    console.log(`⏱️  [LOGIN] Проверяю пароль...`);
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      const time = Date.now() - startTime;
      console.log(`❌ [LOGIN] Неверный пароль (${time}ms)`);
      return res.status(401).json({ error: 'Неверное имя пользователя или пароль' });
    }

    console.log(`⏱️  [LOGIN] Обновляю статус на online...`);
    user.status = 'online';
    await user.save();

    console.log(`⏱️  [LOGIN] Генерирую токен...`);
    const token = crypto.randomBytes(24).toString('hex');
    activeTokens.set(token, user._id.toString());

    const totalTime = Date.now() - startTime;
    console.log(`✅ [LOGIN] Готово за ${totalTime}ms`);

    return res.status(200).json({
      token,
      user: sanitizeUser(user)
    });
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [LOGIN] Ошибка за ${totalTime}ms:`, err.message);
    return res.status(500).json({ error: 'Ошибка сервера при входе' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  console.log('🔄 [ME] Запрос профиля');
  const startTime = Date.now();
  try {
    const token = getTokenFromAuthHeader(req.headers.authorization || '');

    const user = await getUserByToken(token);
    if (!user) {
      const time = Date.now() - startTime;
      console.log(`❌ [ME] Требуется авторизация (${time}ms)`);
      return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const totalTime = Date.now() - startTime;
    console.log(`✅ [ME] Готово за ${totalTime}ms`);
    
    return res.status(200).json({ user: sanitizeUser(user) });
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [ME] Ошибка за ${totalTime}ms:`, err.message);
    return res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.patch('/api/users/me', authMiddleware, async (req, res) => {
  const avatar = (req.body?.avatar || '').trim();

  if (!avatar) {
    return res.status(400).json({ error: 'Нужно передать avatar' });
  }

  try {
    req.authUser.avatar = avatar;
    await req.authUser.save();

    return res.status(200).json({ user: sanitizeUser(req.authUser) });
  } catch (err) {
    console.error('❌ Ошибка обновления профиля:', err);
    return res.status(500).json({ error: 'Ошибка сервера при обновлении профиля' });
  }
});

app.get('/api/users/search', authMiddleware, async (req, res) => {
  const query = (req.query.q || '').toString().trim();

  if (query.length < 2) {
    return res.status(200).json({ users: [] });
  }

  try {
    const users = await AuthUser.find({
      username: { $regex: query, $options: 'i' },
      _id: { $ne: req.authUser._id }
    })
      .sort({ username: 1 })
      .limit(20);

    return res.status(200).json({ users: users.map(sanitizeUser) });
  } catch (err) {
    console.error('❌ Ошибка поиска пользователей:', err);
    return res.status(500).json({ error: 'Ошибка сервера при поиске пользователей' });
  }
});

app.get('/api/chats/direct', authMiddleware, async (req, res) => {
  console.log('🔄 [CHATS] Запрос списка персональных чатов');
  const startTime = Date.now();
  try {
    const myUserId = req.authUser._id;
    console.log(`⏱️  [CHATS] Ищу чаты для пользователя ${myUserId}...`);
    const chats = await DirectChat.find({ participants: myUserId }).sort({ updatedAt: -1 });
    
    console.log(`⏱️  [CHATS] Загружаю данные пользователей для ${chats.length} чатов...`);
    const preview = await Promise.all(
      chats.map(async (chat) => {
        const otherUserId = chat.participants.find((id) => id.toString() !== myUserId.toString());
        if (!otherUserId) {
          return null;
        }

        const otherUser = await AuthUser.findById(otherUserId);
        if (!otherUser) {
          return null;
        }

        return {
          chatId: chat.chatId,
          otherUser: sanitizeUser(otherUser),
          lastMessage: chat.lastMessage || null,
          updatedAt: chat.updatedAt
        };
      })
    );

    const totalTime = Date.now() - startTime;
    console.log(`✅ [CHATS] Готово за ${totalTime}ms (найдено ${preview.filter(Boolean).length} чатов)`);
    
    return res.status(200).json({ chats: preview.filter(Boolean) });
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [CHATS] Ошибка за ${totalTime}ms:`, err.message);
    return res.status(500).json({ error: 'Ошибка сервера при загрузке чатов' });
  }
});

app.post('/api/chats/direct', authMiddleware, async (req, res) => {
  const targetUserId = (req.body?.targetUserId || '').toString().trim();

  if (!targetUserId) {
    return res.status(400).json({ error: 'Нужно передать targetUserId' });
  }

  if (targetUserId === req.authUser._id.toString()) {
    return res.status(400).json({ error: 'Нельзя создать чат с самим собой' });
  }

  try {
    const targetUser = await AuthUser.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const chatId = buildDirectChatId(req.authUser._id, targetUser._id);
    let chat = await DirectChat.findOne({ chatId });

    if (!chat) {
      chat = await DirectChat.create({
        chatId,
        participants: [req.authUser._id, targetUser._id]
      });
    } else {
      chat.updatedAt = new Date();
      await chat.save();
    }

    return res.status(200).json({
      chatId: chat.chatId,
      otherUser: sanitizeUser(targetUser)
    });
  } catch (err) {
    console.error('❌ Ошибка создания персонального чата:', err);
    return res.status(500).json({ error: 'Ошибка сервера при создании чата' });
  }
});

// --- История сообщений (с пагинацией по курсору) ---
app.get('/api/chats/:chatId/messages', authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  const before = req.query.before ? new Date(req.query.before) : new Date();
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);

  try {
    // Только участник чата может читать его сообщения
    const chat = await DirectChat.findOne({ chatId, participants: req.authUser._id });
    if (!chat) {
      return res.status(403).json({ error: 'Нет доступа к этому чату' });
    }

    const messages = await Message.find({ chatId, timestamp: { $lt: before } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .populate('sender', 'username avatar');

    return res.status(200).json({ messages: messages.reverse() });
  } catch (err) {
    console.error('❌ Ошибка загрузки сообщений:', err);
    return res.status(500).json({ error: 'Ошибка сервера при загрузке сообщений' });
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

  const userId = socket.data.user?.id?.toString();
  if (userId) {
    recordActivity(userId);
    const count = onlineConnections.get(userId) || 0;
    onlineConnections.set(userId, count + 1);
    if (count === 0) {
      await ensureUserOnlineStatus(userId, true);
    }
  }

  // --- HEARTBEAT: Клиент периодически пингует для обновления активности ---
  socket.on('ping', () => {
    const userId = socket.data.user?.id?.toString();
    if (userId) {
      recordActivity(userId);
    }
  });

  // --- ВХОД В КОМНАТУ ЧАТА ---
  socket.on('joinChat', async (chatId) => {
    try {
      const userId = socket.data.user?.id?.toString();
      recordActivity(userId);

      // Только участник чата может войти в комнату
      const chat = await DirectChat.findOne({ chatId, participants: userId });
      if (!chat) {
        socket.emit('error', { message: 'Нет доступа к чату' });
        return;
      }

      socket.join(chatId);
      console.log(`🚪 ${socket.data.user?.username} вошёл в чат: ${chatId}`);
    } catch (err) {
      console.error('❌ Ошибка joinChat:', err);
    }
  });

  // --- ОТПРАВКА СООБЩЕНИЯ ---
  socket.on('message', async (data) => {
    try {
      const userId = socket.data.user?.id?.toString();
      recordActivity(userId);

      if (userId) {
        await ensureUserOnlineStatus(userId, true);
      }

      // Ожидаем { text: string, chatId: string }
      if (!data.text || !data.chatId) return;

      // Только участник может отправлять сообщения в чат
      const chat = await DirectChat.findOne({ chatId: data.chatId, participants: userId });
      if (!chat) return;

      const newMessage = await Message.create({
        chatId:  data.chatId,
        sender:  userId,
        text:    data.text.trim()
      });

      // Обновляем мета-данные чата
      await DirectChat.updateOne(
        { chatId: data.chatId },
        {
          $set: {
            updatedAt:   newMessage.timestamp,
            lastMessage: {
              text:      newMessage.text,
              sender:    userId,
              timestamp: newMessage.timestamp
            }
          }
        }
      );

      const payload = {
        id:        newMessage._id,
        chatId:    data.chatId,
        sender: {
          id:       socket.data.user.id,
          username: socket.data.user.username,
          avatar:   socket.data.user.avatar
        },
        text:      newMessage.text,
        timestamp: newMessage.timestamp
      };

      // Рассылаем ТОЛЬКО участникам этого чата
      io.to(data.chatId).emit('message', payload);

    } catch (err) {
      console.error('❌ Ошибка сообщения:', err);
    }
  });

  socket.on('disconnect', async () => {
    console.log('🔌 Отключен');

    const disconnectedUserId = socket.data.user?.id?.toString();
    if (!disconnectedUserId) {
      return;
    }

    const count = onlineConnections.get(disconnectedUserId) || 0;
    if (count <= 1) {
      onlineConnections.delete(disconnectedUserId);
      userLastActivity.delete(disconnectedUserId);
      await ensureUserOnlineStatus(disconnectedUserId, false);
      return;
    }

    onlineConnections.set(disconnectedUserId, count - 1);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});