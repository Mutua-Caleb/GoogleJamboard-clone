/**
 * Main application - wires up drawing engine, collaboration, and PDF viewer.
 */
import { DrawingEngine } from './drawing-engine.js';
import { CollaborationManager } from './collaboration.js';
import { PDFViewer } from './pdf-viewer.js';

class CollabBoardApp {
  constructor() {
    this.collab = new CollaborationManager();
    this.engine = null;
    this.pdfViewer = null;
    this.inRoom = false;
    this.pdfMode = false;

    this._initUI();
    this._setupCollaboration();
  }

  _initUI() {
    // Lobby
    this.lobbyEl = document.getElementById('lobby');
    this.boardEl = document.getElementById('board');
    this.nameInput = document.getElementById('name-input');
    this.roomIdInput = document.getElementById('room-id-input');

    document.getElementById('btn-create').addEventListener('click', () => this._createRoom());
    document.getElementById('btn-join').addEventListener('click', () => this._joinRoom());

    // Allow enter key in inputs
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._createRoom();
    });
    this.roomIdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._joinRoom();
    });

    // Tools
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => this._selectTool(btn.dataset.tool));
    });

    // Colors
    document.querySelectorAll('.color-swatch').forEach((swatch) => {
      swatch.addEventListener('click', () => this._selectColor(swatch.dataset.color));
    });

    // Size slider
    const sizeSlider = document.getElementById('size-slider');
    const sizeValue = document.getElementById('size-value');
    sizeSlider.addEventListener('input', () => {
      this.engine?.setSize(parseInt(sizeSlider.value));
      sizeValue.textContent = sizeSlider.value;
    });

    // Actions
    document.getElementById('btn-clear').addEventListener('click', () => this._clearBoard());
    document.getElementById('btn-undo').addEventListener('click', () => this._undo());
    document.getElementById('btn-reset-view').addEventListener('click', () => this.engine?.resetView());

    // PDF controls
    document.getElementById('btn-upload-pdf').addEventListener('click', () => {
      document.getElementById('pdf-file-input').click();
    });
    document.getElementById('pdf-file-input').addEventListener('change', (e) => this._uploadPDF(e));
    document.getElementById('btn-pdf-prev').addEventListener('click', () => this.pdfViewer?.prevPage());
    document.getElementById('btn-pdf-next').addEventListener('click', () => this.pdfViewer?.nextPage());
    document.getElementById('btn-close-pdf').addEventListener('click', () => this._closePDF());

    // Copy room code
    document.getElementById('btn-copy-room').addEventListener('click', () => this._copyRoomCode());

    // Leave room
    document.getElementById('btn-leave').addEventListener('click', () => this._leaveRoom());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this._handleKeyboard(e));
  }

  _setupCollaboration() {
    this.collab.connect();

    this.collab.on('connected', () => {
      document.getElementById('connection-status').textContent = 'Connected';
      document.getElementById('connection-status').className = 'status-dot connected';
    });

    this.collab.on('disconnected', () => {
      document.getElementById('connection-status').textContent = 'Disconnected';
      document.getElementById('connection-status').className = 'status-dot disconnected';
    });

    // Remote drawing
    this.collab.on('stroke-start', (data) => {
      this.engine?.handleRemoteStrokeStart(data);
    });
    this.collab.on('stroke-move', (data) => {
      this.engine?.handleRemoteStrokeMove(data);
    });
    this.collab.on('stroke-end', (data) => {
      this.engine?.handleRemoteStrokeEnd(data);
    });
    this.collab.on('erase', (data) => {
      this.engine?.removeStrokes(data.strokeIds);
    });
    this.collab.on('cursor-move', (data) => {
      const room = this._currentRoomInfo;
      if (room) {
        const user = room.users.find((u) => u.id === data.userId);
        if (user) {
          this.engine?.updateRemoteCursor(data.userId, {
            x: data.x,
            y: data.y,
            name: user.name,
            color: user.color,
          });
        }
      }
    });

    this.collab.on('user-joined', (data) => {
      this._currentRoomInfo = data.room;
      this._updateUserList();
      this._showToast(`${data.name} joined the board`);
    });

    this.collab.on('user-left', (data) => {
      this._currentRoomInfo = data.room;
      this.engine?.removeRemoteCursor(data.id);
      this._updateUserList();
      this._showToast('A user left the board');
    });

    this.collab.on('load-pdf', (data) => {
      this._loadPDFFromUrl(data.url);
    });

    this.collab.on('pdf-page-change', (data) => {
      if (this.pdfViewer) {
        this.pdfViewer.goToPage(data.page);
        if (data.strokes) {
          this.engine?.setStrokes(data.strokes);
        }
      }
    });

    this.collab.on('clear-board', (data) => {
      if (data?.layer === 'pdf') {
        // Only clear annotation strokes
        this.engine?.clearStrokes();
      } else {
        this.engine?.clearStrokes();
      }
    });

    this.collab.on('sync-strokes', (data) => {
      if (this.pdfMode) {
        this.engine?.setStrokes(data.pdfStrokes || []);
      } else {
        this.engine?.setStrokes(data.strokes || []);
      }
    });
  }

  async _createRoom() {
    const name = this.nameInput.value.trim();
    if (!name) {
      this.nameInput.focus();
      this._shakeElement(this.nameInput);
      return;
    }

    const response = await this.collab.createRoom(name);
    if (response.success) {
      this._currentRoomInfo = response.room;
      this._enterBoard();
    }
  }

  async _joinRoom() {
    const name = this.nameInput.value.trim();
    const roomId = this.roomIdInput.value.trim();
    if (!name) {
      this.nameInput.focus();
      this._shakeElement(this.nameInput);
      return;
    }
    if (!roomId) {
      this.roomIdInput.focus();
      this._shakeElement(this.roomIdInput);
      return;
    }

    const response = await this.collab.joinRoom(roomId, name);
    if (response.success) {
      this._currentRoomInfo = response.room;
      this._enterBoard();

      // Load existing strokes
      if (response.strokes?.length) {
        this.engine.setStrokes(response.strokes);
      }
      // Load existing PDF
      if (response.room.pdfUrl) {
        await this._loadPDFFromUrl(response.room.pdfUrl);
        if (response.pdfStrokes?.length) {
          this.engine.setStrokes(response.pdfStrokes);
        }
      }
    } else {
      this._showToast(response.error || 'Failed to join room', 'error');
    }
  }

  _enterBoard() {
    this.lobbyEl.classList.add('hidden');
    this.boardEl.classList.remove('hidden');
    this.inRoom = true;

    document.getElementById('room-code').textContent = this.collab.roomId;
    this._updateUserList();

    // Init drawing engine
    const canvas = document.getElementById('draw-canvas');
    this.engine = new DrawingEngine(canvas, {
      onStrokeStart: (data) => this.collab.sendStrokeStart(data),
      onStrokeMove: (data) => this.collab.sendStrokeMove(data),
      onStrokeEnd: (data) => this.collab.sendStrokeEnd(data),
      onErase: (data) => this.collab.sendErase(data),
      onCursorMove: (data) => this.collab.sendCursorMove(data),
    });

    // Set default tool highlight
    this._selectTool('pen');
    this._selectColor('#FFFFFF');
  }

  _selectTool(tool) {
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    this.engine?.setTool(tool);

    // Update cursor style
    const canvas = document.getElementById('draw-canvas');
    if (tool === 'eraser') {
      canvas.style.cursor = 'crosshair';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  }

  _selectColor(color) {
    document.querySelectorAll('.color-swatch').forEach((swatch) => {
      swatch.classList.toggle('active', swatch.dataset.color === color);
    });
    this.engine?.setColor(color);
  }

  _clearBoard() {
    const layer = this.pdfMode ? 'pdf' : 'whiteboard';
    this.engine?.clearStrokes();
    this.collab.sendClearBoard({ layer });
  }

  _undo() {
    const layer = this.pdfMode ? 'pdf' : 'whiteboard';
    this.collab.sendUndo({ layer });
  }

  async _uploadPDF(e) {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('pdf', file);

    try {
      this._showToast('Uploading PDF...');
      const res = await fetch('/api/upload-pdf', { method: 'POST', body: formData });
      const data = await res.json();

      if (data.url) {
        this.collab.sendLoadPDF({ url: data.url, name: data.originalname });
        await this._loadPDFFromUrl(data.url);
      }
    } catch (err) {
      this._showToast('Failed to upload PDF', 'error');
    }

    e.target.value = '';
  }

  async _loadPDFFromUrl(url) {
    this.pdfMode = true;
    this.engine?.setLayer('pdf');
    this.engine?.clearStrokes();

    document.getElementById('pdf-controls').classList.remove('hidden');
    document.getElementById('canvas-area').classList.add('pdf-active');

    const container = document.getElementById('pdf-container');
    container.classList.remove('hidden');

    if (this.pdfViewer) this.pdfViewer.destroy();

    this.pdfViewer = new PDFViewer(container, {
      onPageChange: (page) => this.collab.sendPageChange(page),
    });

    await this.pdfViewer.loadPDF(url);
    this._showToast('PDF loaded');
  }

  _closePDF() {
    this.pdfMode = false;
    this.engine?.setLayer('whiteboard');
    this.engine?.clearStrokes();

    document.getElementById('pdf-controls').classList.add('hidden');
    document.getElementById('canvas-area').classList.remove('pdf-active');
    document.getElementById('pdf-container').classList.add('hidden');

    if (this.pdfViewer) {
      this.pdfViewer.destroy();
      this.pdfViewer = null;
    }
  }

  _leaveRoom() {
    this.collab.disconnect();
    this.inRoom = false;
    this.pdfMode = false;

    this.lobbyEl.classList.remove('hidden');
    this.boardEl.classList.add('hidden');

    if (this.pdfViewer) {
      this.pdfViewer.destroy();
      this.pdfViewer = null;
    }

    // Reconnect for next room
    this.collab.connect();
  }

  _updateUserList() {
    const list = document.getElementById('user-list');
    if (!this._currentRoomInfo) return;

    list.innerHTML = '';
    this._currentRoomInfo.users.forEach((user) => {
      const el = document.createElement('div');
      el.className = 'user-badge';
      el.innerHTML = `<span class="user-dot" style="background:${user.color}"></span>${user.name}`;
      if (user.id === this._currentRoomInfo.host) {
        el.innerHTML += ' <span class="host-badge">HOST</span>';
      }
      list.appendChild(el);
    });

    document.getElementById('user-count').textContent =
      `${this._currentRoomInfo.users.length}/4`;
  }

  _copyRoomCode() {
    navigator.clipboard?.writeText(this.collab.roomId).then(() => {
      this._showToast('Room code copied!');
    });
  }

  _handleKeyboard(e) {
    if (!this.inRoom) return;

    // Don't capture if typing in input
    if (e.target.tagName === 'INPUT') return;

    if (e.key === 'p' || e.key === '1') this._selectTool('pen');
    else if (e.key === 'l' || e.key === '2') this._selectTool('pencil');
    else if (e.key === 'h' || e.key === '3') this._selectTool('highlighter');
    else if (e.key === 'e' || e.key === '4') this._selectTool('eraser');
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._undo();
    }
    else if (e.key === '[') {
      const slider = document.getElementById('size-slider');
      slider.value = Math.max(1, parseInt(slider.value) - 1);
      slider.dispatchEvent(new Event('input'));
    }
    else if (e.key === ']') {
      const slider = document.getElementById('size-slider');
      slider.value = Math.min(50, parseInt(slider.value) + 1);
      slider.dispatchEvent(new Event('input'));
    }
  }

  _showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  _shakeElement(el) {
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 500);
  }
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
  new CollabBoardApp();
});
