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

io.on('connection', (socket) => {
  console.log('КТО-ТО ПОДКЛЮЧИЛСЯ! ID:', socket.id);

  socket.on('message', (data) => {
    console.log('--- НОВОЕ СООБЩЕНИЕ ---');
    console.log('От кого:', data.senderName);
    console.log('Текст:', data.text);
    
    // Чтобы сообщение увидели ВСЕ, сервер должен его переслать обратно
    io.emit('message', data); 
  });

  socket.on('disconnect', () => {
    console.log('Юзер ушел');
  });
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