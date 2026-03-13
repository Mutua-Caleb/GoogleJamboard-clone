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
const server = createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50e6, // 50MB for PDF uploads
});

const MAX_USERS_PER_ROOM = 4;

// Storage for rooms
const rooms = new Map();

// Multer setup for PDF uploads
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

// PDF upload endpoint
app.post('/api/upload-pdf', upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({
    filename: req.file.filename,
    originalname: req.file.originalname,
    url: `/uploads/${req.file.filename}`,
  });
});

// Room helpers
function createRoom(hostId, hostName) {
  const roomId = uuidv4().slice(0, 8);
  const room = {
    id: roomId,
    host: hostId,
    users: new Map(),
    strokes: [],      // All drawing strokes
    pdfUrl: null,      // Current PDF being annotated
    pdfPage: 1,        // Current page
    pages: new Map(),  // page -> strokes for PDF annotation
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
  };
}

const USER_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4'];

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', ({ name }, callback) => {
    const room = createRoom(socket.id, name);
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

    // Send existing state to new user
    callback({
      success: true,
      roomId,
      userId: socket.id,
      color: userColor,
      room: getRoomInfo(room),
      strokes: room.strokes,
      pdfStrokes: room.pdfUrl ? (room.pages.get(room.pdfPage) || []) : [],
    });

    // Notify others
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
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    room.users.delete(socket.id);
    if (room.users.size === 0) {
      rooms.delete(currentRoom);
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
