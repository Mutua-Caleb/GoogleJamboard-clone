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
  const filePath = path.join(JAMS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function listJams() {
  const files = fs.readdirSync(JAMS_DIR).filter((f) => f.endsWith('.json'));
  const jams = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(JAMS_DIR, file), 'utf-8'));
      jams.push({
        id: data.id,
        title: data.title,
        createdAt: data.createdAt,
        updatedAt: data.updatedAt,
        strokeCount: data.strokes?.length || 0,
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
    pdfUrl: room.pdfUrl,
    pdfPage: room.pdfPage,
    pages: pagesObj,
    thumbnail: room.thumbnail || null,
  };
}

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
  }, 3000)); // Save 3s after last change
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
    users: new Map(),
    strokes: [],
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
  const roomId = uuidv4().slice(0, 8);
  const pagesMap = new Map();
  if (jam.pages) {
    for (const [page, strokes] of Object.entries(jam.pages)) {
      pagesMap.set(parseInt(page), strokes);
    }
  }
  const room = {
    id: roomId,
    host: hostId,
    users: new Map(),
    strokes: jam.strokes || [],
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
  return room;
}

function getRoomInfo(room) {
  const users = [];
  room.users.forEach((u, id) => {
    users.push({ id, name: u.name, color: u.color });
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

// ============================
// Socket.IO
// ============================
io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', ({ name, jamId }, callback) => {
    let room;
    // If opening an existing jam, load it
    if (jamId) {
      const jam = loadJam(jamId);
      if (jam) {
        room = createRoomFromJam(socket.id, jam);
      } else {
        room = createRoom(socket.id, name);
      }
    } else {
      room = createRoom(socket.id, name);
    }

    const userColor = USER_COLORS[0];
    room.users.set(socket.id, { name, color: userColor });
    socket.join(room.id);
    currentRoom = room.id;

    callback({
      success: true,
      roomId: room.id,
      userId: socket.id,
      color: userColor,
      room: getRoomInfo(room),
      strokes: room.strokes,
      pdfStrokes: room.pdfUrl ? (room.pages.get(room.pdfPage) || []) : [],
    });
  });

  socket.on('join-room', ({ roomId, name }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, error: 'Room not found' });
    if (room.users.size >= MAX_USERS_PER_ROOM)
      return callback({ success: false, error: 'Room is full (max 4 users)' });

    const userColor = USER_COLORS[room.users.size];
    room.users.set(socket.id, { name, color: userColor });
    socket.join(roomId);
    currentRoom = roomId;

    callback({
      success: true,
      roomId,
      userId: socket.id,
      color: userColor,
      room: getRoomInfo(room),
      strokes: room.strokes,
      pdfStrokes: room.pdfUrl ? (room.pages.get(room.pdfPage) || []) : [],
    });

    socket.to(roomId).emit('user-joined', {
      id: socket.id,
      name,
      color: userColor,
      room: getRoomInfo(room),
    });
  });

  // Real-time drawing events
  socket.on('stroke-start', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('stroke-start', { ...data, userId: socket.id });
  });

  socket.on('stroke-move', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('stroke-move', { ...data, userId: socket.id });
  });

  socket.on('stroke-end', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const strokeData = { ...data, userId: socket.id };

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

  // Cursor tracking
  socket.on('cursor-move', (data) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('cursor-move', { ...data, userId: socket.id });
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
    }
    io.to(currentRoom).emit('clear-board', data);
    scheduleAutoSave(currentRoom);
  });

  // Undo
  socket.on('undo', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (data?.layer === 'pdf') {
      const page = room.pdfPage;
      const strokes = room.pages.get(page) || [];
      const idx = strokes.findLastIndex((s) => s.userId === socket.id);
      if (idx !== -1) strokes.splice(idx, 1);
    } else {
      const idx = room.strokes.findLastIndex((s) => s.userId === socket.id);
      if (idx !== -1) room.strokes.splice(idx, 1);
    }
    io.to(currentRoom).emit('sync-strokes', {
      strokes: room.strokes,
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

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.users.delete(socket.id);
    if (room.users.size === 0) {
      // Final save before cleanup
      if (room.jamId) {
        const jam = roomToJam(room);
        saveJam(jam);
      }
      rooms.delete(currentRoom);
      // Clear any pending auto-save
      if (autoSaveTimers.has(currentRoom)) {
        clearTimeout(autoSaveTimers.get(currentRoom));
        autoSaveTimers.delete(currentRoom);
      }
    } else {
      io.to(currentRoom).emit('user-left', {
        id: socket.id,
        room: getRoomInfo(room),
      });
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`CollabBoard server running on port ${PORT}`);
});
