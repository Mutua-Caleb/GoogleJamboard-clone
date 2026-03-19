/**
 * Collaboration manager - handles Socket.IO connection and room management.
 */
import { io } from 'socket.io-client';

export class CollaborationManager {
  constructor() {
    this.socket = null;
    this.roomId = null;
    this.userId = null;
    this.userName = null;
    this.userColor = null;
    this.listeners = new Map();
  }

  connect() {
    const url = window.location.hostname === 'localhost'
      ? 'http://localhost:3001'
      : window.location.origin;

    this.socket = io(url, {
      transports: ['websocket', 'polling'],
    });

    this.socket.on('connect', () => {
      this._emit('connected');
    });

    this.socket.on('disconnect', () => {
      this._emit('disconnected');
    });

    // Relay all real-time events
    const events = [
      'stroke-start', 'stroke-move', 'stroke-end', 'erase',
      'cursor-move', 'viewport-change', 'add-media', 'remove-media', 'move-media',
      'user-joined', 'user-left',
      'load-pdf', 'close-pdf', 'pdf-page-change', 'clear-board', 'sync-strokes',
      'jam-renamed', 'add-text', 'remove-text', 'update-text',
    ];
    events.forEach((evt) => {
      this.socket.on(evt, (data) => this._emit(evt, data));
    });
  }

  createRoom(name, jamId) {
    return new Promise((resolve) => {
      this.socket.emit('create-room', { name, jamId }, (response) => {
        if (response.success) {
          this.roomId = response.roomId;
          this.userId = response.userId;
          this.userName = name;
          this.userColor = response.color;
        }
        resolve(response);
      });
    });
  }

  joinRoom(roomId, name) {
    return new Promise((resolve) => {
      this.socket.emit('join-room', { roomId, name }, (response) => {
        if (response.success) {
          this.roomId = response.roomId;
          this.userId = response.userId;
          this.userName = name;
          this.userColor = response.color;
        }
        resolve(response);
      });
    });
  }

  sendStrokeStart(data) {
    this.socket?.emit('stroke-start', data);
  }

  sendStrokeMove(data) {
    this.socket?.emit('stroke-move', data);
  }

  sendStrokeEnd(data) {
    this.socket?.emit('stroke-end', data);
  }

  sendErase(data) {
    this.socket?.emit('erase', data);
  }

  sendCursorMove(data) {
    this.socket?.emit('cursor-move', data);
  }

  sendViewportChange(data) {
    this.socket?.emit('viewport-change', data);
  }

  sendAddMedia(data) {
    this.socket?.emit('add-media', data);
  }

  sendRemoveMedia(data) {
    this.socket?.emit('remove-media', data);
  }

  sendMoveMedia(data) {
    this.socket?.emit('move-media', data);
  }

  sendLoadPDF(data) {
    this.socket?.emit('load-pdf', data);
  }

  sendClosePDF() {
    this.socket?.emit('close-pdf');
  }

  sendPageChange(page) {
    this.socket?.emit('pdf-page-change', { page });
  }

  sendClearBoard(data) {
    this.socket?.emit('clear-board', data);
  }

  sendAddText(data) {
    this.socket?.emit('add-text', data);
  }

  sendRemoveText(data) {
    this.socket?.emit('remove-text', data);
  }

  sendUpdateText(data) {
    this.socket?.emit('update-text', data);
  }

  sendUndo(data) {
    this.socket?.emit('undo', data);
  }

  saveThumbnail(thumbnail) {
    this.socket?.emit('save-thumbnail', { thumbnail });
  }

  renameJam(title) {
    this.socket?.emit('rename-jam', { title });
  }

  // Simple event emitter
  on(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(callback);
  }

  off(event, callback) {
    const cbs = this.listeners.get(event);
    if (cbs) {
      this.listeners.set(event, cbs.filter((cb) => cb !== callback));
    }
  }

  _emit(event, data) {
    const cbs = this.listeners.get(event);
    if (cbs) cbs.forEach((cb) => cb(data));
  }

  disconnect() {
    this.socket?.disconnect();
  }
}
