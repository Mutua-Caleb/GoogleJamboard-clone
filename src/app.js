/**
 * Main application - wires up drawing engine, collaboration, PDF viewer,
 * and the "My Jams" notebook view for browsing saved sessions.
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
    this.currentJamId = null;

    this._initUI();
    this._setupCollaboration();
  }

  _initUI() {
    // Views
    this.lobbyEl = document.getElementById('lobby');
    this.boardEl = document.getElementById('board');
    this.notebookEl = document.getElementById('notebook');
    this.nameInput = document.getElementById('name-input');
    this.roomIdInput = document.getElementById('room-id-input');

    // Lobby buttons
    document.getElementById('btn-create').addEventListener('click', () => this._createRoom());
    document.getElementById('btn-join').addEventListener('click', () => this._joinRoom());
    document.getElementById('btn-my-jams').addEventListener('click', () => this._showNotebook());

    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._createRoom();
    });
    this.roomIdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._joinRoom();
    });

    // Notebook
    document.getElementById('btn-notebook-back').addEventListener('click', () => this._hideNotebook());

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
    document.getElementById('btn-save-now').addEventListener('click', () => this._saveNow());

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

    // Jam title editing
    const jamTitle = document.getElementById('jam-title');
    jamTitle.addEventListener('blur', () => this._onTitleChange());
    jamTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jamTitle.blur();
      }
    });

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

    this.collab.on('viewport-change', (data) => {
      const room = this._currentRoomInfo;
      if (room) {
        const user = room.users.find((u) => u.id === data.userId);
        if (user) {
          this.engine?.updateRemoteViewport(data.userId, {
            x: data.x,
            y: data.y,
            width: data.width,
            height: data.height,
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
      this.engine?.removeRemoteViewport(data.id);
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
      this.engine?.clearStrokes();
    });

    this.collab.on('sync-strokes', (data) => {
      if (this.pdfMode) {
        this.engine?.setStrokes(data.pdfStrokes || []);
      } else {
        this.engine?.setStrokes(data.strokes || []);
      }
    });

    this.collab.on('jam-renamed', (data) => {
      document.getElementById('jam-title').textContent = data.title;
    });
  }

  // ============================
  // Room creation / join
  // ============================

  async _createRoom(jamId) {
    const name = this.nameInput.value.trim() || this._getSavedName();
    if (!name) {
      this.nameInput.focus();
      this._shakeElement(this.nameInput);
      return;
    }
    this._saveName(name);

    const response = await this.collab.createRoom(name, jamId || null);
    if (response.success) {
      this._currentRoomInfo = response.room;
      this.currentJamId = response.room.jamId;
      this._enterBoard();

      // Load existing strokes if reopening a jam
      if (response.strokes?.length) {
        this.engine.setStrokes(response.strokes);
      }
      if (response.room.pdfUrl) {
        await this._loadPDFFromUrl(response.room.pdfUrl);
        if (response.pdfStrokes?.length) {
          this.engine.setStrokes(response.pdfStrokes);
        }
      }
    }
  }

  async _joinRoom() {
    const name = this.nameInput.value.trim() || this._getSavedName();
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
    this._saveName(name);

    const response = await this.collab.joinRoom(roomId, name);
    if (response.success) {
      this._currentRoomInfo = response.room;
      this.currentJamId = response.room.jamId;
      this._enterBoard();

      if (response.strokes?.length) {
        this.engine.setStrokes(response.strokes);
      }
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
    this.notebookEl.classList.add('hidden');
    this.boardEl.classList.remove('hidden');
    this.inRoom = true;

    document.getElementById('room-code').textContent = this.collab.roomId;
    document.getElementById('jam-title').textContent = this._currentRoomInfo.title || 'Untitled Jam';
    this._updateUserList();

    // Init drawing engine
    const canvas = document.getElementById('draw-canvas');
    this.engine = new DrawingEngine(canvas, {
      onStrokeStart: (data) => this.collab.sendStrokeStart(data),
      onStrokeMove: (data) => this.collab.sendStrokeMove(data),
      onStrokeEnd: (data) => this.collab.sendStrokeEnd(data),
      onErase: (data) => this.collab.sendErase(data),
      onCursorMove: (data) => this.collab.sendCursorMove(data),
      onViewportChange: (data) => this.collab.sendViewportChange(data),
    });

    this._selectTool('pen');
    this._selectColor('#FFFFFF');

    // Send initial viewport so other users can see where we are
    setTimeout(() => {
      const vp = this.engine?._getViewportRect();
      if (vp) this.collab.sendViewportChange(vp);
    }, 100);

    // Auto-save thumbnail every 30s
    this._thumbnailInterval = setInterval(() => this._saveThumbnail(), 30000);
  }

  _selectTool(tool) {
    document.querySelectorAll('.tool-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === tool);
    });
    this.engine?.setTool(tool);

    const canvas = document.getElementById('draw-canvas');
    canvas.style.cursor = 'crosshair';
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

  _saveNow() {
    this._saveThumbnail();
    this._showToast('Jam saved');
  }

  _onTitleChange() {
    const title = document.getElementById('jam-title').textContent.trim();
    if (title && this._currentRoomInfo) {
      this._currentRoomInfo.title = title;
      this.collab.renameJam(title);
    }
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
    this._saveThumbnail();
    if (this._thumbnailInterval) clearInterval(this._thumbnailInterval);

    this.collab.disconnect();
    this.inRoom = false;
    this.pdfMode = false;
    this.currentJamId = null;

    this.lobbyEl.classList.remove('hidden');
    this.boardEl.classList.add('hidden');

    if (this.pdfViewer) {
      this.pdfViewer.destroy();
      this.pdfViewer = null;
    }

    this.collab.connect();
  }

  // ============================
  // Thumbnail capture
  // ============================

  _saveThumbnail() {
    if (!this.engine || !this.inRoom) return;
    try {
      const canvas = document.getElementById('draw-canvas');
      // Create a small thumbnail
      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = 320;
      thumbCanvas.height = 180;
      const ctx = thumbCanvas.getContext('2d');
      ctx.fillStyle = '#2B2D42';
      ctx.fillRect(0, 0, 320, 180);
      ctx.drawImage(canvas, 0, 0, 320, 180);
      const dataUrl = thumbCanvas.toDataURL('image/png', 0.6);
      this.collab.saveThumbnail(dataUrl);
    } catch { /* ignore canvas errors */ }
  }

  // ============================
  // Notebook (My Jams) view
  // ============================

  async _showNotebook() {
    const name = this.nameInput.value.trim() || this._getSavedName();
    if (!name) {
      this.nameInput.focus();
      this._shakeElement(this.nameInput);
      return;
    }
    this._saveName(name);

    this.lobbyEl.classList.add('hidden');
    this.notebookEl.classList.remove('hidden');

    await this._loadJamsList();
  }

  _hideNotebook() {
    this.notebookEl.classList.add('hidden');
    this.lobbyEl.classList.remove('hidden');
  }

  async _loadJamsList() {
    const grid = document.getElementById('jams-grid');
    grid.innerHTML = '<div class="jams-loading">Loading your jams...</div>';

    try {
      const res = await fetch('/api/jams');
      const jams = await res.json();

      if (jams.length === 0) {
        grid.innerHTML = `
          <div class="jams-empty">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
            </svg>
            <p>No saved jams yet</p>
            <p class="jams-empty-hint">Create a new room to start your first jam!</p>
          </div>
        `;
        return;
      }

      // Group by date
      const groups = this._groupJamsByDate(jams);
      grid.innerHTML = '';

      for (const [label, groupJams] of groups) {
        const section = document.createElement('div');
        section.className = 'jams-date-section';

        const header = document.createElement('div');
        header.className = 'jams-date-header';
        header.textContent = label;
        section.appendChild(header);

        const cardsRow = document.createElement('div');
        cardsRow.className = 'jams-cards';

        for (const jam of groupJams) {
          const card = this._createJamCard(jam);
          cardsRow.appendChild(card);
        }

        section.appendChild(cardsRow);
        grid.appendChild(section);
      }
    } catch (err) {
      grid.innerHTML = '<div class="jams-loading">Failed to load jams</div>';
    }
  }

  _groupJamsByDate(jams) {
    const groups = new Map();
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);

    for (const jam of jams) {
      const date = new Date(jam.updatedAt);
      const jamDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      let label;

      if (jamDay.getTime() === today.getTime()) {
        label = 'Today';
      } else if (jamDay.getTime() === yesterday.getTime()) {
        label = 'Yesterday';
      } else if (now - jamDay < 7 * 24 * 60 * 60 * 1000) {
        label = date.toLocaleDateString('en-US', { weekday: 'long' });
      } else {
        label = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      }

      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(jam);
    }

    return groups;
  }

  _createJamCard(jam) {
    const card = document.createElement('div');
    card.className = 'jam-card';

    const time = new Date(jam.updatedAt).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit',
    });

    card.innerHTML = `
      <div class="jam-card-thumb">
        ${jam.thumbnail
          ? `<img src="${jam.thumbnail}" alt="" />`
          : `<div class="jam-card-thumb-empty">
               <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                 <path d="M12 19l7-7 3 3-7 7-3-3z"/>
                 <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
               </svg>
             </div>`
        }
        ${jam.pdfUrl ? '<span class="jam-card-pdf-badge">PDF</span>' : ''}
      </div>
      <div class="jam-card-info">
        <div class="jam-card-title">${this._escapeHtml(jam.title)}</div>
        <div class="jam-card-meta">
          <span>${time}</span>
          <span>${jam.strokeCount} stroke${jam.strokeCount !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <div class="jam-card-actions">
        <button class="jam-card-btn jam-card-open" title="Open jam">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M5 12h14"/>
            <path d="M12 5l7 7-7 7"/>
          </svg>
        </button>
        <button class="jam-card-btn jam-card-delete" title="Delete jam">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      </div>
    `;

    // Open jam
    card.querySelector('.jam-card-open').addEventListener('click', (e) => {
      e.stopPropagation();
      this._openJam(jam.id);
    });

    // Also open on card click
    card.addEventListener('click', () => {
      this._openJam(jam.id);
    });

    // Delete
    card.querySelector('.jam-card-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      this._deleteJam(jam.id, card);
    });

    return card;
  }

  async _openJam(jamId) {
    this.notebookEl.classList.add('hidden');
    await this._createRoom(jamId);
  }

  async _deleteJam(jamId, cardEl) {
    cardEl.classList.add('jam-card-deleting');
    try {
      await fetch(`/api/jams/${jamId}`, { method: 'DELETE' });
      setTimeout(() => {
        cardEl.remove();
        // Check if section is now empty
        document.querySelectorAll('.jams-cards').forEach((row) => {
          if (row.children.length === 0) {
            row.parentElement.remove();
          }
        });
        // Check if entire grid is now empty
        const grid = document.getElementById('jams-grid');
        if (!grid.querySelector('.jams-date-section')) {
          grid.innerHTML = `
            <div class="jams-empty">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <p>No saved jams yet</p>
              <p class="jams-empty-hint">Create a new room to start your first jam!</p>
            </div>
          `;
        }
      }, 300);
    } catch {
      cardEl.classList.remove('jam-card-deleting');
      this._showToast('Failed to delete jam', 'error');
    }
  }

  // ============================
  // User list & UI helpers
  // ============================

  _updateUserList() {
    const list = document.getElementById('user-list');
    if (!this._currentRoomInfo) return;

    list.innerHTML = '';
    this._currentRoomInfo.users.forEach((user) => {
      const el = document.createElement('div');
      el.className = 'user-badge';
      el.innerHTML = `<span class="user-dot" style="background:${user.color}"></span>${this._escapeHtml(user.name)}`;
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
    if (e.target.tagName === 'INPUT' || e.target.isContentEditable) return;

    if (e.key === 'p' || e.key === '1') this._selectTool('pen');
    else if (e.key === 'l' || e.key === '2') this._selectTool('pencil');
    else if (e.key === 'h' || e.key === '3') this._selectTool('highlighter');
    else if (e.key === 'e' || e.key === '4') this._selectTool('eraser');
    else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._undo();
    }
    else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this._saveNow();
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

  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Remember name across sessions
  _saveName(name) {
    try { localStorage.setItem('collabboard-name', name); } catch {}
  }

  _getSavedName() {
    try { return localStorage.getItem('collabboard-name') || ''; } catch { return ''; }
  }
}

// Boot
window.addEventListener('DOMContentLoaded', () => {
  new CollabBoardApp();
});
