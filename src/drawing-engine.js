/**
 * Drawing engine with pressure-sensitive pen, pencil, and eraser support.
 * Supports Wacom, XP-Pen tablets and mouse input via Pointer Events API.
 */

export class DrawingEngine {
  constructor(canvas, { onStrokeStart, onStrokeMove, onStrokeEnd, onErase, onCursorMove, onViewportChange, onAddText, onRemoveText, onUpdateText, onMoveMedia, onRemoveMedia }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = { onStrokeStart, onStrokeMove, onStrokeEnd, onErase, onCursorMove, onViewportChange, onAddText, onRemoveText, onUpdateText, onMoveMedia, onRemoveMedia };

    // State
    this.isDrawing = false;
    this.isSpacePressed = false;
    this.currentStroke = null;
    this.activePointerId = null;
    this.tool = 'pen';        // pen | pencil | eraser | highlighter | text
    this.color = '#FFFFFF';
    this.size = 3;
    this.opacity = 1;
    this.layer = 'whiteboard'; // whiteboard | pdf
    this.lastCursorPoint = null;

    // All strokes stored locally for rendering
    this.strokes = [];
    this.strokeIdCounter = 0;

    // Media items (images rendered on canvas)
    this.mediaItems = [];
    this._imageCache = new Map();
    this.selectedMediaId = null;
    this.hoveredMediaId = null;
    this._mediaAction = null;
    this._textDragAction = null;

    // Text items rendered on canvas
    this.textItems = [];
    this._editingTextId = null;

    // Cursive practice guide items
    this.cursivePractices = [];

    // Pan (scale fixed at 1, zooming disabled)
    this.transform = { x: 0, y: 0, scale: 1 };
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };

    // Remote cursors
    this.remoteCursors = new Map();

    // Remote viewports (other users' visible area)
    this.remoteViewports = new Map();

    // Offscreen canvas for pencil texture
    this.pencilPattern = this._createPencilPattern();

    // Scrollbar elements
    this._scrollbarV = document.getElementById('scrollbar-v');
    this._scrollbarH = document.getElementById('scrollbar-h');
    this._thumbV = document.getElementById('scrollbar-v-thumb');
    this._thumbH = document.getElementById('scrollbar-h-thumb');

    this._setupEvents();
    this._setupScrollbars();
    this._startRenderLoop();
  }

  _createPencilPattern() {
    const patternCanvas = document.createElement('canvas');
    patternCanvas.width = 4;
    patternCanvas.height = 4;
    const pctx = patternCanvas.getContext('2d');
    // Grainy pencil-like pattern
    for (let i = 0; i < 8; i++) {
      const x = Math.random() * 4;
      const y = Math.random() * 4;
      pctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.5 + 0.3})`;
      pctx.fillRect(x, y, 1, 1);
    }
    return patternCanvas;
  }

  _setupEvents() {
    // Use pointer events for pressure sensitivity (tablet support)
    this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
    this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('lostpointercapture', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
    window.addEventListener('blur', () => this.cancelActiveStroke());

    // Prevent default touch behaviors for tablet
    this.canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    // Pan with wheel (zooming disabled)
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    // Context menu disable
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Spacebar pan
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && !e.target.isContentEditable) {
        e.preventDefault();
        this.isSpacePressed = true;
        if (!this.isPanning) this.canvas.style.cursor = 'grab';
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        this.isSpacePressed = false;
        if (!this.isPanning) this._updateDefaultCursor();
      }
    });
  }

  _updateDefaultCursor() {
    if (this.tool === 'text') this.canvas.style.cursor = 'text';
    else if (this.tool === 'select') this.canvas.style.cursor = 'default';
    else this.canvas.style.cursor = 'crosshair';
  }

  _getCanvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - this.transform.x) / this.transform.scale,
      y: (e.clientY - rect.top - this.transform.y) / this.transform.scale,
    };
  }

  _getMediaControlRects(item) {
    const btnH = 26;
    const deleteW = 26;
    const lockW = 112;
    const pad = 8;
    const deleteRect = {
      x: item.x + item.width - deleteW - pad,
      y: item.y + pad,
      w: deleteW,
      h: btnH,
    };
    const lockRect = {
      x: deleteRect.x - lockW - 6,
      y: item.y + pad,
      w: lockW,
      h: btnH,
    };
    return { lockRect, deleteRect };
  }

  _getMediaInteractionAt(point) {
    const handleRadius = 12;
    for (let i = this.mediaItems.length - 1; i >= 0; i--) {
      const item = this.mediaItems[i];
      if (item.type !== 'image') continue;

      const isActive = item.id === this.hoveredMediaId || item.id === this.selectedMediaId;
      if (isActive) {
        const { lockRect, deleteRect } = this._getMediaControlRects(item);
        if (
          point.x >= deleteRect.x &&
          point.x <= deleteRect.x + deleteRect.w &&
          point.y >= deleteRect.y &&
          point.y <= deleteRect.y + deleteRect.h
        ) {
          return { action: 'delete', item };
        }
        if (
          point.x >= lockRect.x &&
          point.x <= lockRect.x + lockRect.w &&
          point.y >= lockRect.y &&
          point.y <= lockRect.y + lockRect.h
        ) {
          return { action: 'toggle-lock', item };
        }
      }

      const canManipulate = !item.locked || this.tool === 'select';
      if (canManipulate) {
        const corners = [
          { name: 'resize-nw', cx: item.x, cy: item.y },
          { name: 'resize-ne', cx: item.x + item.width, cy: item.y },
          { name: 'resize-sw', cx: item.x, cy: item.y + item.height },
          { name: 'resize-se', cx: item.x + item.width, cy: item.y + item.height },
        ];
        for (const c of corners) {
          if (Math.abs(point.x - c.cx) <= handleRadius && Math.abs(point.y - c.cy) <= handleRadius) {
            return { action: c.name, item };
          }
        }
      }

      if (
        point.x >= item.x &&
        point.x <= item.x + item.width &&
        point.y >= item.y &&
        point.y <= item.y + item.height
      ) {
        if (canManipulate) {
          return { action: 'move', item };
        }
        return { action: 'locked-hover', item };
      }
    }
    return null;
  }

  _onPointerDown(e) {
    // Middle mouse button or space+click for panning
    if (e.button === 1 || (e.button === 0 && (e.altKey || this.isSpacePressed))) {
      this.isPanning = true;
      this.panStart = { x: e.clientX - this.transform.x, y: e.clientY - this.transform.y };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button !== 0) return;

    const point = this._getCanvasPoint(e);
    this.lastCursorPoint = point;

    // Check image interaction (drag, resize, lock/unlock, delete)
    // Skip direct image drag only if eraser is actively erasing strokes or text tool is clicking existing text
    const mediaHit = this.tool === 'eraser' ? null : this._getMediaInteractionAt(point);
    if (mediaHit) {
      if (mediaHit.action === 'delete') {
        e.preventDefault();
        const id = mediaHit.item.id;
        this.removeMedia(id);
        this.callbacks.onRemoveMedia?.({ id });
        this._updateDefaultCursor();
        return;
      }
      if (mediaHit.action === 'toggle-lock') {
        e.preventDefault();
        mediaHit.item.locked = !mediaHit.item.locked;
        this.selectedMediaId = mediaHit.item.locked ? null : mediaHit.item.id;
        return;
      }
      if (mediaHit.action === 'move' || mediaHit.action.startsWith('resize-')) {
        e.preventDefault();
        if (this._activeTextInput) this._commitTextInput();
        this.selectedMediaId = mediaHit.item.id;
        this.hoveredMediaId = mediaHit.item.id;
        this._mediaAction = {
          type: mediaHit.action,
          item: mediaHit.item,
          pointerId: e.pointerId,
          startX: point.x,
          startY: point.y,
          origX: mediaHit.item.x,
          origY: mediaHit.item.y,
          origW: mediaHit.item.width,
          origH: mediaHit.item.height,
          aspect: (mediaHit.item.width || 1) / (mediaHit.item.height || 1),
          lastSync: 0,
        };
        this.canvas.setPointerCapture?.(e.pointerId);
        this.canvas.style.cursor = mediaHit.action === 'move'
          ? 'grabbing'
          : (mediaHit.action === 'resize-nw' || mediaHit.action === 'resize-se' ? 'nwse-resize' : 'nesw-resize');
        return;
      }
    }

    this.selectedMediaId = null;

    // Select/Move tool: drag text notes or pan canvas
    if (this.tool === 'select') {
      const clickedText = this._findTextItemAt(point);
      if (clickedText) {
        e.preventDefault();
        if (this._activeTextInput) this._commitTextInput();
        this._textDragAction = {
          item: clickedText,
          pointerId: e.pointerId,
          startX: point.x,
          startY: point.y,
          origX: clickedText.x,
          origY: clickedText.y,
          lastSync: 0,
        };
        this.canvas.setPointerCapture?.(e.pointerId);
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      this.isPanning = true;
      this.panStart = { x: e.clientX - this.transform.x, y: e.clientY - this.transform.y };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    // Text tool: open text input at click position (or edit clicked text item)
    if (this.tool === 'text') {
      e.preventDefault();
      e.stopPropagation();
      this._commitTextInput();
      const clickedText = this._findTextItemAt(point);
      if (clickedText) {
        this._openTextInput({ x: clickedText.x, y: clickedText.y }, { editingItem: clickedText });
      } else {
        this._openTextInput(point);
      }
      return;
    }

    // If user clicks canvas with another tool while text input is open, commit it first
    if (this._activeTextInput) {
      this._commitTextInput();
    }

    const pressure = e.pressure !== undefined && e.pressure > 0 ? e.pressure : 0.5;

    this.isDrawing = true;
    this.activePointerId = e.pointerId;
    this.canvas.setPointerCapture?.(e.pointerId);
    const strokeId = `${Date.now()}-${this.strokeIdCounter++}`;

    this.currentStroke = {
      id: strokeId,
      tool: this.tool,
      color: this.tool === 'eraser' ? null : this.color,
      size: this.size,
      opacity: this.tool === 'highlighter' ? 0.35 : this.opacity,
      points: [{ x: point.x, y: point.y, pressure }],
      layer: this.layer,
    };

    if (this.tool === 'eraser') {
      this._handleErase(point);
    }

    this.callbacks.onStrokeStart?.({
      id: strokeId,
      tool: this.tool,
      color: this.currentStroke.color,
      size: this.size,
      opacity: this.currentStroke.opacity,
      point: { x: point.x, y: point.y, pressure },
      layer: this.layer,
    });
  }

  _onPointerMove(e) {
    const point = this._getCanvasPoint(e);
    this.lastCursorPoint = point;

    // Cursor tracking
    this.callbacks.onCursorMove?.({ x: point.x, y: point.y });

    if (this._mediaAction && e.pointerId === this._mediaAction.pointerId) {
      const { type, item, startX, startY, origX, origY, origW, origH, aspect } = this._mediaAction;
      const dx = point.x - startX;
      const dy = point.y - startY;

      if (type === 'move') {
        item.x = Math.round(origX + dx);
        item.y = Math.round(origY + dy);
      } else {
        const minSize = 60;
        let newW = origW;
        let newH = origH;
        if (type === 'resize-se') {
          newW = Math.max(minSize, origW + dx);
          newH = e.shiftKey ? Math.max(minSize, origH + dy) : Math.max(minSize, Math.round(newW / aspect));
        } else if (type === 'resize-sw') {
          newW = Math.max(minSize, origW - dx);
          newH = e.shiftKey ? Math.max(minSize, origH + dy) : Math.max(minSize, Math.round(newW / aspect));
          item.x = Math.round(origX + origW - newW);
        } else if (type === 'resize-ne') {
          newW = Math.max(minSize, origW + dx);
          newH = e.shiftKey ? Math.max(minSize, origH - dy) : Math.max(minSize, Math.round(newW / aspect));
          item.y = Math.round(origY + origH - newH);
        } else if (type === 'resize-nw') {
          newW = Math.max(minSize, origW - dx);
          newH = e.shiftKey ? Math.max(minSize, origH - dy) : Math.max(minSize, Math.round(newW / aspect));
          item.x = Math.round(origX + origW - newW);
          item.y = Math.round(origY + origH - newH);
        }
        item.width = Math.round(newW);
        item.height = Math.round(newH);
      }

      const now = Date.now();
      if (now - this._mediaAction.lastSync >= 30) {
        this._mediaAction.lastSync = now;
        this.callbacks.onMoveMedia?.({
          id: item.id,
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
        });
      }
      return;
    }

    if (this._textDragAction && e.pointerId === this._textDragAction.pointerId) {
      const { item, startX, startY, origX, origY } = this._textDragAction;
      item.x = Math.round(origX + (point.x - startX));
      item.y = Math.round(origY + (point.y - startY));
      const now = Date.now();
      if (now - this._textDragAction.lastSync >= 30) {
        this._textDragAction.lastSync = now;
        this.callbacks.onUpdateText?.({
          id: item.id,
          text: item.text,
          x: item.x,
          y: item.y,
          color: item.color,
          fontSize: item.fontSize,
          layer: item.layer,
        });
      }
      return;
    }

    if (this.isPanning) {
      this.transform.x = e.clientX - this.panStart.x;
      this.transform.y = e.clientY - this.panStart.y;
      this._updateActiveTextInputPosition();
      this._notifyViewportChange();
      return;
    }

    if (!this.isDrawing) {
      const hit = this.tool === 'eraser' ? null : this._getMediaInteractionAt(point);
      this.hoveredMediaId = hit ? hit.item.id : null;
      if (hit) {
        if (hit.action === 'delete' || hit.action === 'toggle-lock') {
          this.canvas.style.cursor = 'pointer';
        } else if (hit.action === 'resize-nw' || hit.action === 'resize-se') {
          this.canvas.style.cursor = 'nwse-resize';
        } else if (hit.action === 'resize-ne' || hit.action === 'resize-sw') {
          this.canvas.style.cursor = 'nesw-resize';
        } else if (hit.action === 'move') {
          this.canvas.style.cursor = 'grab';
        } else {
          this._updateDefaultCursor();
        }
      } else if (this.tool === 'select' && this._findTextItemAt(point)) {
        this.canvas.style.cursor = 'grab';
      } else if (!this.isSpacePressed) {
        this._updateDefaultCursor();
      }
      return;
    }

    if (!this.currentStroke || e.pointerId !== this.activePointerId) return;

    const pressure = e.pressure !== undefined && e.pressure > 0 ? e.pressure : 0.5;
    this.currentStroke.points.push({ x: point.x, y: point.y, pressure });

    if (this.tool === 'eraser') {
      this._handleErase(point);
    }

    this.callbacks.onStrokeMove?.({
      id: this.currentStroke.id,
      point: { x: point.x, y: point.y, pressure },
    });
  }

  _onPointerUp(e) {
    if (this._mediaAction && e.pointerId === this._mediaAction.pointerId) {
      const { item } = this._mediaAction;
      this.callbacks.onMoveMedia?.({
        id: item.id,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      });
      this._mediaAction = null;
      if (this.canvas.hasPointerCapture?.(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      this.canvas.style.cursor = 'grab';
      return;
    }

    if (this._textDragAction && e.pointerId === this._textDragAction.pointerId) {
      const { item } = this._textDragAction;
      this.callbacks.onUpdateText?.({
        id: item.id,
        text: item.text,
        x: item.x,
        y: item.y,
        color: item.color,
        fontSize: item.fontSize,
        layer: item.layer,
      });
      this._textDragAction = null;
      if (this.canvas.hasPointerCapture?.(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
      this._updateDefaultCursor();
      return;
    }

    if (this.isPanning) {
      this.isPanning = false;
      this._updateDefaultCursor();
      return;
    }

    if (!this.isDrawing || !this.currentStroke || e.pointerId !== this.activePointerId) return;

    this.isDrawing = false;
    this.activePointerId = null;
    if (this.canvas.hasPointerCapture?.(e.pointerId)) {
      this.canvas.releasePointerCapture(e.pointerId);
    }

    if (this.tool !== 'eraser') {
      this.strokes.push({ ...this.currentStroke });
    }

    this.callbacks.onStrokeEnd?.({
      ...this.currentStroke,
    });

    this.currentStroke = null;
  }

  cancelActiveStroke() {
    if (!this.isDrawing && !this.isPanning && !this._mediaAction && !this._textDragAction) return;
    this.isDrawing = false;
    this.isPanning = false;
    this._mediaAction = null;
    this._textDragAction = null;
    this.currentStroke = null;
    this.activePointerId = null;
    this._updateDefaultCursor();
  }

  _onWheel(e) {
    e.preventDefault();

    // Zooming is disabled; ignore pinch-to-zoom / Ctrl+wheel
    if (e.ctrlKey || e.metaKey) {
      return;
    }

    const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
    const dy = e.shiftKey && e.deltaX === 0 ? 0 : e.deltaY;
    this.transform.x -= dx;
    this.transform.y -= dy;

    this._updateActiveTextInputPosition();
    this._notifyViewportChange();
  }

  _handleErase(point) {
    const eraserRadius = this.size * 3;
    const toErase = [];

    this.strokes.forEach((stroke) => {
      for (const p of stroke.points) {
        const dx = p.x - point.x;
        const dy = p.y - point.y;
        if (dx * dx + dy * dy < eraserRadius * eraserRadius) {
          toErase.push(stroke.id);
          break;
        }
      }
    });

    if (toErase.length > 0) {
      this.strokes = this.strokes.filter((s) => !toErase.includes(s.id));
      this.callbacks.onErase?.({ strokeIds: toErase, layer: this.layer });
    }

    // Also erase text items touched by the eraser
    const textToErase = [];
    this.textItems.forEach((item) => {
      const bounds = this._getTextItemBounds(item);
      if (
        point.x + eraserRadius >= bounds.x &&
        point.x - eraserRadius <= bounds.x + bounds.width &&
        point.y + eraserRadius >= bounds.y &&
        point.y - eraserRadius <= bounds.y + bounds.height
      ) {
        textToErase.push(item.id);
      }
    });

    if (textToErase.length > 0) {
      this.textItems = this.textItems.filter((t) => !textToErase.includes(t.id));
      textToErase.forEach((id) => this.callbacks.onRemoveText?.({ id }));
    }
  }

  // --- Viewport sharing ---

  _getViewportRect() {
    const viewW = this.canvas.clientWidth;
    const viewH = this.canvas.clientHeight;
    return {
      x: -this.transform.x / this.transform.scale,
      y: -this.transform.y / this.transform.scale,
      width: viewW / this.transform.scale,
      height: viewH / this.transform.scale,
    };
  }

  _notifyViewportChange() {
    if (this._viewportThrottle) return;
    this._viewportThrottle = true;
    setTimeout(() => {
      this._viewportThrottle = false;
      this.callbacks.onViewportChange?.(this._getViewportRect());
    }, 50);
  }

  updateRemoteViewport(userId, { x, y, width, height, name, color }) {
    this.remoteViewports.set(userId, { x, y, width, height, name, color, timestamp: Date.now() });
  }

  removeRemoteViewport(userId) {
    this.remoteViewports.delete(userId);
  }

  _drawRemoteViewports() {
    const { ctx } = this;
    const now = Date.now();

    this.remoteViewports.forEach((vp, userId) => {
      // Fade out after 4 seconds of no updates
      const age = now - vp.timestamp;
      if (age > 6000) {
        this.remoteViewports.delete(userId);
        return;
      }
      const fadeAlpha = age > 4000 ? 1 - (age - 4000) / 2000 : 1;

      ctx.save();
      ctx.globalAlpha = 0.5 * fadeAlpha;

      // Draw viewport rectangle outline
      ctx.strokeStyle = vp.color;
      ctx.lineWidth = 2 / this.transform.scale;
      ctx.setLineDash([6 / this.transform.scale, 4 / this.transform.scale]);
      ctx.strokeRect(vp.x, vp.y, vp.width, vp.height);
      ctx.setLineDash([]);

      // Draw label at top-left of viewport
      const fontSize = Math.max(12, 14 / this.transform.scale);
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      const label = vp.name || 'User';
      const metrics = ctx.measureText(label);
      const padding = 4 / this.transform.scale;
      const labelH = fontSize + padding * 2;
      const labelW = metrics.width + padding * 2;

      // Label background
      ctx.globalAlpha = 0.7 * fadeAlpha;
      ctx.fillStyle = vp.color;
      ctx.beginPath();
      ctx.roundRect(vp.x, vp.y - labelH, labelW, labelH, 3 / this.transform.scale);
      ctx.fill();

      // Label text
      ctx.globalAlpha = fadeAlpha;
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(label, vp.x + padding, vp.y - padding);

      ctx.restore();
    });
  }

  // --- Scrollbars ---

  _getContentBounds() {
    // Compute bounding box of all stroke points, with padding
    const PADDING = Math.max(this.canvas.clientHeight || 800, 1200);
    const viewW = this.canvas.clientWidth;
    const viewH = this.canvas.clientHeight;
    const vp = this._getViewportRect();

    // Default content area: at least the visible viewport at identity transform and current viewport
    let minX = Math.min(0, vp.x), minY = Math.min(0, vp.y), maxX = Math.max(viewW, vp.x + vp.width), maxY = Math.max(viewH, vp.y + vp.height);

    for (const stroke of this.strokes) {
      if (!stroke.points) continue;
      for (const p of stroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }

    if (this.currentStroke?.points) {
      for (const p of this.currentStroke.points) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }

    for (const item of this.textItems) {
      if (item.x < minX) minX = item.x;
      if (item.y < minY) minY = item.y;
      const lines = item.text.split('\n');
      const estWidth = item.fontSize * lines.reduce((max, l) => Math.max(max, l.length), 0) * 0.6;
      const estHeight = item.fontSize * 1.2 * lines.length;
      if (item.x + estWidth > maxX) maxX = item.x + estWidth;
      if (item.y + estHeight > maxY) maxY = item.y + estHeight;
    }

    for (const item of this.mediaItems) {
      if (item.type === 'image') {
        if (item.x < minX) minX = item.x;
        if (item.y < minY) minY = item.y;
        if (item.x + item.width > maxX) maxX = item.x + item.width;
        if (item.y + item.height > maxY) maxY = item.y + item.height;
      }
    }

    return {
      minX: minX - PADDING,
      minY: minY - PADDING,
      maxX: maxX + PADDING,
      maxY: maxY + PADDING,
    };
  }

  _setupScrollbars() {
    if (!this._thumbV || !this._thumbH) return;

    // Vertical scrollbar drag
    this._setupScrollbarDrag(this._thumbV, this._scrollbarV, 'y');
    // Horizontal scrollbar drag
    this._setupScrollbarDrag(this._thumbH, this._scrollbarH, 'x');

    // Click on scrollbar track to jump
    this._scrollbarV.addEventListener('pointerdown', (e) => {
      if (e.target === this._scrollbarV) this._scrollbarTrackClick(e, 'y');
    });
    this._scrollbarH.addEventListener('pointerdown', (e) => {
      if (e.target === this._scrollbarH) this._scrollbarTrackClick(e, 'x');
    });
  }

  _setupScrollbarDrag(thumb, track, axis) {
    let dragging = false;
    let startPos = 0;
    let startTransform = 0;

    thumb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      thumb.classList.add('active');
      track.classList.add('dragging');
      startPos = axis === 'y' ? e.clientY : e.clientX;
      startTransform = axis === 'y' ? this.transform.y : this.transform.x;
      thumb.setPointerCapture(e.pointerId);
    });

    thumb.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      e.preventDefault();
      const bounds = this._getContentBounds();
      const scale = this.transform.scale;
      const viewSize = axis === 'y' ? this.canvas.clientHeight : this.canvas.clientWidth;
      const contentSize = axis === 'y' ? (bounds.maxY - bounds.minY) : (bounds.maxX - bounds.minX);
      const totalContentPx = contentSize * scale;
      const trackSize = axis === 'y' ? track.clientHeight : track.clientWidth;

      const delta = (axis === 'y' ? e.clientY : e.clientX) - startPos;
      // Map track pixels to canvas pan pixels
      const panDelta = -(delta / trackSize) * totalContentPx;
      if (axis === 'y') {
        this.transform.y = startTransform + panDelta;
      } else {
        this.transform.x = startTransform + panDelta;
      }
      this._notifyViewportChange();
    });

    const stopDrag = () => {
      if (!dragging) return;
      dragging = false;
      thumb.classList.remove('active');
      track.classList.remove('dragging');
    };
    thumb.addEventListener('pointerup', stopDrag);
    thumb.addEventListener('pointercancel', stopDrag);
  }

  _scrollbarTrackClick(e, axis) {
    const bounds = this._getContentBounds();
    const scale = this.transform.scale;
    const track = axis === 'y' ? this._scrollbarV : this._scrollbarH;
    const rect = track.getBoundingClientRect();
    const clickPos = axis === 'y' ? (e.clientY - rect.top) : (e.clientX - rect.left);
    const trackSize = axis === 'y' ? rect.height : rect.width;
    const ratio = clickPos / trackSize;

    const contentMin = axis === 'y' ? bounds.minY : bounds.minX;
    const contentMax = axis === 'y' ? bounds.maxY : bounds.maxX;
    const viewSize = axis === 'y' ? this.canvas.clientHeight : this.canvas.clientWidth;

    // Set pan so that the clicked ratio maps to the center of the viewport
    const targetContent = contentMin + ratio * (contentMax - contentMin);
    if (axis === 'y') {
      this.transform.y = -targetContent * scale + viewSize / 2;
    } else {
      this.transform.x = -targetContent * scale + viewSize / 2;
    }
    this._notifyViewportChange();
  }

  _updateScrollbars() {
    if (!this._thumbV || !this._thumbH) return;

    const bounds = this._getContentBounds();
    const scale = this.transform.scale;
    const viewW = this.canvas.clientWidth;
    const viewH = this.canvas.clientHeight;

    // Content range in screen pixels
    const contentW = (bounds.maxX - bounds.minX) * scale;
    const contentH = (bounds.maxY - bounds.minY) * scale;

    // Viewport position within content (in screen pixels)
    const viewLeft = -(this.transform.x + bounds.minX * scale);
    const viewTop = -(this.transform.y + bounds.minY * scale);

    // Vertical scrollbar
    const totalH = Math.max(contentH, viewH);
    const thumbHRatio = Math.min(1, viewH / totalH);
    const thumbTopRatio = viewTop / totalH;
    const trackH = this._scrollbarV.clientHeight;
    this._thumbV.style.height = `${Math.max(30, thumbHRatio * trackH)}px`;
    this._thumbV.style.transform = `translateY(${Math.max(0, Math.min(trackH - 30, thumbTopRatio * trackH))}px)`;

    // Horizontal scrollbar
    const totalW = Math.max(contentW, viewW);
    const thumbWRatio = Math.min(1, viewW / totalW);
    const thumbLeftRatio = viewLeft / totalW;
    const trackW = this._scrollbarH.clientWidth;
    this._thumbH.style.width = `${Math.max(30, thumbWRatio * trackW)}px`;
    this._thumbH.style.transform = `translateX(${Math.max(0, Math.min(trackW - 30, thumbLeftRatio * trackW))}px)`;

    // Hide scrollbars when everything fits
    this._scrollbarV.style.visibility = thumbHRatio >= 0.99 ? 'hidden' : 'visible';
    this._scrollbarH.style.visibility = thumbWRatio >= 0.99 ? 'hidden' : 'visible';
  }

  // --- Rendering ---

  _startRenderLoop() {
    this._alive = true;
    const render = () => {
      if (!this._alive) return;
      this._render();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }

  destroy() {
    this._alive = false;
    this.cancelActiveStroke();
  }

  _render() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;

    const targetW = Math.round(canvas.clientWidth * dpr);
    const targetH = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Apply DPR and pan/zoom
    ctx.setTransform(
      this.transform.scale * dpr,
      0,
      0,
      this.transform.scale * dpr,
      this.transform.x * dpr,
      this.transform.y * dpr
    );
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Draw cursive practice guides (underneath everything so user traces on top)
    this._drawCursivePractices();

    // Draw media items (images) under strokes so annotations appear on top
    this._drawMediaItems();

    // Draw all completed strokes
    this._pruneStaleRemoteStrokes();
    for (const stroke of this.strokes) {
      this._drawStroke(stroke);
    }

    // Draw current in-progress stroke
    if (this.currentStroke && this.tool !== 'eraser') {
      this._drawStroke(this.currentStroke);
    }

    // Draw text items
    this._drawTextItems();

    // Draw interactive selection/hover controls for images
    this._drawMediaControls();

    // Draw remote viewports
    this._drawRemoteViewports();

    // Draw remote cursors
    this._drawRemoteCursors();

    // Update scrollbar positions
    this._updateScrollbars();
  }

  _drawStroke(stroke) {
    const { ctx } = this;
    if (!stroke.points || stroke.points.length === 0) return;

    ctx.save();
    ctx.globalAlpha = stroke.opacity ?? 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (stroke.tool === 'highlighter') {
      ctx.globalCompositeOperation = 'multiply';
    }

    if (stroke.points.length === 1) {
      // Single dot
      const p = stroke.points[0];
      const r = (stroke.size * (p.pressure || 0.5)) / 2;
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    if (stroke.tool === 'pencil') {
      this._drawPencilStroke(stroke);
    } else {
      this._drawSmoothStroke(stroke);
    }

    ctx.restore();
  }

  _drawSmoothStroke(stroke) {
    const { ctx } = this;
    const points = stroke.points;

    // Calculate average pressure for line width
    let avgPressure = 0;
    for (const p of points) avgPressure += (p.pressure || 0.5);
    avgPressure /= points.length;
    const width = Math.max(1, stroke.size * avgPressure);

    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
    } else {
      // Draw smooth quadratic bezier through midpoints
      for (let i = 1; i < points.length - 1; i++) {
        const mid = {
          x: (points[i].x + points[i + 1].x) / 2,
          y: (points[i].y + points[i + 1].y) / 2,
        };
        ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
      }
      // Connect to the last point
      const last = points[points.length - 1];
      ctx.lineTo(last.x, last.y);
    }

    ctx.stroke();
  }

  _drawPencilStroke(stroke) {
    const { ctx } = this;
    const points = stroke.points;

    // Average pressure for consistent width
    let avgPressure = 0;
    for (const p of points) avgPressure += (p.pressure || 0.5);
    avgPressure /= points.length;
    const width = Math.max(1, stroke.size * avgPressure);

    // Base continuous stroke
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = width;
    ctx.globalAlpha = (stroke.opacity ?? 1) * (0.6 + avgPressure * 0.4);
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    if (points.length === 2) {
      ctx.lineTo(points[1].x, points[1].y);
    } else {
      for (let i = 1; i < points.length - 1; i++) {
        const mid = {
          x: (points[i].x + points[i + 1].x) / 2,
          y: (points[i].y + points[i + 1].y) / 2,
        };
        ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
      }
      ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
    }
    ctx.stroke();

    // Grain texture overlay
    ctx.globalAlpha = (stroke.opacity ?? 1) * 0.15;
    ctx.fillStyle = stroke.color;
    const seed = this._hashString(stroke.id || `${points[0].x},${points[0].y}`);
    for (let i = 1; i < points.length; i += 2) {
      const prev = points[i - 1];
      const curr = points[i];
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let grainIndex = 0;
      for (let j = 0; j < dist; j += 3) {
        const t = j / dist;
        const noiseX = this._noise(seed + i * 73856093 + grainIndex * 19349663);
        const noiseY = this._noise(seed + i * 83492791 + grainIndex * 2971215073);
        const x = prev.x + dx * t + (noiseX - 0.5) * width;
        const y = prev.y + dy * t + (noiseY - 0.5) * width;
        ctx.fillRect(x, y, 1, 1);
        grainIndex++;
      }
    }
    ctx.globalAlpha = stroke.opacity ?? 1;
  }

  _hashString(value) {
    let hash = 2166136261;
    const text = String(value);
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  _noise(seed) {
    let value = seed >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 2246822507);
    value ^= value >>> 13;
    value = Math.imul(value, 3266489909);
    value ^= value >>> 16;
    return (value >>> 0) / 4294967295;
  }

  _drawRemoteCursors() {
    const { ctx } = this;
    this.remoteCursors.forEach((cursor) => {
      ctx.save();
      ctx.globalAlpha = 0.8;

      // Cursor dot
      ctx.fillStyle = cursor.color;
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, 5, 0, Math.PI * 2);
      ctx.fill();

      // Name label
      ctx.font = '12px Inter, system-ui, sans-serif';
      ctx.fillStyle = cursor.color;
      const metrics = ctx.measureText(cursor.name);

      // Background
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      const padding = 4;
      ctx.beginPath();
      ctx.roundRect(
        cursor.x + 10,
        cursor.y - 8,
        metrics.width + padding * 2,
        18,
        4
      );
      ctx.fill();

      // Text
      ctx.fillStyle = cursor.color;
      ctx.fillText(cursor.name, cursor.x + 10 + padding, cursor.y + 5);

      ctx.restore();
    });
  }

  // --- Text tool ---

  _getTextItemBounds(item) {
    const lines = (item.text || '').split('\n');
    const fontSize = item.fontSize || 20;
    this.ctx.save();
    this.ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
    let maxWidth = 0;
    for (const line of lines) {
      const w = this.ctx.measureText(line).width;
      if (w > maxWidth) maxWidth = w;
    }
    this.ctx.restore();
    return {
      x: item.x,
      y: item.y,
      width: Math.max(20, maxWidth),
      height: Math.max(fontSize, lines.length * fontSize * 1.2),
    };
  }

  _findTextItemAt(point) {
    for (let i = this.textItems.length - 1; i >= 0; i--) {
      const item = this.textItems[i];
      const b = this._getTextItemBounds(item);
      if (
        point.x >= b.x - 6 &&
        point.x <= b.x + b.width + 6 &&
        point.y >= b.y - 6 &&
        point.y <= b.y + b.height + 6
      ) {
        return item;
      }
    }
    return null;
  }

  _updateActiveTextInputPosition() {
    if (!this._activeTextInput || !this._activeTextPoint) return;
    const rect = this.canvas.getBoundingClientRect();
    const screenX = this._activeTextPoint.x * this.transform.scale + this.transform.x + rect.left;
    const screenY = this._activeTextPoint.y * this.transform.scale + this.transform.y + rect.top;
    this._activeTextInput.style.left = `${Math.round(screenX)}px`;
    this._activeTextInput.style.top = `${Math.round(screenY)}px`;
  }

  _resizeActiveTextInput() {
    const input = this._activeTextInput;
    if (!input) return;
    const fontSize = (this._activeTextFontSize || 20) * this.transform.scale;
    const lines = (input.value || input.placeholder || 'Type here...').split('\n');

    this.ctx.save();
    this.ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
    let maxW = 0;
    for (const line of lines) {
      const w = this.ctx.measureText(line || ' ').width;
      if (w > maxW) maxW = w;
    }
    this.ctx.restore();

    const width = Math.max(140, Math.ceil(maxW + 28));
    const height = Math.max(Math.ceil(fontSize * 1.35), Math.ceil(lines.length * fontSize * 1.2 + 10));
    input.style.width = `${width}px`;
    input.style.height = `${height}px`;
  }

  startTypingWithChar(initialChar = '') {
    if (this._activeTextInput) {
      this._activeTextInput.focus();
      if (initialChar) {
        const start = this._activeTextInput.selectionStart ?? this._activeTextInput.value.length;
        const end = this._activeTextInput.selectionEnd ?? this._activeTextInput.value.length;
        const val = this._activeTextInput.value;
        this._activeTextInput.value = val.slice(0, start) + initialChar + val.slice(end);
        this._activeTextInput.selectionStart = this._activeTextInput.selectionEnd = start + initialChar.length;
        this._resizeActiveTextInput();
      }
      return;
    }

    const vp = this._getViewportRect();
    let point = this.lastCursorPoint;
    if (
      !point ||
      point.x < vp.x ||
      point.x > vp.x + vp.width ||
      point.y < vp.y ||
      point.y > vp.y + vp.height
    ) {
      point = {
        x: Math.round(vp.x + vp.width * 0.35),
        y: Math.round(vp.y + vp.height * 0.4),
      };
    }

    this._openTextInput(point, { initialText: initialChar });
  }

  _openTextInput(point, options = {}) {
    // Commit any existing text input before opening a new one
    this._commitTextInput();

    const { editingItem = null, initialText = '' } = options;
    const rect = this.canvas.getBoundingClientRect();
    const screenX = point.x * this.transform.scale + this.transform.x + rect.left;
    const screenY = point.y * this.transform.scale + this.transform.y + rect.top;
    const fontSize = editingItem ? editingItem.fontSize : Math.max(20, this.size * 5);
    const textColor = editingItem ? editingItem.color : this.color;

    const input = document.createElement('textarea');
    input.className = 'canvas-text-input';
    input.placeholder = 'Type here...';
    input.style.left = `${Math.round(screenX)}px`;
    input.style.top = `${Math.round(screenY)}px`;
    input.style.fontSize = `${fontSize * this.transform.scale}px`;
    input.style.color = textColor;
    input.style.caretColor = textColor;
    input.style.fontFamily = 'Inter, system-ui, sans-serif';
    input.rows = 1;
    input.value = editingItem ? editingItem.text : initialText;

    this._activeTextInput = input;
    this._activeTextPoint = { x: Math.round(point.x), y: Math.round(point.y) };
    this._activeTextFontSize = fontSize;
    this._activeTextColor = textColor;
    this._editingTextItem = editingItem;
    this._editingTextId = editingItem ? editingItem.id : null;

    document.body.appendChild(input);
    this._resizeActiveTextInput();

    const focusInput = () => {
      if (this._activeTextInput !== input) return;
      input.focus();
      const len = input.value.length;
      input.setSelectionRange(len, len);
    };

    focusInput();
    let readyToCommit = false;
    requestAnimationFrame(() => {
      focusInput();
      setTimeout(() => {
        readyToCommit = true;
      }, 60);
    });

    input.addEventListener('input', () => {
      this._resizeActiveTextInput();
    });

    input.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
    });

    const onBlur = () => {
      if (!readyToCommit) {
        focusInput();
        return;
      }
      this._commitTextInput();
    };

    this._activeTextBlurHandler = onBlur;
    input.addEventListener('blur', onBlur);

    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') {
        ev.preventDefault();
        this._commitTextInput();
      } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        this._commitTextInput();
      }
    });
  }

  _commitTextInput() {
    if (!this._activeTextInput) return;

    const input = this._activeTextInput;
    if (this._activeTextBlurHandler) {
      input.removeEventListener('blur', this._activeTextBlurHandler);
      this._activeTextBlurHandler = null;
    }

    const rawText = input.value.replace(/\r\n/g, '\n');
    const trimmed = rawText.trim();
    const point = this._activeTextPoint;
    const fontSize = this._activeTextFontSize || Math.max(20, this.size * 5);
    const color = this._activeTextColor || this.color;
    const editingItem = this._editingTextItem;

    this._closeTextInput();

    if (editingItem) {
      if (trimmed) {
        editingItem.text = rawText;
        editingItem.color = color;
        editingItem.fontSize = fontSize;
        this.callbacks.onUpdateText?.({
          id: editingItem.id,
          text: editingItem.text,
          x: editingItem.x,
          y: editingItem.y,
          color: editingItem.color,
          fontSize: editingItem.fontSize,
          layer: editingItem.layer,
        });
      } else {
        this.textItems = this.textItems.filter((t) => t.id !== editingItem.id);
        this.callbacks.onRemoveText?.({ id: editingItem.id });
      }
    } else if (trimmed) {
      const textItem = {
        id: `txt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        text: rawText,
        x: point.x,
        y: point.y,
        color,
        fontSize,
        layer: this.layer,
      };
      this.textItems.push(textItem);
      this.callbacks.onAddText?.(textItem);
    }
  }

  _closeTextInput() {
    if (this._activeTextInput) {
      if (this._activeTextBlurHandler) {
        this._activeTextInput.removeEventListener('blur', this._activeTextBlurHandler);
        this._activeTextBlurHandler = null;
      }
      this._activeTextInput.remove();
      this._activeTextInput = null;
      this._activeTextPoint = null;
      this._editingTextItem = null;
      this._editingTextId = null;
    }
  }

  _drawTextItems() {
    const { ctx } = this;
    for (const item of this.textItems) {
      if (this._editingTextId && item.id === this._editingTextId) continue;
      ctx.save();
      ctx.fillStyle = item.color;
      ctx.font = `500 ${item.fontSize}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = 'top';

      // Draw each line
      const lines = item.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], item.x + 4, item.y + 2 + i * item.fontSize * 1.2);
      }
      ctx.restore();
    }
  }

  // --- Cursive Practice ---

  _drawCursivePractices() {
    const { ctx } = this;
    for (const item of this.cursivePractices) {
      if (!item.visible) continue;

      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `italic ${item.fontSize}px 'Segoe Script', 'Dancing Script', 'Brush Script MT', cursive, serif`;
      ctx.textBaseline = 'top';

      // Draw each character with spacing
      const chars = item.text.split('');
      let xOffset = 0;
      for (const char of chars) {
        ctx.fillText(char, item.x + xOffset, item.y);
        xOffset += ctx.measureText(char).width;
      }

      // Draw baseline guide
      ctx.globalAlpha = 0.1;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      const baselineY = item.y + item.fontSize * 0.85;
      ctx.beginPath();
      ctx.moveTo(item.x - 10, baselineY);
      ctx.lineTo(item.x + xOffset + 10, baselineY);
      ctx.stroke();

      // Draw midline guide
      const midlineY = item.y + item.fontSize * 0.45;
      ctx.beginPath();
      ctx.moveTo(item.x - 10, midlineY);
      ctx.lineTo(item.x + xOffset + 10, midlineY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.restore();
    }
  }

  addCursivePractice(item) {
    this.cursivePractices.push(item);
  }

  removeCursivePractice(id) {
    this.cursivePractices = this.cursivePractices.filter(p => p.id !== id);
  }

  // --- Public API ---

  setTool(tool) {
    if (this.tool === 'text' && tool !== 'text') {
      this._commitTextInput();
    }
    this.tool = tool;
  }

  setColor(color) {
    this.color = color;
    if (this._activeTextInput) {
      this._activeTextColor = color;
      this._activeTextInput.style.color = color;
      this._activeTextInput.style.caretColor = color;
      this._activeTextInput.focus();
    }
  }

  setSize(size) {
    this.size = size;
    if (this._activeTextInput) {
      const fontSize = Math.max(20, size * 5);
      this._activeTextFontSize = fontSize;
      this._activeTextInput.style.fontSize = `${fontSize * this.transform.scale}px`;
      this._resizeActiveTextInput();
      this._activeTextInput.focus();
    }
  }

  setLayer(layer) {
    this.layer = layer;
  }

  setStrokes(strokes) {
    this.clearTransientStrokes();
    // Deduplicate by stroke ID to prevent double rendering
    const seen = new Set();
    this.strokes = strokes.filter((s) => {
      if (!s.id || seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }

  addStroke(stroke) {
    this.strokes.push(stroke);
  }

  removeStrokes(strokeIds) {
    this.strokes = this.strokes.filter((s) => !strokeIds.includes(s.id));
  }

  // Media management
  addMedia(item) {
    this.mediaItems.push(item);
    if (item.type === 'image') {
      this._loadImage(item.url, item.dataUrl);
      this.selectedMediaId = item.id;
    }
  }

  removeMedia(id) {
    this.mediaItems = this.mediaItems.filter((m) => m.id !== id);
    if (this.selectedMediaId === id) this.selectedMediaId = null;
    if (this.hoveredMediaId === id) this.hoveredMediaId = null;
  }

  setMedia(items) {
    this.mediaItems = items;
    for (const item of items) {
      if (item.type === 'image') {
        this._loadImage(item.url, item.dataUrl);
      }
    }
  }

  _loadImage(url, fallbackDataUrl = null) {
    if (this._imageCache.has(url)) return;
    const img = new Image();
    if (fallbackDataUrl && fallbackDataUrl !== url) {
      img.onerror = () => {
        img.onerror = null;
        img.src = fallbackDataUrl;
      };
    }
    img.src = url;
    this._imageCache.set(url, img);
  }

  _drawMediaItems() {
    const { ctx } = this;
    for (const item of this.mediaItems) {
      if (item.type === 'image') {
        const img = this._imageCache.get(item.url);
        if (img && img.complete && img.naturalWidth) {
          ctx.save();
          ctx.globalAlpha = 1;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, Math.round(item.x), Math.round(item.y), Math.round(item.width), Math.round(item.height));
          ctx.restore();
        }
      }
      // YouTube items are rendered as DOM overlays, not on canvas
    }
  }

  _drawMediaControls() {
    const { ctx } = this;
    for (const item of this.mediaItems) {
      if (item.type !== 'image') continue;
      const isSelected = item.id === this.selectedMediaId;
      const isHovered = item.id === this.hoveredMediaId;
      if (!isSelected && !isHovered) continue;

      const x = Math.round(item.x);
      const y = Math.round(item.y);
      const w = Math.round(item.width);
      const h = Math.round(item.height);
      const canManipulate = !item.locked || this.tool === 'select';

      ctx.save();

      if (canManipulate) {
        // Selection / hover border
        ctx.strokeStyle = isSelected ? '#7C3AED' : 'rgba(124, 58, 237, 0.75)';
        ctx.lineWidth = isSelected ? 2 : 1.5;
        ctx.strokeRect(x, y, w, h);

        // 4 corner resize handles
        const handleSize = 10;
        const corners = [
          [x, y],
          [x + w, y],
          [x, y + h],
          [x + w, y + h],
        ];
        for (const [cx, cy] of corners) {
          ctx.fillStyle = '#FFFFFF';
          ctx.strokeStyle = '#7C3AED';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.rect(cx - handleSize / 2, cy - handleSize / 2, handleSize, handleSize);
          ctx.fill();
          ctx.stroke();
        }
      }

      // Top-right action buttons (Lock/Draw toggle + Delete)
      const { lockRect, deleteRect } = this._getMediaControlRects(item);

      // Lock / Draw Over button
      ctx.fillStyle = item.locked ? 'rgba(124, 58, 237, 0.92)' : 'rgba(15, 15, 26, 0.85)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(lockRect.x, lockRect.y, lockRect.w, lockRect.h, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 11px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        item.locked ? 'Unlock to Move' : 'Lock to Draw',
        lockRect.x + lockRect.w / 2,
        lockRect.y + lockRect.h / 2
      );

      // Delete button
      ctx.fillStyle = 'rgba(239, 68, 68, 0.92)';
      ctx.beginPath();
      ctx.roundRect(deleteRect.x, deleteRect.y, deleteRect.w, deleteRect.h, 6);
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 13px Inter, system-ui, sans-serif';
      ctx.fillText('✕', deleteRect.x + deleteRect.w / 2, deleteRect.y + deleteRect.h / 2);

      ctx.restore();
    }
  }

  // Text management
  addText(item) {
    this.textItems.push(item);
  }

  removeText(id) {
    this.textItems = this.textItems.filter((t) => t.id !== id);
  }

  setTextItems(items) {
    this.textItems = items || [];
  }

  clearStrokes() {
    this.strokes = [];
    this.clearTransientStrokes();
  }

  updateRemoteCursor(userId, { x, y, name, color }) {
    this.remoteCursors.set(userId, { x, y, name, color });
  }

  removeRemoteCursor(userId) {
    this.remoteCursors.delete(userId);
  }

  resetView() {
    this.transform = { x: 0, y: 0, scale: 1 };
    this._updateActiveTextInputPosition();
    this._notifyViewportChange();
  }

  clearTransientStrokes() {
    this.cancelActiveStroke();
    if (this._remoteStrokes) {
      const remoteIds = new Set([...this._remoteStrokes.values()].map((stroke) => stroke.id));
      this.strokes = this.strokes.filter((stroke) => !remoteIds.has(stroke.id));
      this._remoteStrokes.clear();
    }
  }

  removeRemoteUserStrokes(userId) {
    if (!this._remoteStrokes) return;
    for (const [key, stroke] of this._remoteStrokes.entries()) {
      if (stroke.userId === userId) {
        this.strokes = this.strokes.filter((s) => s.id !== stroke.id);
        this._remoteStrokes.delete(key);
      }
    }
  }

  _pruneStaleRemoteStrokes() {
    if (!this._remoteStrokes) return;
    const now = Date.now();
    for (const [key, stroke] of this._remoteStrokes.entries()) {
      if (now - stroke.lastUpdated > 10000) {
        this.strokes = this.strokes.filter((s) => s.id !== stroke.id);
        this._remoteStrokes.delete(key);
      }
    }
  }

  // Handle remote stroke events for live drawing
  handleRemoteStrokeStart(data) {
    // Start building a remote stroke
    if (!this._remoteStrokes) this._remoteStrokes = new Map();
    const key = data.id || data.userId;
    const previous = this._remoteStrokes.get(key);
    if (previous) {
      this.strokes = this.strokes.filter((s) => s.id !== previous.id);
    }
    this._remoteStrokes.set(key, {
      id: data.id,
      tool: data.tool,
      color: data.color,
      size: data.size,
      opacity: data.opacity,
      points: [data.point],
      layer: data.layer,
      userId: data.userId,
      lastUpdated: Date.now(),
    });
    // Add to strokes for live rendering
    this.strokes.push(this._remoteStrokes.get(key));
  }

  handleRemoteStrokeMove(data) {
    if (!this._remoteStrokes) return;
    const key = data.id || data.userId;
    const stroke = this._remoteStrokes.get(key);
    if (stroke) {
      stroke.points.push(data.point);
      stroke.lastUpdated = Date.now();
    }
  }

  handleRemoteStrokeEnd(data) {
    if (!this._remoteStrokes) return;
    const key = data.id || data.userId;
    const existing = this._remoteStrokes.get(key);
    if (existing) {
      // Remove the live-building stroke
      this.strokes = this.strokes.filter((s) => s.id !== existing.id);
    }
    this._remoteStrokes.delete(key);
    // Add the final stroke (skip if already present, e.g. from setStrokes)
    if (data.tool !== 'eraser' && !this.strokes.some((s) => s.id === data.id)) {
      this.strokes.push(data);
    }
  }
}
