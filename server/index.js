import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const server = createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50e6, // 50MB for PDF uploads
});

const MAX_USERS_PER_ROOM = 4;

// Storage for rooms
const rooms = new Map();

// ============================
// Jam persistence (JSON files)
// ============================
const JAMS_DIR = path.join(__dirname, '..', 'data', 'jams');
if (!fs.existsSync(JAMS_DIR)) fs.mkdirSync(JAMS_DIR, { recursive: true });

function saveJam(jam) {
  const filePath = path.join(JAMS_DIR, `${jam.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(jam, null, 2));
}

function loadJam(id) {
  if (!id) return null;
  const filePath = path.join(JAMS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function findJamByRoomId(roomId) {
  if (!roomId) return null;
  const target = String(roomId).trim().toLowerCase();
  const files = fs.readdirSync(JAMS_DIR).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(JAMS_DIR, file), 'utf-8'));
      if (
        (data.roomId && data.roomId.toLowerCase() === target) ||
        (data.id && data.id.toLowerCase() === target) ||
        (data.id && data.id.slice(0, 8).toLowerCase() === target)
      ) {
        return data;
      }
    } catch { /* skip corrupt files */ }
  }
  return null;
}

function listJams() {
  const files = fs.readdirSync(JAMS_DIR).filter((f) => f.endsWith('.json'));
  const jams = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(JAMS_DIR, file), 'utf-8'));
      jams.push({
        id: data.id,
        roomId: data.roomId || data.id.slice(0, 8),
        title: data.title,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        strokeCount: data.strokes?.length || 0,
        textCount: data.textItems?.length || 0,
        mediaCount: data.media?.length || 0,
        pdfUrl: data.pdfUrl || null,
        thumbnail: data.thumbnail || null,
      });
    } catch { /* skip corrupt files */ }
  }
  // Sort newest first
  jams.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return jams;
}

function deleteJam(id) {
  const filePath = path.join(JAMS_DIR, `${id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// Serialize a room into a jam object for saving
function roomToJam(room, title) {
  const pagesObj = {};
  room.pages.forEach((strokes, page) => {
    pagesObj[page] = strokes;
  });
  return {
    id: room.jamId || uuidv4(),
    roomId: room.id,
    title: title || room.title || `Jam ${new Date().toLocaleDateString()}`,
    createdAt: room.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    strokes: room.strokes,
    textItems: room.textItems || [],
    media: room.media || [],
    viewport: room.viewport || { x: 0, y: 0 },
    pdfUrl: room.pdfUrl,
    pdfPage: room.pdfPage,
    pages: pagesObj,
    thumbnail: room.thumbnail || null,
  };
}

// Disconnect grace period: keep user slot for 3 minutes
const DISCONNECT_GRACE_MS = 3 * 60 * 1000;
const disconnectTimers = new Map(); // socketId -> { timer, roomId, userInfo }

// Auto-save debounce per room
const autoSaveTimers = new Map();

function scheduleAutoSave(roomId) {
  if (autoSaveTimers.has(roomId)) clearTimeout(autoSaveTimers.get(roomId));
  autoSaveTimers.set(roomId, setTimeout(() => {
    const room = rooms.get(roomId);
    if (room && room.jamId) {
      const jam = roomToJam(room);
      saveJam(jam);
    }
    autoSaveTimers.delete(roomId);
  }, 500)); // Save 500ms after last change
}

// ============================
// Multer setup for PDF uploads
// ============================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${uuidv4()}-${file.originalname}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are allowed'));
  },
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
});

const imageUpload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// Serve static files in production
const distPath = path.join(__dirname, '..', 'dist');
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
}
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ============================
// REST API
// ============================

// PDF upload
app.post('/api/upload-pdf', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    url: `/uploads/${req.file.filename}`,
  });
});

// Image upload (also includes base64 dataUrl so images persist in jam JSON)
app.post('/api/upload-image', imageUpload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let dataUrl = null;
  try {
    if (req.file.size <= 15 * 1024 * 1024) {
      const mime = req.file.mimetype || 'image/png';
      const b64 = fs.readFileSync(req.file.path).toString('base64');
      dataUrl = `data:${mime};base64,${b64}`;
    }
  } catch { /* ignore */ }
  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    url: `/uploads/${req.file.filename}`,
    dataUrl,
  });
});

// List all saved jams
app.get('/api/jams', (req, res) => {
  res.json(listJams());
});

// Get a single jam
app.get('/api/jams/:id', (req, res) => {
  const jam = loadJam(req.params.id);
  if (!jam) return res.status(404).json({ error: 'Jam not found' });
  res.json(jam);
});

// Delete a jam
app.delete('/api/jams/:id', (req, res) => {
  deleteJam(req.params.id);
  res.json({ success: true });
});

// Rename a jam
app.patch('/api/jams/:id', (req, res) => {
  const jam = loadJam(req.params.id);
  if (!jam) return res.status(404).json({ error: 'Jam not found' });
  if (req.body.title) jam.title = req.body.title;
  jam.updatedAt = new Date().toISOString();
  saveJam(jam);
  res.json(jam);
});

// Save thumbnail for a jam (base64 data URL)
app.post('/api/jams/:id/thumbnail', (req, res) => {
  const jam = loadJam(req.params.id);
  if (!jam) return res.status(404).json({ error: 'Jam not found' });
  jam.thumbnail = req.body.thumbnail;
  jam.updatedAt = new Date().toISOString();
  saveJam(jam);
  res.json({ success: true });
});

// ============================
// Room helpers
// ============================
function createRoom(hostId, hostName) {
  const roomId = uuidv4().slice(0, 8);
  const jamId = uuidv4();
  const now = new Date().toISOString();
  const room = {
    id: roomId,
    host: hostId,
    hostClientId: null,
    users: new Map(),
    strokes: [],
    textItems: [],
    media: [],  // images & youtube embeds
    viewport: { x: 0, y: 0 },
    pdfUrl: null,
    pdfPage: 1,
    pages: new Map(),
    // Persistence fields
    jamId,
    title: `Jam ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    createdAt: now,
    thumbnail: null,
  };
  rooms.set(roomId, room);

  // Create initial saved jam
  saveJam(roomToJam(room));

  return room;
}

function createRoomFromJam(hostId, jam) {
  const roomId = jam.roomId || jam.id.slice(0, 8);
  if (rooms.has(roomId)) {
    return rooms.get(roomId);
  }
  const pagesMap = new Map();
  if (jam.pages) {
    for (const [page, strokes] of Object.entries(jam.pages)) {
      pagesMap.set(parseInt(page), strokes);
    }
  }
  const room = {
    id: roomId,
    host: hostId,
    hostClientId: null,
    users: new Map(),
    strokes: jam.strokes || [],
    textItems: jam.textItems || [],
    media: jam.media || [],
    viewport: jam.viewport || { x: 0, y: 0 },
    pdfUrl: jam.pdfUrl || null,
    pdfPage: jam.pdfPage || 1,
    pages: pagesMap,
    // Persistence
    jamId: jam.id,
    title: jam.title,
    createdAt: jam.createdAt,
    thumbnail: jam.thumbnail || null,
  };
  rooms.set(roomId, room);
  if (!jam.roomId) {
    jam.roomId = roomId;
    saveJam(jam);
  }
  return room;
}

function getOrRestoreRoom(roomIdOrJamId, hostId) {
  if (!roomIdOrJamId) return null;
  const target = String(roomIdOrJamId).trim();
  if (rooms.has(target)) return rooms.get(target);

  for (const room of rooms.values()) {
    if (room.jamId === target) return room;
  }

  const jam = loadJam(target) || findJamByRoomId(target);
  if (jam) {
    return createRoomFromJam(hostId, jam);
  }
  return null;
}

function getRoomInfo(room) {
  const users = [];
  room.users.forEach((u, id) => {
    users.push({ id, name: u.name, color: u.color, clientId: u.clientId });
  });
  return {
    id: room.id,
    host: room.host,
    users,
    pdfUrl: room.pdfUrl,
    pdfPage: room.pdfPage,
    jamId: room.jamId,
    title: room.title,
  };
}

const USER_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4'];

function getPendingDisconnects(roomId) {
  return [...disconnectTimers.entries()].filter(([, info]) => info.roomId === roomId);
}

function findPendingUser(roomId, clientId, name) {
  return getPendingDisconnects(roomId).find(([, info]) => {
    if (clientId && info.userInfo?.clientId === clientId) return true;
    return !clientId && name && info.userInfo?.name === name;
  });
}

function clearPendingDisconnect(oldSocketId, room) {
  const info = disconnectTimers.get(oldSocketId);
  if (!info) return null;
  clearTimeout(info.timer);
  disconnectTimers.delete(oldSocketId);
  room.users.delete(oldSocketId);
  return info.userInfo;
}

function getReservedUserCount(roomId) {
  const clientIds = new Set();
  let anonymousCount = 0;
  for (const [, info] of getPendingDisconnects(roomId)) {
    if (info.userInfo?.clientId) clientIds.add(info.userInfo.clientId);
    else anonymousCount++;
  }
  return clientIds.size + anonymousCount;
}

function getNextUserColor(room, preferredColor = null) {
  if (preferredColor) return preferredColor;
  const used = new Set([...room.users.values()].map((u) => u.color));
  return USER_COLORS.find((color) => !used.has(color)) || USER_COLORS[room.users.size % USER_COLORS.length];
}

function getRoomState(room) {
  return {
    room: getRoomInfo(room),
    strokes: room.strokes,
    textItems: room.textItems || [],
    media: room.media || [],
    viewport: room.viewport || { x: 0, y: 0 },
    pdfStrokes: room.pdfUrl ? (room.pages.get(room.pdfPage) || []) : [],
  };
}

// ============================
// Socket.IO
// ============================
io.on('connection', (socket) => {
  let currentRoom = null;
  let currentClientId = null;

  socket.on('create-room', ({ name, jamId, clientId }, callback) => {
    let room;
    // If opening an existing jam, load or join its active room
    if (jamId) {
      room = getOrRestoreRoom(jamId, socket.id);
      if (!room) {
        room = createRoom(socket.id, name);
      }
    } else {
      room = createRoom(socket.id, name);
    }

    const pendingUser = findPendingUser(room.id, clientId, name);
    const restoredUser = pendingUser ? clearPendingDisconnect(pendingUser[0], room) : null;
    for (const [existingSocketId, user] of room.users.entries()) {
      if (existingSocketId !== socket.id && clientId && user.clientId === clientId) {
        room.users.delete(existingSocketId);
      }
    }

    const userColor = getNextUserColor(room, restoredUser?.color);
    if (!room.host || !room.users.has(room.host)) {
      room.host = socket.id;
      room.hostClientId = clientId;
    }
    room.users.set(socket.id, { name, color: userColor, clientId });
    socket.join(room.id);
    currentRoom = room.id;
    currentClientId = clientId;

    callback({
      success: true,
      roomId: room.id,
      userId: socket.id,
      color: userColor,
      ...getRoomState(room),
    });

    socket.to(room.id).emit('user-joined', {
      id: socket.id,
      name,
      color: userColor,
      room: getRoomInfo(room),
    });
  });

  socket.on('join-room', ({ roomId, name, clientId }, callback) => {
    const room = getOrRestoreRoom(roomId, socket.id);
    if (!room) return callback({ success: false, error: 'Room not found' });

    const pendingUser = findPendingUser(room.id, clientId, name);
    const restoredUser = pendingUser ? clearPendingDisconnect(pendingUser[0], room) : null;
    for (const [existingSocketId, user] of room.users.entries()) {
      if (existingSocketId !== socket.id && clientId && user.clientId === clientId) {
        room.users.delete(existingSocketId);
      }
    }

    if (!restoredUser && room.users.size + getReservedUserCount(room.id) >= MAX_USERS_PER_ROOM)
      return callback({ success: false, error: 'Room is full (max 4 users)' });

    const userColor = getNextUserColor(room, restoredUser?.color);
    if (!room.host || !room.users.has(room.host)) {
      room.host = socket.id;
      room.hostClientId = clientId;
    }
    room.users.set(socket.id, { name, color: userColor, clientId });
    socket.join(room.id);
    currentRoom = room.id;
    currentClientId = clientId;

    callback({
      success: true,
      roomId: room.id,
      userId: socket.id,
      color: userColor,
      ...getRoomState(room),
    });

    socket.to(room.id).emit('user-joined', {
      id: socket.id,
      name,
      color: userColor,
      room: getRoomInfo(room),
    });
  });

  // Real-time drawing events
  socket.on('stroke-start', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('stroke-start', { ...data, userId: socket.id, clientId: currentClientId });
  });

  socket.on('stroke-move', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('stroke-move', { ...data, userId: socket.id, clientId: currentClientId });
  });

  socket.on('stroke-end', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const strokeData = { ...data, userId: socket.id, clientId: currentClientId };

    if (room.pdfUrl && data.layer === 'pdf') {
      const page = room.pdfPage;
      if (!room.pages.has(page)) room.pages.set(page, []);
      room.pages.get(page).push(strokeData);
    } else {
      room.strokes.push(strokeData);
    }

    socket.to(currentRoom).emit('stroke-end', strokeData);
    scheduleAutoSave(currentRoom);
  });

  // Eraser
  socket.on('erase', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (room.pdfUrl && data.layer === 'pdf') {
      const page = room.pdfPage;
      const strokes = room.pages.get(page) || [];
      room.pages.set(
        page,
        strokes.filter((s) => !data.strokeIds.includes(s.id))
      );
    } else {
      room.strokes = room.strokes.filter((s) => !data.strokeIds.includes(s.id));
    }

    socket.to(currentRoom).emit('erase', data);
    scheduleAutoSave(currentRoom);
  });

  // Media (images & YouTube)
  socket.on('add-media', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.media.push(data);
    socket.to(currentRoom).emit('add-media', data);
    scheduleAutoSave(currentRoom);
  });

  socket.on('remove-media', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.media = room.media.filter((m) => m.id !== data.id);
    socket.to(currentRoom).emit('remove-media', data);
    scheduleAutoSave(currentRoom);
  });

  socket.on('move-media', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const item = room.media.find((m) => m.id === data.id);
    if (item) {
      item.x = data.x;
      item.y = data.y;
      item.width = data.width;
      item.height = data.height;
    }
    socket.to(currentRoom).emit('move-media', data);
    scheduleAutoSave(currentRoom);
  });

  // Text items
  socket.on('add-text', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const textData = { ...data, userId: socket.id, clientId: currentClientId, createdAt: Date.now() };
    room.textItems.push(textData);
    socket.to(currentRoom).emit('add-text', textData);
    scheduleAutoSave(currentRoom);
  });

  socket.on('remove-text', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.textItems = room.textItems.filter((t) => t.id !== data.id);
    socket.to(currentRoom).emit('remove-text', data);
    scheduleAutoSave(currentRoom);
  });

  socket.on('update-text', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const item = room.textItems.find((t) => t.id === data.id);
    if (item) Object.assign(item, data);
    socket.to(currentRoom).emit('update-text', data);
    scheduleAutoSave(currentRoom);
  });

  // Cursor tracking
  socket.on('cursor-move', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('cursor-move', { ...data, userId: socket.id });
  });

  // Viewport tracking (collaborative scroll/pan sync)
  socket.on('viewport-change', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room && typeof data?.x === 'number' && typeof data?.y === 'number') {
      room.viewport = { x: data.x, y: data.y };
      scheduleAutoSave(currentRoom);
    }
    socket.to(currentRoom).emit('viewport-change', { ...data, userId: socket.id });
  });

  // PDF events
  socket.on('load-pdf', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.pdfUrl = data.url;
    room.pdfPage = 1;
    socket.to(currentRoom).emit('load-pdf', data);
    scheduleAutoSave(currentRoom);
  });

  socket.on('close-pdf', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.pdfUrl = null;
    room.pdfPage = 1;
    socket.to(currentRoom).emit('close-pdf');
    scheduleAutoSave(currentRoom);
  });

  socket.on('pdf-page-change', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.pdfPage = data.page;
    const pageStrokes = room.pages.get(data.page) || [];
    io.to(currentRoom).emit('pdf-page-change', { page: data.page, strokes: pageStrokes });
  });

  // Clear board
  socket.on('clear-board', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (data?.layer === 'pdf') {
      room.pages.set(room.pdfPage, []);
    } else {
      room.strokes = [];
      room.textItems = [];
    }
    io.to(currentRoom).emit('clear-board', data);
    scheduleAutoSave(currentRoom);
  });

  // Undo
  socket.on('undo', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const isOwner = (item) => item.userId === socket.id || (currentClientId && item.clientId === currentClientId);

    if (data?.layer === 'pdf') {
      const page = room.pdfPage;
      const strokes = room.pages.get(page) || [];
      const idx = strokes.findLastIndex(isOwner);
      if (idx !== -1) strokes.splice(idx, 1);
    } else {
      const strokeIdx = room.strokes.findLastIndex(isOwner);
      const textIdx = (room.textItems || []).findLastIndex(isOwner);
      const lastStrokeTime = strokeIdx !== -1 ? (room.strokes[strokeIdx].createdAt || parseInt(room.strokes[strokeIdx].id) || 0) : -1;
      const lastTextTime = textIdx !== -1 ? (room.textItems[textIdx].createdAt || 0) : -1;

      if (textIdx !== -1 && lastTextTime >= lastStrokeTime) {
        room.textItems.splice(textIdx, 1);
      } else if (strokeIdx !== -1) {
        room.strokes.splice(strokeIdx, 1);
      }
    }
    io.to(currentRoom).emit('sync-strokes', {
      strokes: room.strokes,
      textItems: room.textItems || [],
      pdfStrokes: room.pdfUrl ? (room.pages.get(room.pdfPage) || []) : [],
    });
    scheduleAutoSave(currentRoom);
  });

  // Save thumbnail from client
  socket.on('save-thumbnail', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || !room.jamId) return;
    room.thumbnail = data.thumbnail;
    const jam = roomToJam(room);
    saveJam(jam);
  });

  // Rename jam
  socket.on('rename-jam', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.title = data.title;
    scheduleAutoSave(currentRoom);
    io.to(currentRoom).emit('jam-renamed', { title: data.title });
  });

  // Rejoin after reconnect or returning later (same room, same user)
  socket.on('rejoin-room', ({ roomId, jamId, name, clientId }, callback) => {
    const room = getOrRestoreRoom(roomId || jamId, socket.id);
    if (!room) return callback({ success: false, error: 'Room not found' });

    const pendingUser = findPendingUser(room.id, clientId, name);
    const restoredUser = pendingUser ? clearPendingDisconnect(pendingUser[0], room) : null;

    for (const [sockId, u] of room.users.entries()) {
      if (clientId && u.clientId === clientId && sockId !== socket.id) {
        room.users.delete(sockId);
      }
    }

    if (!restoredUser && room.users.size + getReservedUserCount(room.id) >= MAX_USERS_PER_ROOM) {
      return callback({ success: false, error: 'Room is full (max 4 users)' });
    }

    const userColor = getNextUserColor(room, restoredUser?.color);
    if ((restoredUser && room.host === pendingUser[0]) || !room.users.has(room.host)) {
      room.host = socket.id;
    }
    if (room.hostClientId && room.hostClientId === clientId) room.host = socket.id;
    room.users.set(socket.id, { name, color: userColor, clientId });
    socket.join(room.id);
    currentRoom = room.id;
    currentClientId = clientId;

    callback({
      success: true,
      roomId: room.id,
      userId: socket.id,
      color: userColor,
      ...getRoomState(room),
    });

    socket.to(room.id).emit('user-joined', {
      id: socket.id,
      name,
      color: userColor,
      room: getRoomInfo(room),
    });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const userInfo = room.users.get(socket.id);
    const roomId = currentRoom;

    // Immediately persist the jam on any user disconnect so nothing is ever lost
    if (room.jamId) {
      saveJam(roomToJam(room));
    }

    // Don't remove immediately - give a grace period for reconnection
    room.users.delete(socket.id);

    if (room.users.size === 0) {
      // Last user disconnected - start grace period before cleanup
      const timer = setTimeout(() => {
        disconnectTimers.delete(socket.id);
        const r = rooms.get(roomId);
        if (r && r.users.size === 0) {
          // Still empty after grace period - save and cleanup
          if (r.jamId) {
            const jam = roomToJam(r);
            saveJam(jam);
          }
          rooms.delete(roomId);
          if (autoSaveTimers.has(roomId)) {
            clearTimeout(autoSaveTimers.get(roomId));
            autoSaveTimers.delete(roomId);
          }
        }
      }, DISCONNECT_GRACE_MS);

      disconnectTimers.set(socket.id, { timer, roomId, userInfo: userInfo || { name: 'Unknown' } });
    } else {
      // Other users still in room - notify them but keep room alive
      io.to(roomId).emit('user-left', {
        id: socket.id,
        room: getRoomInfo(room),
      });

      // Still set a grace timer so the user can rejoin and the room data stays fresh
      if (userInfo) {
        const timer = setTimeout(() => {
          disconnectTimers.delete(socket.id);
        }, DISCONNECT_GRACE_MS);
        disconnectTimers.set(socket.id, { timer, roomId, userInfo });
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`CollabBoard server running on port ${PORT}`);
});
