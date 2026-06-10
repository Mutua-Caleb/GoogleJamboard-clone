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
    this._tryAutoRejoin();
  }

  _initUI() {
    // Views
    this.lobbyEl = document.getElementById('lobby');
    this.boardEl = document.getElementById('board');
    this.notebookEl = document.getElementById('notebook');
    this.nameInput = document.getElementById('name-input');
    this.roomIdInput = document.getElementById('room-id-input');

    // Pre-fill name from previous session
    const savedName = this._getSavedName();
    if (savedName) this.nameInput.value = savedName;

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

    // Tools - only bind to buttons that actually have a data-tool attribute
    document.querySelectorAll('.tool-btn[data-tool]').forEach((btn) => {
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

    // Image upload
    document.getElementById('btn-upload-image').addEventListener('click', () => {
      document.getElementById('image-file-input').click();
    });
    document.getElementById('image-file-input').addEventListener('change', (e) => this._uploadImage(e));

    // YouTube embed
    document.getElementById('btn-add-youtube').addEventListener('click', () => this._promptYouTubeUrl());

    // Cursive practice
    document.getElementById('btn-cursive').addEventListener('click', () => this._promptCursivePractice());

    // Paste handler for images
    document.addEventListener('paste', (e) => this._handlePaste(e));

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
      document.getElementById('connection-status').textContent = 'Reconnecting...';
      document.getElementById('connection-status').className = 'status-dot disconnected';
      if (this.inRoom) {
        this.engine?.cancelActiveStroke();
        this._showToast('Connection lost. Reconnecting...', 'error');
      }
    });

    this.collab.on('reconnected', () => {
      document.getElementById('connection-status').textContent = 'Connected';
      document.getElementById('connection-status').className = 'status-dot connected';
      if (this.inRoom) {
        this._autoRejoinCurrentRoom();
      }
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

    // Remote text
    this.collab.on('add-text', (data) => {
      this.engine?.addText(data);
    });
    this.collab.on('remove-text', (data) => {
      this.engine?.removeText(data.id);
    });
    this.collab.on('update-text', (data) => {
      const item = this.engine?.textItems.find((t) => t.id === data.id);
      if (item) Object.assign(item, data);
    });

    this.collab.on('add-media', (data) => {
      this.engine?.addMedia(data);
      if (data.type === 'youtube') this._createYouTubeOverlay(data);
    });
    this.collab.on('remove-media', (data) => {
      this.engine?.removeMedia(data.id);
      this._removeYouTubeOverlay(data.id);
    });
    this.collab.on('move-media', (data) => {
      this._handleRemoteMediaMove(data);
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
      this.engine?.removeRemoteUserStrokes(data.id);
      this._updateUserList();
      this._showToast('A user left the board');
    });

    this.collab.on('load-pdf', (data) => {
      this._loadPDFFromUrl(data.url);
    });

    this.collab.on('close-pdf', () => {
      this._closePDF(true);
      this._showToast('PDF was closed');
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
      if (data?.layer !== 'pdf') {
        this.engine?.setTextItems([]);
      }
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
      await this._applyRoomState(response);
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
      await this._applyRoomState(response);
    } else {
      this._showToast(response.error || 'Failed to join room', 'error');
    }
  }

  async _applyRoomState(response) {
    if (!response?.success || !this.engine) return;

    this._currentRoomInfo = response.room;
    this.currentJamId = response.room?.jamId || this.currentJamId;
    document.getElementById('jam-title').textContent = response.room?.title || 'Untitled Jam';
    this._updateUserList();

    this.engine.clearTransientStrokes();
    this.engine.setTextItems(response.textItems || []);
    document.querySelectorAll('.youtube-overlay').forEach((el) => el.remove());
    this.engine.setMedia(response.media || []);
    for (const item of response.media || []) {
      if (item.type === 'youtube') this._createYouTubeOverlay(item);
    }

    if (response.room?.pdfUrl) {
      if (!this.pdfMode || !this.pdfViewer) {
        await this._loadPDFFromUrl(response.room.pdfUrl, { silent: true });
      }
      if (this.pdfViewer && response.room.pdfPage) {
        this.pdfViewer.goToPage(response.room.pdfPage);
      }
      this.pdfMode = true;
      this.engine.setLayer('pdf');
      this.engine.setStrokes(response.pdfStrokes || []);
    } else {
      if (this.pdfMode) this._closePDF(true);
      this.pdfMode = false;
      this.engine.setLayer('whiteboard');
      this.engine.setStrokes(response.strokes || []);
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

    // Destroy old engine if re-entering (prevents stale render loops)
    if (this.engine) {
      this.engine.destroy();
      this.engine = null;
    }

    // Init drawing engine
    const canvas = document.getElementById('draw-canvas');
    this.engine = new DrawingEngine(canvas, {
      onStrokeStart: (data) => this.collab.sendStrokeStart(data),
      onStrokeMove: (data) => this.collab.sendStrokeMove(data),
      onStrokeEnd: (data) => this.collab.sendStrokeEnd(data),
      onErase: (data) => this.collab.sendErase(data),
      onCursorMove: (data) => this.collab.sendCursorMove(data),
      onViewportChange: (data) => this.collab.sendViewportChange(data),
      onAddText: (data) => this.collab.sendAddText(data),
      onRemoveText: (data) => this.collab.sendRemoveText(data),
      onUpdateText: (data) => this.collab.sendUpdateText(data),
    });

    this._selectTool('pen');
    this._selectColor('#FFFFFF');

    // Save session for auto-rejoin
    this._saveSession();

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
    canvas.style.cursor = tool === 'text' ? 'text' : 'crosshair';
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
    this.engine?.setTextItems([]);
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

  async _loadPDFFromUrl(url, options = {}) {
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
    if (!options.silent) this._showToast('PDF loaded');
  }

  _closePDF(remote = false) {
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

    if (!remote) {
      this.collab.sendClosePDF();
    }
  }

  // ============================
  // Image & YouTube media
  // ============================

  async _handlePaste(e) {
    if (!this.inRoom) return;
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        await this._uploadImageFile(file);
        return;
      }
    }
  }

  async _uploadImage(e) {
    const file = e.target.files[0];
    if (!file) return;
    await this._uploadImageFile(file);
    e.target.value = '';
  }

  async _uploadImageFile(file) {
    const formData = new FormData();
    formData.append('image', file);

    try {
      this._showToast('Uploading image...');
      const res = await fetch('/api/upload-image', { method: 'POST', body: formData });
      const data = await res.json();

      if (data.url) {
        // Get image dimensions to size it on canvas
        const img = new Image();
        img.src = data.url;
        await new Promise((resolve) => { img.onload = resolve; img.onerror = resolve; });

        const maxSize = 400;
        let width = img.naturalWidth || 400;
        let height = img.naturalHeight || 300;
        if (width > maxSize || height > maxSize) {
          const ratio = Math.min(maxSize / width, maxSize / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        // Place at center of current viewport
        const vp = this.engine?._getViewportRect();
        const x = vp ? vp.x + (vp.width - width) / 2 : 100;
        const y = vp ? vp.y + (vp.height - height) / 2 : 100;

        const mediaItem = {
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'image',
          url: data.url,
          x, y, width, height,
        };

        this.engine?.addMedia(mediaItem);
        this.collab.sendAddMedia(mediaItem);
        this._showToast('Image added');
      }
    } catch {
      this._showToast('Failed to upload image', 'error');
    }
  }

  _promptYouTubeUrl() {
    // Create a simple modal for YouTube URL input
    const existing = document.getElementById('youtube-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'youtube-modal';
    modal.className = 'youtube-modal';
    modal.innerHTML = `
      <div class="youtube-modal-content">
        <h3>Add YouTube Video</h3>
        <input type="text" id="youtube-url-input" placeholder="Paste YouTube URL here..." autocomplete="off" />
        <div class="youtube-modal-actions">
          <button id="youtube-modal-cancel" class="btn btn-secondary btn-sm">Cancel</button>
          <button id="youtube-modal-add" class="btn btn-primary btn-sm">Add Video</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const input = document.getElementById('youtube-url-input');
    input.focus();

    const close = () => modal.remove();

    document.getElementById('youtube-modal-cancel').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    const addVideo = () => {
      const url = input.value.trim();
      const videoId = this._extractYouTubeId(url);
      if (!videoId) {
        this._showToast('Invalid YouTube URL', 'error');
        return;
      }
      close();
      this._addYouTubeEmbed(videoId);
    };

    document.getElementById('youtube-modal-add').addEventListener('click', addVideo);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addVideo();
      if (e.key === 'Escape') close();
    });
  }

  _extractYouTubeId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];
    for (const p of patterns) {
      const match = url.match(p);
      if (match) return match[1];
    }
    return null;
  }

  _addYouTubeEmbed(videoId) {
    const vp = this.engine?._getViewportRect();
    const width = 480;
    const height = 270;
    const x = vp ? vp.x + (vp.width - width) / 2 : 100;
    const y = vp ? vp.y + (vp.height - height) / 2 : 100;

    const mediaItem = {
      id: `yt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'youtube',
      videoId,
      x, y, width, height,
    };

    this.engine?.addMedia(mediaItem);
    this._createYouTubeOverlay(mediaItem);
    this.collab.sendAddMedia(mediaItem);
    this._showToast('YouTube video added');
  }

  _createYouTubeOverlay(item) {
    if (item.type !== 'youtube') return;
    // Prevent duplicate overlays
    if (document.getElementById(`yt-overlay-${item.id}`)) return;
    const container = document.getElementById('canvas-area');

    const wrapper = document.createElement('div');
    wrapper.id = `yt-overlay-${item.id}`;
    wrapper.className = 'youtube-overlay';
    wrapper.dataset.mediaId = item.id;
    wrapper.dataset.cx = item.x;
    wrapper.dataset.cy = item.y;
    wrapper.dataset.cw = item.width;
    wrapper.dataset.ch = item.height;

    wrapper.innerHTML = `
      <div class="youtube-overlay-header">
        <span>YouTube</span>
        <button class="youtube-close-btn" title="Remove video">&times;</button>
      </div>
      <iframe
        src="https://www.youtube.com/embed/${item.videoId}?rel=0"
        frameborder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowfullscreen
        style="width:100%;height:calc(100% - 28px);border-radius:0 0 6px 6px;"
      ></iframe>
      <div class="youtube-resize-handle"></div>
    `;

    container.appendChild(wrapper);

    // Close button
    wrapper.querySelector('.youtube-close-btn').addEventListener('click', () => {
      this.engine?.removeMedia(item.id);
      this._removeYouTubeOverlay(item.id);
      this.collab.sendRemoveMedia({ id: item.id });
    });

    // Drag by header
    this._setupYouTubeDrag(wrapper);
    // Resize by corner handle
    this._setupYouTubeResize(wrapper);

    // Update position based on transform
    this._updateYouTubeOverlays();

    // Keep updating via render loop reference
    if (!this._ytUpdateInterval) {
      this._ytUpdateInterval = setInterval(() => this._updateYouTubeOverlays(), 50);
    }
  }

  _setupYouTubeDrag(wrapper) {
    const header = wrapper.querySelector('.youtube-overlay-header');
    let dragging = false;
    let startX, startY, origCx, origCy;

    header.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.youtube-close-btn')) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      header.setPointerCapture(e.pointerId);
      wrapper.classList.add('dragging');

      const t = this.engine.transform;
      startX = e.clientX;
      startY = e.clientY;
      origCx = parseFloat(wrapper.dataset.cx);
      origCy = parseFloat(wrapper.dataset.cy);
    });

    header.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const t = this.engine.transform;
      const dx = (e.clientX - startX) / t.scale;
      const dy = (e.clientY - startY) / t.scale;
      wrapper.dataset.cx = origCx + dx;
      wrapper.dataset.cy = origCy + dy;
    });

    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      wrapper.classList.remove('dragging');
      this._syncMediaPosition(wrapper);
    };
    header.addEventListener('pointerup', stopDrag);
    header.addEventListener('pointercancel', stopDrag);
  }

  _setupYouTubeResize(wrapper) {
    const handle = wrapper.querySelector('.youtube-resize-handle');
    let resizing = false;
    let startX, startY, origCw, origCh;

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizing = true;
      handle.setPointerCapture(e.pointerId);
      wrapper.classList.add('resizing');

      const t = this.engine.transform;
      startX = e.clientX;
      startY = e.clientY;
      origCw = parseFloat(wrapper.dataset.cw);
      origCh = parseFloat(wrapper.dataset.ch);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      e.preventDefault();
      const t = this.engine.transform;
      const dw = (e.clientX - startX) / t.scale;
      const dh = (e.clientY - startY) / t.scale;
      wrapper.dataset.cw = Math.max(200, origCw + dw);
      wrapper.dataset.ch = Math.max(120, origCh + dh);
    });

    const stopResize = () => {
      if (!resizing) return;
      resizing = false;
      wrapper.classList.remove('resizing');
      this._syncMediaPosition(wrapper);
    };
    handle.addEventListener('pointerup', stopResize);
    handle.addEventListener('pointercancel', stopResize);
  }

  _syncMediaPosition(wrapper) {
    const id = wrapper.dataset.mediaId;
    const x = parseFloat(wrapper.dataset.cx);
    const y = parseFloat(wrapper.dataset.cy);
    const width = parseFloat(wrapper.dataset.cw);
    const height = parseFloat(wrapper.dataset.ch);

    // Update local engine media item
    const item = this.engine?.mediaItems.find((m) => m.id === id);
    if (item) {
      item.x = x; item.y = y;
      item.width = width; item.height = height;
    }

    // Broadcast to collaborators
    this.collab.sendMoveMedia({ id, x, y, width, height });
  }

  _handleRemoteMediaMove(data) {
    // Update engine media item
    const item = this.engine?.mediaItems.find((m) => m.id === data.id);
    if (item) {
      item.x = data.x; item.y = data.y;
      item.width = data.width; item.height = data.height;
    }

    // Update YouTube overlay if it exists
    const el = document.getElementById(`yt-overlay-${data.id}`);
    if (el) {
      el.dataset.cx = data.x;
      el.dataset.cy = data.y;
      el.dataset.cw = data.width;
      el.dataset.ch = data.height;
    }
  }

  _removeYouTubeOverlay(id) {
    const el = document.getElementById(`yt-overlay-${id}`);
    if (el) el.remove();
  }

  _updateYouTubeOverlays() {
    if (!this.engine) return;
    const t = this.engine.transform;
    document.querySelectorAll('.youtube-overlay').forEach((el) => {
      const cx = parseFloat(el.dataset.cx);
      const cy = parseFloat(el.dataset.cy);
      const cw = parseFloat(el.dataset.cw);
      const ch = parseFloat(el.dataset.ch);
      const sx = cx * t.scale + t.x;
      const sy = cy * t.scale + t.y;
      const sw = cw * t.scale;
      const sh = ch * t.scale;
      el.style.left = `${sx}px`;
      el.style.top = `${sy}px`;
      el.style.width = `${sw}px`;
      el.style.height = `${sh}px`;
    });
  }

  _loadMedia(items) {
    this.engine?.setMedia(items);
    for (const item of items) {
      if (item.type === 'youtube') {
        this._createYouTubeOverlay(item);
      }
    }
  }

  // ============================
  // Cursive Practice
  // ============================

  _promptCursivePractice() {
    const existing = document.getElementById('cursive-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'cursive-modal';
    modal.className = 'youtube-modal'; // reuse modal styles
    modal.innerHTML = `
      <div class="youtube-modal-content">
        <h3>Cursive Practice</h3>
        <p style="font-size:13px;color:#a0aec0;margin-bottom:12px;">
          Type letters or words to trace. They'll appear as faint guide text on the canvas.
          Trace over them with your pen, then click "Hide" to test your memory!
        </p>
        <input type="text" id="cursive-text-input" placeholder="Type text to practice (e.g. Hello World)" autocomplete="off" maxlength="50" />
        <div style="margin-top:12px;">
          <label style="font-size:13px;color:#a0aec0;">Size</label>
          <input type="range" id="cursive-size-input" min="40" max="200" value="80" style="width:100%;" />
        </div>
        <div class="youtube-modal-actions" style="margin-top:16px;">
          <button id="cursive-modal-cancel" class="btn btn-secondary btn-sm">Cancel</button>
          <button id="cursive-modal-add" class="btn btn-primary btn-sm">Place on Canvas</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const input = document.getElementById('cursive-text-input');
    input.focus();

    const close = () => modal.remove();

    document.getElementById('cursive-modal-cancel').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    const addPractice = () => {
      const text = input.value.trim();
      if (!text) {
        this._showToast('Please enter text to practice', 'error');
        return;
      }
      const fontSize = parseInt(document.getElementById('cursive-size-input').value);
      close();
      this._placeCursivePractice(text, fontSize);
    };

    document.getElementById('cursive-modal-add').addEventListener('click', addPractice);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addPractice();
      if (e.key === 'Escape') close();
    });
  }

  _placeCursivePractice(text, fontSize) {
    if (!this.engine) return;

    const vp = this.engine._getViewportRect();
    const x = vp ? vp.x + (vp.width - text.length * fontSize * 0.5) / 2 : 100;
    const y = vp ? vp.y + vp.height / 2 - fontSize / 2 : 200;

    const practiceItem = {
      id: `cursive-${Date.now()}`,
      text,
      x,
      y,
      fontSize,
      visible: true,
    };

    this.engine.addCursivePractice(practiceItem);
    this._showToast('Trace the letters! Press "Hide Guides" when ready to practice from memory.');

    // Show a floating control to toggle/remove the guide
    this._showCursiveControls(practiceItem.id);
  }

  _showCursiveControls(practiceId) {
    const existing = document.getElementById('cursive-controls');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.id = 'cursive-controls';
    bar.className = 'cursive-controls';
    bar.innerHTML = `
      <span class="cursive-controls-label">Cursive Practice</span>
      <button id="cursive-toggle" class="btn btn-sm btn-secondary">Hide Guides</button>
      <button id="cursive-remove" class="btn btn-sm btn-danger">Remove</button>
    `;
    document.getElementById('canvas-area').appendChild(bar);

    document.getElementById('cursive-toggle').addEventListener('click', () => {
      const item = this.engine?.cursivePractices?.find(p => p.id === practiceId);
      if (item) {
        item.visible = !item.visible;
        document.getElementById('cursive-toggle').textContent = item.visible ? 'Hide Guides' : 'Show Guides';
      }
    });

    document.getElementById('cursive-remove').addEventListener('click', () => {
      this.engine?.removeCursivePractice(practiceId);
      bar.remove();
    });
  }

  _leaveRoom() {
    this._saveThumbnail();
    this._clearSession();
    if (this._thumbnailInterval) clearInterval(this._thumbnailInterval);
    if (this._ytUpdateInterval) { clearInterval(this._ytUpdateInterval); this._ytUpdateInterval = null; }
    document.querySelectorAll('.youtube-overlay').forEach((el) => el.remove());
    const cursiveCtrl = document.getElementById('cursive-controls');
    if (cursiveCtrl) cursiveCtrl.remove();

    // Stop old engine render loop
    if (this.engine) {
      this.engine.destroy();
      this.engine = null;
    }

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
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

    if (e.key === 'p' || e.key === '1') this._selectTool('pen');
    else if (e.key === 'l' || e.key === '2') this._selectTool('pencil');
    else if (e.key === 'h' || e.key === '3') this._selectTool('highlighter');
    else if (e.key === 'e' || e.key === '4') this._selectTool('eraser');
    else if (e.key === 't' || e.key === '5') this._selectTool('text');
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

  // Auto-rejoin after reconnect (network drop recovery)
  async _autoRejoinCurrentRoom() {
    if (!this.collab.roomId || !this.collab.userName) return;

    try {
      this.engine?.clearTransientStrokes();
      const response = await this.collab.rejoinRoom(this.collab.roomId, this.collab.userName);
      if (response.success) {
        await this._applyRoomState(response);
        this._saveSession();
        this._showToast('Reconnected!');
      } else {
        // Room was cleaned up, fall back to jam-based rejoin
        this._showToast('Room expired. Reopening jam...', 'error');
        if (this.currentJamId) {
          await this._createRoom(this.currentJamId);
        }
      }
    } catch {
      this._showToast('Failed to reconnect', 'error');
    }
  }

  // Session persistence
  _saveSession() {
    try {
      localStorage.setItem('collabboard-session', JSON.stringify({
        jamId: this.currentJamId,
        roomId: this.collab.roomId,
        name: this.collab.userName,
        timestamp: Date.now(),
      }));
    } catch {}
  }

  _clearSession() {
    try { localStorage.removeItem('collabboard-session'); } catch {}
  }

  _getSavedSession() {
    try {
      const raw = localStorage.getItem('collabboard-session');
      if (!raw) return null;
      const session = JSON.parse(raw);
      // Sessions older than 7 days are stale
      if (Date.now() - session.timestamp > 7 * 24 * 60 * 60 * 1000) {
        this._clearSession();
        return null;
      }
      return session;
    } catch { return null; }
  }

  async _tryAutoRejoin() {
    const session = this._getSavedSession();
    if (!session || !session.jamId || !session.name) return;

    // Wait for socket connection
    await new Promise((resolve) => {
      if (this.collab.socket?.connected) return resolve();
      this.collab.on('connected', resolve);
    });

    this.nameInput.value = session.name;
    if (session.roomId) {
      const response = await this.collab.rejoinRoom(session.roomId, session.name);
      if (response.success) {
        this._currentRoomInfo = response.room;
        this.currentJamId = response.room.jamId;
        this._enterBoard();
        await this._applyRoomState(response);
        this._saveSession();
        this._showToast('Rejoined your board');
        return;
      }
    }

    await this._createRoom(session.jamId);
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
