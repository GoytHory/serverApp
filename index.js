require("dotenv").config({ path: require("path").join(__dirname, "file.env") });
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const cors = require("cors");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const {
  evaluatePushEligibility,
  normalizePresenceState,
} = require("./pushRouting");

const app = express();
const server = http.createServer(app);
const activeTokens = new Map();
const onlineConnections = new Map();
const socketPresence = new Map();

app.use(cors({ origin: "*", methods: ["GET", "POST", "PATCH", "OPTIONS"] }));
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime(), ts: Date.now() });
});
app.use(express.json({ limit: "25mb" }));

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PATCH"] },
});

const EXPO_PUSH_API_URL = "https://exp.host/--/api/v2/push/send";

const DEFAULT_AVATAR_URL =
  "https://cdn-icons-png.flaticon.com/512/149/149071.png";

const B2_KEY_ID = (process.env.B2_KEY_ID || "").trim();
const B2_APPLICATION_KEY = (process.env.B2_APPLICATION_KEY || "").trim();
const B2_BUCKET_NAME = (process.env.B2_BUCKET_NAME || "").trim();
const normalizeEndpoint = (value) => {
  const raw = (value || "").toString().trim();
  if (!raw) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, "");
};

const B2_ENDPOINT = normalizeEndpoint(process.env.B2_ENDPOINT);
const B2_REGION = (process.env.B2_REGION || "").trim();

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const CHAT_MEDIA_URL_TTL_SEC = parsePositiveInt(
  process.env.B2_SIGNED_URL_TTL_SEC,
  6 * 60 * 60,
);
const AVATAR_URL_TTL_SEC = 60 * 60;

const requiredB2Vars = {
  B2_KEY_ID,
  B2_APPLICATION_KEY,
  B2_BUCKET_NAME,
  B2_ENDPOINT,
  B2_REGION,
};
const missingB2Vars = Object.entries(requiredB2Vars)
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (missingB2Vars.length > 0) {
  throw new Error(`Не хватает env переменных B2: ${missingB2Vars.join(", ")}`);
}

const b2Client = new S3Client({
  region: B2_REGION,
  endpoint: B2_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: B2_KEY_ID,
    secretAccessKey: B2_APPLICATION_KEY,
  },
});

const mongoURI = process.env.MONGODB_URI;
if (!mongoURI) {
  throw new Error("Не настроен MONGODB_URI");
}

mongoose
  .connect(mongoURI)
  .then(() => console.log("✅ Успешно подключено к MongoDB!"))
  .catch((err) => console.error("❌ Ошибка подключения к базе:", err));

const getSignedObjectUrl = async (objectKey, expiresInSec) => {
  if (!objectKey) {
    return null;
  }

  const command = new GetObjectCommand({
    Bucket: B2_BUCKET_NAME,
    Key: objectKey,
  });

  return getSignedUrl(b2Client, command, { expiresIn: expiresInSec });
};

const getFileExtensionByMimeType = (mimeType, fallbackExt) => {
  const map = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "audio/aac": "aac",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
  };

  return map[mimeType] || fallbackExt;
};

const putBase64ObjectToB2 = async ({ base64, objectKey, mimeType }) => {
  const bodyBuffer = Buffer.from(base64, "base64");

  await b2Client.send(
    new PutObjectCommand({
      Bucket: B2_BUCKET_NAME,
      Key: objectKey,
      Body: bodyBuffer,
      ContentType: mimeType || "application/octet-stream",
      ServerSideEncryption: "AES256",
    }),
  );
};

// --- PRESENCE TRACKING ---
const userLastActivity = new Map();
const INACTIVITY_TIMEOUT = 35000;

const recordActivity = (userId) => {
  if (userId) {
    userLastActivity.set(userId.toString(), Date.now());
  }
};

const buildUserRoomId = (userId) => `user:${userId.toString()}`;

const ensureUserOnlineStatus = async (userId, isOnline) => {
  try {
    await AuthUser.findByIdAndUpdate(userId, {
      status: isOnline ? "online" : "offline",
    });
  } catch (err) {
    console.error("❌ Ошибка обновления статуса:", err);
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

setInterval(cleanupInactiveUsers, 20000);

// --- Mongo схемы ---
const messageSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, index: true },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthUser",
      required: true,
    },
    text: { type: String, default: "" },
    media: {
      type: {
        type: String,
        enum: ["image", "audio"],
      },
      objectKey: String,
      url: String,
      mimeType: String,
      durationSec: Number,
    },
    timestamp: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

messageSchema.index({ chatId: 1, timestamp: -1 });
const Message = mongoose.model("Message", messageSchema);

const authUserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },
    password: { type: String, required: true },
    avatarObjectKey: { type: String, default: "" },
    // legacy fallback for already stored public URLs
    avatar: { type: String, default: "" },
    expoPushToken: { type: String, default: "" },
    status: { type: String, enum: ["online", "offline"], default: "offline" },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

const AuthUser = mongoose.model("AuthUser", authUserSchema);

const directChatSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true },
    participants: [
      { type: mongoose.Schema.Types.ObjectId, ref: "AuthUser", required: true },
    ],
    participantsMeta: [
      {
        userId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "AuthUser",
          required: true,
        },
        username: { type: String, required: true },
        avatarObjectKey: { type: String, default: "" },
        avatar: { type: String, default: "" },
        updatedAt: { type: Date, default: Date.now },
      },
    ],
    lastMessage: {
      text: String,
      previewText: String,
      mediaType: String,
      sender: { type: mongoose.Schema.Types.ObjectId, ref: "AuthUser" },
      timestamp: Date,
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

directChatSchema.index({ "participantsMeta.userId": 1 });
const DirectChat = mongoose.model("DirectChat", directChatSchema);

const getOnlineStatusForUser = (userId) => {
  const onlineCount = onlineConnections.get(userId.toString()) || 0;
  return onlineCount > 0 ? "online" : "offline";
};

const getAvatarUrlForUser = async (userLike) => {
  if (userLike?.avatarObjectKey) {
    try {
      const signed = await getSignedObjectUrl(
        userLike.avatarObjectKey,
        AVATAR_URL_TTL_SEC,
      );
      if (signed) {
        return signed;
      }
    } catch (err) {
      console.error("❌ Ошибка генерации signed URL для аватара:", err.message);
    }
  }

  if (userLike?.avatar) {
    return userLike.avatar;
  }

  return DEFAULT_AVATAR_URL;
};

const sanitizeUser = async (userDoc) => ({
  id: userDoc._id,
  username: userDoc.username,
  avatar: await getAvatarUrlForUser(userDoc),
  status: userDoc.status,
  createdAt: userDoc.createdAt,
});

const toParticipantSnapshot = (userDoc) => ({
  userId: userDoc._id,
  username: userDoc.username,
  avatarObjectKey: userDoc.avatarObjectKey || "",
  avatar: userDoc.avatar || "",
  updatedAt: new Date(),
});

const snapshotToClientUser = async (snapshot) => {
  if (!snapshot?.userId) {
    return null;
  }

  const avatar = await getAvatarUrlForUser(snapshot);

  return {
    id: snapshot.userId,
    username: snapshot.username,
    avatar,
    status: getOnlineStatusForUser(snapshot.userId),
  };
};

const hasCompleteParticipantsMeta = (chatDoc) => {
  const participantsMeta = Array.isArray(chatDoc.participantsMeta)
    ? chatDoc.participantsMeta
    : [];

  return (
    participantsMeta.length === chatDoc.participants.length &&
    participantsMeta.every((entry) => entry?.userId && entry?.username)
  );
};

const buildParticipantsMetaFromMap = (participants, usersMap) => {
  const snapshots = participants
    .map((participantId) => usersMap.get(participantId.toString()))
    .filter(Boolean)
    .map((userDoc) => toParticipantSnapshot(userDoc));

  return snapshots.length === participants.length ? snapshots : [];
};

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
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
};

const authMiddleware = async (req, res, next) => {
  try {
    const token = getTokenFromAuthHeader(req.headers.authorization || "");
    const user = await getUserByToken(token);

    if (!user) {
      return res.status(401).json({ error: "Требуется авторизация" });
    }

    req.authUser = user;
    req.authToken = token;
    return next();
  } catch (err) {
    console.error("❌ Ошибка auth middleware:", err);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
};

const buildDirectChatId = (firstUserId, secondUserId) => {
  const sortedIds = [firstUserId.toString(), secondUserId.toString()].sort();
  return `dm:${sortedIds[0]}:${sortedIds[1]}`;
};

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_AUDIO_BYTES = 18 * 1024 * 1024;

const getBase64Content = (value) => {
  const normalized = (value || "").toString().trim();
  const commaIndex = normalized.indexOf(",");

  if (normalized.startsWith("data:") && commaIndex >= 0) {
    return normalized.slice(commaIndex + 1);
  }

  return normalized;
};

const getBase64ByteSize = (base64Value) => {
  try {
    return Buffer.byteLength(base64Value, "base64");
  } catch {
    return 0;
  }
};

const isExpoPushToken = (value) => {
  const token = (value || "").toString().trim();
  return /^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token);
};

const getPresenceStateSummary = (userId) => {
  const normalizedUserId = userId?.toString();
  if (!normalizedUserId) {
    return [];
  }

  const states = [];
  for (const [socketId, state] of socketPresence.entries()) {
    if (state.userId !== normalizedUserId) {
      continue;
    }

    states.push({
      socketId,
      appState: normalizePresenceState(state.appState),
      activeChatId: state.activeChatId || null,
      updatedAt: state.updatedAt || 0,
    });
  }

  return states;
};

const sendExpoPushMessages = async (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    console.log("[push] skip send: no messages prepared");
    return;
  }

  if (typeof fetch !== "function") {
    console.error("❌ fetch недоступен для отправки push-уведомлений");
    return;
  }

  const chunkSize = 100;
  for (let index = 0; index < messages.length; index += chunkSize) {
    const chunk = messages.slice(index, index + chunkSize);

    console.log("[push] sending Expo push chunk", {
      chunkSize: chunk.length,
      recipients: chunk.map((message) => message.to),
      payloadPreview: chunk.map((message) => ({
        to: message.to,
        title: message.title,
        body: message.body,
        chatId: message.data?.chatId,
      })),
    });

    try {
      const response = await fetch(EXPO_PUSH_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Accept-encoding": "gzip, deflate",
        },
        body: JSON.stringify(chunk),
      });

      const responseText = await response.text();

      console.log("[push] Expo Push API response", {
        status: response.status,
        ok: response.ok,
        body: responseText,
      });

      if (!response.ok) {
        console.error("❌ Ошибка Expo Push API:", response.status, responseText);
      }
    } catch (err) {
      console.error("❌ Ошибка отправки push-уведомления:", err.message);
    }
  }
};

const buildMessagePreviewText = (text, mediaType) => {
  const normalized = (text || "").trim();
  if (normalized) {
    return normalized;
  }

  if (mediaType === "image") {
    return "Изображение";
  }

  if (mediaType === "audio") {
    return "Голосовое сообщение";
  }

  return "Сообщение";
};

const resolveMessageMediaForClient = async (media) => {
  if (!media?.type) {
    return undefined;
  }

  let signedUrl = null;
  if (media.objectKey) {
    try {
      signedUrl = await getSignedObjectUrl(
        media.objectKey,
        CHAT_MEDIA_URL_TTL_SEC,
      );
    } catch (err) {
      console.error(
        "❌ Ошибка генерации signed URL для сообщения:",
        err.message,
      );
    }
  }

  return {
    type: media.type,
    objectKey: media.objectKey,
    url: signedUrl || media.url || "",
    mimeType: media.mimeType,
    durationSec: media.durationSec,
  };
};

const serializeMessageForClient = async (messageDoc) => {
  let sender = messageDoc.sender;

  if (sender && typeof sender === "object" && !sender.username && sender._id) {
    const fullSender = await AuthUser.findById(sender._id);
    if (fullSender) {
      sender = fullSender;
    }
  }

  let senderPayload = undefined;
  if (sender && typeof sender === "object") {
    senderPayload = {
      id: sender._id || sender.id,
      username: sender.username,
      avatar: await getAvatarUrlForUser(sender),
    };
  }

  return {
    id: messageDoc._id,
    _id: messageDoc._id,
    chatId: messageDoc.chatId,
    text: messageDoc.text || "",
    media: await resolveMessageMediaForClient(messageDoc.media),
    timestamp: messageDoc.timestamp,
    sender: senderPayload,
  };
};

app.post("/api/auth/register", async (req, res) => {
  console.log("🔄 [REGISTER] Начало обработки регистрации");
  const startTime = Date.now();
  const username = (req.body?.username || "").trim();
  const password = req.body?.password || "";

  if (username.length < 3) {
    return res
      .status(400)
      .json({ error: "Имя пользователя должно быть минимум 3 символа" });
  }

  if (password.length < 6) {
    return res
      .status(400)
      .json({ error: "Пароль должен быть минимум 6 символов" });
  }

  try {
    const existingUser = await AuthUser.findOne({ username });
    if (existingUser) {
      return res
        .status(409)
        .json({ error: "Пользователь с таким именем уже существует" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const createdUser = await AuthUser.create({
      username,
      password: hashedPassword,
      status: "online",
      avatarObjectKey: "",
      avatar: "",
    });

    const token = crypto.randomBytes(24).toString("hex");
    activeTokens.set(token, createdUser._id.toString());

    const totalTime = Date.now() - startTime;
    console.log(`✅ [REGISTER] Готово за ${totalTime}ms`);

    return res.status(201).json({
      token,
      user: await sanitizeUser(createdUser),
    });
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [REGISTER] Ошибка за ${totalTime}ms:`, err.message);
    return res.status(500).json({ error: "Ошибка сервера при регистрации" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  console.log("🔄 [LOGIN] Начало обработки входа");
  const startTime = Date.now();
  const username = (req.body?.username || "").trim();
  const password = req.body?.password || "";

  if (!username || !password) {
    return res
      .status(400)
      .json({ error: "Нужно передать username и password" });
  }

  try {
    const user = await AuthUser.findOne({ username });
    if (!user) {
      return res
        .status(401)
        .json({ error: "Неверное имя пользователя или пароль" });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res
        .status(401)
        .json({ error: "Неверное имя пользователя или пароль" });
    }

    user.status = "online";
    await user.save();

    const token = crypto.randomBytes(24).toString("hex");
    activeTokens.set(token, user._id.toString());

    const totalTime = Date.now() - startTime;
    console.log(`✅ [LOGIN] Готово за ${totalTime}ms`);

    return res.status(200).json({
      token,
      user: await sanitizeUser(user),
    });
  } catch (err) {
    const totalTime = Date.now() - startTime;
    console.error(`❌ [LOGIN] Ошибка за ${totalTime}ms:`, err.message);
    return res.status(500).json({ error: "Ошибка сервера при входе" });
  }
});

app.get("/api/auth/me", async (req, res) => {
  try {
    const token = getTokenFromAuthHeader(req.headers.authorization || "");
    const user = await getUserByToken(token);

    if (!user) {
      return res.status(401).json({ error: "Требуется авторизация" });
    }

    return res.status(200).json({ user: await sanitizeUser(user) });
  } catch (err) {
    console.error("❌ Ошибка /api/auth/me:", err.message);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

app.patch("/api/users/me", authMiddleware, async (req, res) => {
  const avatarObjectKey = (req.body?.avatarObjectKey || "").toString().trim();

  if (!avatarObjectKey) {
    return res.status(400).json({ error: "Нужно передать avatarObjectKey" });
  }

  try {
    req.authUser.avatarObjectKey = avatarObjectKey;
    req.authUser.avatar = "";
    await req.authUser.save();

    await DirectChat.updateMany(
      { "participantsMeta.userId": req.authUser._id },
      {
        $set: {
          "participantsMeta.$[participant].username": req.authUser.username,
          "participantsMeta.$[participant].avatarObjectKey":
            req.authUser.avatarObjectKey,
          "participantsMeta.$[participant].avatar": "",
          "participantsMeta.$[participant].updatedAt": new Date(),
        },
      },
      {
        arrayFilters: [{ "participant.userId": req.authUser._id }],
      },
    );

    return res.status(200).json({ user: await sanitizeUser(req.authUser) });
  } catch (err) {
    console.error("❌ Ошибка обновления профиля:", err);
    return res
      .status(500)
      .json({ error: "Ошибка сервера при обновлении профиля" });
  }
});

app.patch("/api/users/me/push-token", authMiddleware, async (req, res) => {
  const pushToken = (req.body?.pushToken || "").toString().trim();

  console.log("[push] incoming token update request", {
    userId: req.authUser?._id?.toString?.() || "unknown",
    username: req.authUser?.username || "unknown",
    hasToken: Boolean(pushToken),
    tokenPreview: pushToken ? `${pushToken.slice(0, 20)}...` : "empty",
  });

  if (pushToken && !isExpoPushToken(pushToken)) {
    console.log("[push] rejected invalid Expo push token", pushToken);
    return res.status(400).json({ error: "Некорректный pushToken" });
  }

  try {
    req.authUser.expoPushToken = pushToken;
    await req.authUser.save();
    console.log("[push] token saved successfully", {
      userId: req.authUser?._id?.toString?.() || "unknown",
      username: req.authUser?.username || "unknown",
      tokenPreview: pushToken ? `${pushToken.slice(0, 20)}...` : "empty",
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("❌ Ошибка сохранения push токена:", err);
    return res
      .status(500)
      .json({ error: "Ошибка сервера при сохранении push токена" });
  }
});

app.post("/api/media/image", authMiddleware, async (req, res) => {
  const base64 = getBase64Content(req.body?.base64);
  const mimeType = (req.body?.mimeType || "").toString().trim().toLowerCase();
  const context = (req.body?.context || "chat").toString().trim().toLowerCase();

  if (!base64) {
    return res.status(400).json({ error: "Нужно передать base64" });
  }

  const imageBytes = getBase64ByteSize(base64);
  if (!imageBytes) {
    return res.status(400).json({ error: "Некорректный base64" });
  }

  if (imageBytes > MAX_IMAGE_BYTES) {
    return res
      .status(400)
      .json({ error: "Изображение слишком большое. Максимум 12MB" });
  }

  const allowedMimeTypes = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
  ];
  if (mimeType && !allowedMimeTypes.includes(mimeType)) {
    return res
      .status(400)
      .json({ error: "Неподдерживаемый формат изображения" });
  }

  try {
    const extension = getFileExtensionByMimeType(
      mimeType || "image/jpeg",
      "jpg",
    );
    const folder = context === "avatar" ? "avatars" : "chat/images";
    const objectKey = `${folder}/${req.authUser._id}/${Date.now()}_${crypto.randomBytes(5).toString("hex")}.${extension}`;

    await putBase64ObjectToB2({
      base64,
      objectKey,
      mimeType: mimeType || "image/jpeg",
    });

    const ttl =
      context === "avatar" ? AVATAR_URL_TTL_SEC : CHAT_MEDIA_URL_TTL_SEC;
    const url = await getSignedObjectUrl(objectKey, ttl);

    return res.status(200).json({
      objectKey,
      url,
      mediaType: "image",
    });
  } catch (err) {
    console.error("❌ Ошибка загрузки изображения:", err);
    const detailedMessage =
      err?.message || err?.name || "Неизвестная ошибка загрузки";

    return res.status(500).json({
      error: "Не удалось загрузить изображение",
      details: detailedMessage,
    });
  }
});

app.post("/api/media/audio", authMiddleware, async (req, res) => {
  const base64 = getBase64Content(req.body?.base64);
  const mimeType = (req.body?.mimeType || "").toString().trim().toLowerCase();
  const durationSecRaw = req.body?.durationSec;
  const durationSec =
    typeof durationSecRaw === "number" && durationSecRaw > 0
      ? Math.round(durationSecRaw)
      : undefined;

  if (!base64) {
    return res.status(400).json({ error: "Нужно передать base64" });
  }

  const audioBytes = getBase64ByteSize(base64);
  if (!audioBytes) {
    return res.status(400).json({ error: "Некорректный base64" });
  }

  if (audioBytes > MAX_AUDIO_BYTES) {
    return res
      .status(400)
      .json({ error: "Аудио слишком большое. Максимум 18MB" });
  }

  const allowedMimeTypes = [
    "audio/aac",
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/webm",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
  ];
  if (mimeType && !allowedMimeTypes.includes(mimeType)) {
    return res.status(400).json({ error: "Неподдерживаемый аудио-формат" });
  }

  try {
    const extension = getFileExtensionByMimeType(
      mimeType || "audio/mp4",
      "m4a",
    );
    const objectKey = `chat/audio/${req.authUser._id}/${Date.now()}_${crypto.randomBytes(5).toString("hex")}.${extension}`;

    await putBase64ObjectToB2({
      base64,
      objectKey,
      mimeType: mimeType || "audio/mp4",
    });

    const url = await getSignedObjectUrl(objectKey, CHAT_MEDIA_URL_TTL_SEC);

    return res.status(200).json({
      objectKey,
      url,
      mediaType: "audio",
      mimeType: mimeType || "audio/mp4",
      durationSec,
    });
  } catch (err) {
    console.error("❌ Ошибка загрузки аудио:", err);
    const detailedMessage =
      err?.message || err?.name || "Неизвестная ошибка загрузки";

    return res.status(500).json({
      error: "Не удалось загрузить аудио",
      details: detailedMessage,
    });
  }
});

app.get("/api/users/search", authMiddleware, async (req, res) => {
  const query = (req.query.q || "").toString().trim();

  if (query.length < 2) {
    return res.status(200).json({ users: [] });
  }

  try {
    const users = await AuthUser.find({
      username: { $regex: query, $options: "i" },
      _id: { $ne: req.authUser._id },
    })
      .sort({ username: 1 })
      .limit(20);

    const serializedUsers = await Promise.all(
      users.map((user) => sanitizeUser(user)),
    );
    return res.status(200).json({ users: serializedUsers });
  } catch (err) {
    console.error("❌ Ошибка поиска пользователей:", err);
    return res
      .status(500)
      .json({ error: "Ошибка сервера при поиске пользователей" });
  }
});

app.get("/api/chats/direct", authMiddleware, async (req, res) => {
  try {
    const myUserId = req.authUser._id;
    const chats = await DirectChat.find({ participants: myUserId }).sort({
      updatedAt: -1,
    });

    const chatsMissingMeta = chats.filter(
      (chat) => !hasCompleteParticipantsMeta(chat),
    );
    const missingUserIds = Array.from(
      new Set(
        chatsMissingMeta.flatMap((chat) =>
          chat.participants.map((participantId) => participantId.toString()),
        ),
      ),
    );

    const usersMap = new Map();
    if (missingUserIds.length > 0) {
      const users = await AuthUser.find({ _id: { $in: missingUserIds } });
      users.forEach((userDoc) => {
        usersMap.set(userDoc._id.toString(), userDoc);
      });
    }

    const bulkMetaUpdates = [];
    const preview = await Promise.all(
      chats.map(async (chat) => {
        let participantsMeta = hasCompleteParticipantsMeta(chat)
          ? chat.participantsMeta
          : buildParticipantsMetaFromMap(chat.participants, usersMap);

        if (!hasCompleteParticipantsMeta(chat) && participantsMeta.length > 0) {
          bulkMetaUpdates.push({
            updateOne: {
              filter: { _id: chat._id },
              update: { $set: { participantsMeta } },
            },
          });
        }

        const otherParticipant = participantsMeta.find(
          (entry) => entry.userId.toString() !== myUserId.toString(),
        );
        const otherUser = await snapshotToClientUser(otherParticipant);

        if (!otherUser) {
          return null;
        }

        return {
          chatId: chat.chatId,
          otherUser,
          lastMessage: chat.lastMessage || null,
          updatedAt: chat.updatedAt,
        };
      }),
    );

    if (bulkMetaUpdates.length > 0) {
      await DirectChat.bulkWrite(bulkMetaUpdates, { ordered: false });
    }

    return res.status(200).json({ chats: preview.filter(Boolean) });
  } catch (err) {
    console.error("❌ Ошибка /api/chats/direct:", err.message);
    return res.status(500).json({ error: "Ошибка сервера при загрузке чатов" });
  }
});

app.post("/api/chats/direct", authMiddleware, async (req, res) => {
  const targetUserId = (req.body?.targetUserId || "").toString().trim();

  if (!targetUserId) {
    return res.status(400).json({ error: "Нужно передать targetUserId" });
  }

  if (targetUserId === req.authUser._id.toString()) {
    return res.status(400).json({ error: "Нельзя создать чат с самим собой" });
  }

  try {
    const targetUser = await AuthUser.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ error: "Пользователь не найден" });
    }

    const chatId = buildDirectChatId(req.authUser._id, targetUser._id);
    let chat = await DirectChat.findOne({ chatId });

    if (!chat) {
      chat = await DirectChat.create({
        chatId,
        participants: [req.authUser._id, targetUser._id],
        participantsMeta: [
          toParticipantSnapshot(req.authUser),
          toParticipantSnapshot(targetUser),
        ],
      });
    } else {
      chat.updatedAt = new Date();
      chat.participantsMeta = [
        toParticipantSnapshot(req.authUser),
        toParticipantSnapshot(targetUser),
      ];
      await chat.save();
    }

    return res.status(200).json({
      chatId: chat.chatId,
      otherUser: await sanitizeUser(targetUser),
    });
  } catch (err) {
    console.error("❌ Ошибка создания персонального чата:", err);
    return res.status(500).json({ error: "Ошибка сервера при создании чата" });
  }
});

app.get("/api/chats/:chatId/messages", authMiddleware, async (req, res) => {
  const { chatId } = req.params;
  const before = req.query.before ? new Date(req.query.before) : new Date();
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);

  try {
    const chat = await DirectChat.findOne({
      chatId,
      participants: req.authUser._id,
    });
    if (!chat) {
      return res.status(403).json({ error: "Нет доступа к этому чату" });
    }

    const messages = await Message.find({ chatId, timestamp: { $lt: before } })
      .sort({ timestamp: -1 })
      .limit(limit)
      .populate("sender", "username avatarObjectKey avatar");

    const orderedMessages = messages.reverse();
    const serialized = await Promise.all(
      orderedMessages.map((message) => serializeMessageForClient(message)),
    );

    return res.status(200).json({ messages: serialized });
  } catch (err) {
    console.error("❌ Ошибка загрузки сообщений:", err);
    return res
      .status(500)
      .json({ error: "Ошибка сервера при загрузке сообщений" });
  }
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const user = await getUserByToken(token);

    if (!user) {
      return next(new Error("Требуется авторизация"));
    }

    socket.data.user = await sanitizeUser(user);
    return next();
  } catch (err) {
    console.error("❌ Ошибка socket auth:", err);
    return next(new Error("Ошибка авторизации сокета"));
  }
});

io.on("connection", async (socket) => {
  console.log("📱 Подключен:", socket.id, socket.data.user?.username);

  const userId = socket.data.user?.id?.toString();
  if (userId) {
    socketPresence.set(socket.id, {
      userId,
      appState: "active",
      activeChatId: null,
      updatedAt: Date.now(),
    });
    socket.join(buildUserRoomId(userId));
    recordActivity(userId);
    const count = onlineConnections.get(userId) || 0;
    onlineConnections.set(userId, count + 1);
    if (count === 0) {
      await ensureUserOnlineStatus(userId, true);
    }
  }

  socket.on("ping", () => {
    const pingUserId = socket.data.user?.id?.toString();
    if (pingUserId) {
      recordActivity(pingUserId);
    }
  });

  socket.on("presence:update", (payload) => {
    const presenceUserId = socket.data.user?.id?.toString();
    if (!presenceUserId) {
      return;
    }

    const current =
      socketPresence.get(socket.id) ||
      ({ userId: presenceUserId, appState: "background", activeChatId: null });

    const nextAppState = normalizePresenceState(payload?.appState);
    const nextActiveChatId =
      nextAppState === "active" && typeof payload?.activeChatId === "string"
        ? payload.activeChatId.trim() || null
        : null;

    socketPresence.set(socket.id, {
      userId: presenceUserId,
      appState: nextAppState,
      activeChatId: nextActiveChatId,
      updatedAt: Date.now(),
    });

    recordActivity(presenceUserId);
  });

  socket.on("joinChat", async (chatId) => {
    try {
      const joinUserId = socket.data.user?.id?.toString();
      recordActivity(joinUserId);

      const chat = await DirectChat.findOne({
        chatId,
        participants: joinUserId,
      });
      if (!chat) {
        socket.emit("error", { message: "Нет доступа к чату" });
        return;
      }

      socket.join(chatId);
      const currentPresence = socketPresence.get(socket.id);
      if (currentPresence) {
        socketPresence.set(socket.id, {
          ...currentPresence,
          appState: normalizePresenceState(currentPresence.appState),
          activeChatId: chatId,
          updatedAt: Date.now(),
        });
      }
      console.log(`🚪 ${socket.data.user?.username} вошёл в чат: ${chatId}`);
    } catch (err) {
      console.error("❌ Ошибка joinChat:", err);
    }
  });

  socket.on("leaveChat", (chatId) => {
    if (chatId) {
      socket.leave(chatId);
      const currentPresence = socketPresence.get(socket.id);
      if (currentPresence && currentPresence.activeChatId === chatId) {
        socketPresence.set(socket.id, {
          ...currentPresence,
          activeChatId: null,
          updatedAt: Date.now(),
        });
      }
    }
  });

  socket.on("message", async (data) => {
    try {
      const senderUserId = socket.data.user?.id?.toString();
      recordActivity(senderUserId);

      if (senderUserId) {
        await ensureUserOnlineStatus(senderUserId, true);
      }

      const text = (data?.text || "").toString().trim();
      const mediaType = (data?.media?.type || "").toString().trim();
      const mediaObjectKey = (data?.media?.objectKey || "").toString().trim();
      const mediaLegacyUrl = (data?.media?.url || "").toString().trim();
      const mediaMimeType = (data?.media?.mimeType || "").toString().trim();
      const mediaDurationSec =
        typeof data?.media?.durationSec === "number" &&
        data.media.durationSec > 0
          ? Math.round(data.media.durationSec)
          : undefined;

      if (!data?.chatId) return;

      const allowedMediaTypes = ["image", "audio"];
      const hasMedia = Boolean(
        allowedMediaTypes.includes(mediaType) &&
        (mediaObjectKey || mediaLegacyUrl),
      );
      if (!text && !hasMedia) return;

      const chat = await DirectChat.findOne({
        chatId: data.chatId,
        participants: senderUserId,
      });
      if (!chat) return;

      const messageDoc = {
        chatId: data.chatId,
        sender: senderUserId,
      };

      if (text) {
        messageDoc.text = text;
      }

      if (hasMedia) {
        messageDoc.media = {
          type: mediaType,
          objectKey: mediaObjectKey || undefined,
          url: mediaLegacyUrl || undefined,
          mimeType: mediaMimeType || undefined,
          durationSec: mediaDurationSec,
        };
      }

      const newMessage = await Message.create(messageDoc);
      const previewText = buildMessagePreviewText(
        newMessage.text,
        newMessage.media?.type,
      );

      let participantsMeta = hasCompleteParticipantsMeta(chat)
        ? chat.participantsMeta
        : [];
      if (participantsMeta.length === 0) {
        const participantUsers = await AuthUser.find({
          _id: { $in: chat.participants },
        });
        const participantUsersMap = new Map(
          participantUsers.map((userDoc) => [userDoc._id.toString(), userDoc]),
        );
        participantsMeta = buildParticipantsMetaFromMap(
          chat.participants,
          participantUsersMap,
        );

        if (participantsMeta.length > 0) {
          await DirectChat.updateOne(
            { _id: chat._id },
            { $set: { participantsMeta } },
          );
        }
      }

      await DirectChat.updateOne(
        { chatId: data.chatId },
        {
          $set: {
            updatedAt: newMessage.timestamp,
            lastMessage: {
              text: newMessage.text,
              previewText,
              mediaType: newMessage.media?.type,
              sender: senderUserId,
              timestamp: newMessage.timestamp,
            },
          },
        },
      );

      const payload = {
        id: newMessage._id,
        _id: newMessage._id,
        chatId: data.chatId,
        sender: {
          id: socket.data.user.id,
          username: socket.data.user.username,
          avatar: socket.data.user.avatar,
        },
        text: newMessage.text || "",
        media: await resolveMessageMediaForClient(newMessage.media),
        timestamp: newMessage.timestamp,
      };

      const chatUpdatedBasePayload = {
        chatId: data.chatId,
        updatedAt: newMessage.timestamp,
        lastMessage: {
          text: newMessage.text || "",
          previewText,
          mediaType: newMessage.media?.type,
          sender: senderUserId,
          timestamp: newMessage.timestamp,
        },
      };

      io.to(data.chatId).emit("message", payload);

      await Promise.all(
        chat.participants.map(async (participantId) => {
          const participantIdString = participantId.toString();
          const otherParticipant = participantsMeta.find(
            (entry) => entry.userId.toString() !== participantIdString,
          );
          const otherUser = await snapshotToClientUser(otherParticipant);

          io.to(buildUserRoomId(participantIdString)).emit("chatUpdated", {
            ...chatUpdatedBasePayload,
            otherUser,
          });
        }),
      );

      const recipientIds = chat.participants
        .map((participantId) => participantId.toString())
        .filter((participantId) => participantId !== senderUserId);

      if (recipientIds.length > 0) {
        const recipients = await AuthUser.find({ _id: { $in: recipientIds } })
          .select("_id expoPushToken")
          .lean();

        console.log("[push] evaluating recipients for message", {
          chatId: data.chatId,
          senderUserId,
          recipientIds,
          recipients: recipients.map((userDoc) => {
            const userId = userDoc._id.toString();
            const presenceStates = getPresenceStateSummary(userId);
            const decision = evaluatePushEligibility({
              expoPushToken: userDoc.expoPushToken,
              presenceStates,
              chatId: data.chatId,
              tokenValidator: isExpoPushToken,
            });

            return {
              userId,
              hasOpenConnections: (onlineConnections.get(userId) || 0) > 0,
              hasActiveChatOpen: presenceStates.some(
                (presenceState) =>
                  presenceState.appState === "active" &&
                  presenceState.activeChatId === data.chatId,
              ),
              presenceStates,
              hasExpoPushToken: isExpoPushToken(userDoc.expoPushToken),
              pushDecision: decision,
              tokenPreview: userDoc.expoPushToken
                ? `${userDoc.expoPushToken.slice(0, 20)}...`
                : "empty",
            };
          }),
        });

        const pushMessages = recipients
          .filter((userDoc) => {
            const userId = userDoc._id.toString();
            const presenceStates = getPresenceStateSummary(userId);
            const decision = evaluatePushEligibility({
              expoPushToken: userDoc.expoPushToken,
              presenceStates,
              chatId: data.chatId,
              tokenValidator: isExpoPushToken,
            });
            return decision.send;
          })
          .map((userDoc) => ({
            to: userDoc.expoPushToken,
            title: socket.data.user.username,
            body: previewText,
            data: {
              chatId: data.chatId,
              senderId: senderUserId,
              senderUsername: socket.data.user.username,
              senderAvatar: socket.data.user.avatar || "",
            },
            sound: "default",
            channelId: "chat-messages",
            priority: "high",
          }));

        console.log("[push] prepared Expo push messages", {
          count: pushMessages.length,
          recipients: pushMessages.map((message) => message.to),
          chatId: data.chatId,
        });

        await sendExpoPushMessages(pushMessages);
      }
    } catch (err) {
      console.error("❌ Ошибка сообщения:", err);
    }
  });

  socket.on("disconnect", async () => {
    const disconnectedUserId = socket.data.user?.id?.toString();
    socketPresence.delete(socket.id);
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
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
