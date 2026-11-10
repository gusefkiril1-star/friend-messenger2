const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e8 // 100 MB for large payloads
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// In-memory state with JSON persistence
let state = {
  users: {}, // tag -> { tag, name, avatar, socketId, online, friends: [tags] }
  messages: {} // sorted pair key -> [ { id, sender, text, photoUrl, timestamp } ]
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      state.users = loaded.users || {};
      state.messages = loaded.messages || {};
      // Reset socketIds and online statuses on restart
      Object.keys(state.users).forEach(tag => {
        state.users[tag].socketId = null;
        state.users[tag].online = false;
      });
    }
  } catch (err) {
    console.error('Error loading data:', err);
  }
}

function saveData() {
  try {
    const toSave = {
      users: state.users,
      messages: state.messages
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving data:', err);
  }
}

loadData();

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// Serve client frontend directly if dist exists
const CLIENT_DIST = path.join(__dirname, '../client/dist');
const LOCAL_PUBLIC = path.join(__dirname, 'public');
if (fs.existsSync(LOCAL_PUBLIC)) {
  app.use(express.static(LOCAL_PUBLIC));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(LOCAL_PUBLIC, 'index.html'));
  });
} else if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

// Configure multer for photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max per photo
});

// Photo upload API
app.post('/api/upload', upload.single('photo'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No photo provided' });
  }
  const photoUrl = `/uploads/${req.file.filename}`;
  res.json({ photoUrl });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    usersCount: Object.keys(state.users).length,
    activeSockets: io.engine.clientsCount
  });
});

function getRoomKey(tag1, tag2) {
  return [tag1.toLowerCase(), tag2.toLowerCase()].sort().join('__');
}

// Socket.io handlers
io.on('connection', (socket) => {
  let currentTag = null;

  // 1. User login / register with tag
  socket.on('auth', ({ tag, name, avatar }, callback) => {
    if (!tag) {
      return callback?.({ success: false, error: 'Тег обязателен' });
    }

    const cleanTag = tag.trim().toLowerCase().replace(/^@+/, '');
    if (cleanTag.length < 2) {
      return callback?.({ success: false, error: 'Тег должен содержать минимум 2 символа' });
    }

    currentTag = cleanTag;

    if (!state.users[cleanTag]) {
      state.users[cleanTag] = {
        tag: cleanTag,
        name: name?.trim() || cleanTag,
        avatar: avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${cleanTag}`,
        socketId: socket.id,
        online: true,
        friends: []
      };
    } else {
      state.users[cleanTag].socketId = socket.id;
      state.users[cleanTag].online = true;
      if (name?.trim()) state.users[cleanTag].name = name.trim();
      if (avatar) state.users[cleanTag].avatar = avatar;
    }

    saveData();

    // Broadcast online status to all friends
    notifyFriendsStatus(cleanTag, true);

    callback?.({
      success: true,
      user: state.users[cleanTag]
    });
  });

  // 2. Add friend by tag
  socket.on('add_friend', ({ targetTag }, callback) => {
    if (!currentTag) return callback?.({ success: false, error: 'Не авторизован' });

    const cleanTarget = targetTag.trim().toLowerCase().replace(/^@+/, '');

    if (cleanTarget === currentTag) {
      return callback?.({ success: false, error: 'Нельзя добавить самого себя в друзья' });
    }

    const targetUser = state.users[cleanTarget];
    if (!targetUser) {
      return callback?.({ success: false, error: `Пользователь @${cleanTarget} не найден` });
    }

    const currentUser = state.users[currentTag];
    if (!currentUser.friends.includes(cleanTarget)) {
      currentUser.friends.push(cleanTarget);
    }
    if (!targetUser.friends.includes(currentTag)) {
      targetUser.friends.push(currentTag);
    }

    saveData();

    // Notify target user if online
    if (targetUser.socketId) {
      io.to(targetUser.socketId).emit('friend_updated', {
        friend: {
          tag: currentUser.tag,
          name: currentUser.name,
          avatar: currentUser.avatar,
          online: currentUser.online
        }
      });
    }

    callback?.({
      success: true,
      friend: {
        tag: targetUser.tag,
        name: targetUser.name,
        avatar: targetUser.avatar,
        online: targetUser.online
      }
    });
  });

  // 3. Get friends list
  socket.on('get_friends', (callback) => {
    if (!currentTag || !state.users[currentTag]) return callback?.([]);

    const friendsList = state.users[currentTag].friends.map(fTag => {
      const u = state.users[fTag];
      if (!u) return { tag: fTag, name: fTag, online: false };
      return {
        tag: u.tag,
        name: u.name,
        avatar: u.avatar,
        online: !!u.online
      };
    });

    callback?.(friendsList);
  });

  // 4. Get chat history
  socket.on('get_messages', ({ targetTag }, callback) => {
    if (!currentTag) return callback?.([]);
    const roomKey = getRoomKey(currentTag, targetTag);
    callback?.(state.messages[roomKey] || []);
  });

  // 5. Send message (text or photo)
  socket.on('send_message', ({ toTag, text, photoUrl }, callback) => {
    if (!currentTag) return callback?.({ success: false, error: 'Не авторизован' });

    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    const roomKey = getRoomKey(currentTag, cleanTo);

    if (!state.messages[roomKey]) {
      state.messages[roomKey] = [];
    }

    const newMsg = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      sender: currentTag,
      receiver: cleanTo,
      text: text || '',
      photoUrl: photoUrl || null,
      timestamp: Date.now()
    };

    state.messages[roomKey].push(newMsg);
    saveData();

    // Send to recipient if online
    const targetUser = state.users[cleanTo];
    if (targetUser && targetUser.socketId) {
      io.to(targetUser.socketId).emit('new_message', newMsg);
    }

    callback?.({ success: true, message: newMsg });
  });

  // 6. WebRTC Audio / Video Calling Signaling
  socket.on('call_request', ({ toTag, callType, offer }) => {
    if (!currentTag) return;
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    const target = state.users[cleanTo];

    if (!target || !target.online || !target.socketId) {
      socket.emit('call_failed', { reason: 'Пользователь сейчас не в сети' });
      return;
    }

    const caller = state.users[currentTag];
    io.to(target.socketId).emit('incoming_call', {
      callerTag: currentTag,
      callerName: caller ? caller.name : currentTag,
      callerAvatar: caller ? caller.avatar : null,
      callType: callType || 'video',
      offer
    });
  });

  socket.on('call_accept', ({ toTag, answer }) => {
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    const target = state.users[cleanTo];
    if (target && target.socketId) {
      io.to(target.socketId).emit('call_accepted', {
        fromTag: currentTag,
        answer
      });
    }
  });

  socket.on('call_reject', ({ toTag, reason }) => {
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    const target = state.users[cleanTo];
    if (target && target.socketId) {
      io.to(target.socketId).emit('call_rejected', {
        fromTag: currentTag,
        reason: reason || 'Вызов отклонен'
      });
    }
  });

  socket.on('call_end', ({ toTag }) => {
    if (!toTag) return;
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    const target = state.users[cleanTo];
    if (target && target.socketId) {
      io.to(target.socketId).emit('call_ended', {
        fromTag: currentTag
      });
    }
  });

  socket.on('ice_candidate', ({ toTag, candidate }) => {
    const cleanTo = toTag.trim().toLowerCase().replace(/^@+/, '');
    const target = state.users[cleanTo];
    if (target && target.socketId) {
      io.to(target.socketId).emit('ice_candidate', {
        fromTag: currentTag,
        candidate
      });
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    if (currentTag && state.users[currentTag]) {
      state.users[currentTag].online = false;
      state.users[currentTag].socketId = null;
      notifyFriendsStatus(currentTag, false);
      saveData();
    }
  });

  function notifyFriendsStatus(userTag, isOnline) {
    const user = state.users[userTag];
    if (!user || !user.friends) return;

    user.friends.forEach(fTag => {
      const f = state.users[fTag];
      if (f && f.socketId) {
        io.to(f.socketId).emit('friend_status', {
          tag: userTag,
          online: isOnline
        });
      }
    });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`🚀 Friend Messenger Server is running on port ${PORT}`);
  console.log(`📡 Ready for Chats, Photos, and WebRTC Calls!`);
  console.log(`===============================================`);
});
