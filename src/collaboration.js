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
      'cursor-move', 'user-joined', 'user-left',
      'load-pdf', 'pdf-page-change', 'clear-board', 'sync-strokes',
    ];
    events.forEach((evt) => {
      this.socket.on(evt, (data) => this._emit(evt, data));
    });
  }

  createRoom(name) {
    return new Promise((resolve) => {
      this.socket.emit('create-room', { name }, (response) => {
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

  sendLoadPDF(data) {
    this.socket?.emit('load-pdf', data);
  }

  sendPageChange(page) {
    this.socket?.emit('pdf-page-change', { page });
  }

  sendClearBoard(data) {
    this.socket?.emit('clear-board', data);
  }

  sendUndo(data) {
    this.socket?.emit('undo', data);
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
