/**
 * Drawing engine with pressure-sensitive pen, pencil, and eraser support.
 * Supports Wacom, XP-Pen tablets and mouse input via Pointer Events API.
 */

export class DrawingEngine {
  constructor(canvas, { onStrokeStart, onStrokeMove, onStrokeEnd, onErase, onCursorMove }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.callbacks = { onStrokeStart, onStrokeMove, onStrokeEnd, onErase, onCursorMove };

    // State
    this.isDrawing = false;
    this.currentStroke = null;
    this.tool = 'pen';        // pen | pencil | eraser | highlighter
    this.color = '#FFFFFF';
    this.size = 3;
    this.opacity = 1;
    this.layer = 'whiteboard'; // whiteboard | pdf

    // All strokes stored locally for rendering
    this.strokes = [];
    this.strokeIdCounter = 0;

    // Pan & zoom
    this.transform = { x: 0, y: 0, scale: 1 };
    this.isPanning = false;
    this.panStart = { x: 0, y: 0 };

    // Remote cursors
    this.remoteCursors = new Map();

    // Offscreen canvas for pencil texture
    this.pencilPattern = this._createPencilPattern();

    this._setupEvents();
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
    this.canvas.addEventListener('pointerleave', (e) => this._onPointerUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));

    // Prevent default touch behaviors for tablet
    this.canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    this.canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

    // Zoom with wheel
    this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });

    // Context menu disable
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _getCanvasPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - this.transform.x) / this.transform.scale,
      y: (e.clientY - rect.top - this.transform.y) / this.transform.scale,
    };
  }

  _onPointerDown(e) {
    // Middle mouse button or space+click for panning
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      this.isPanning = true;
      this.panStart = { x: e.clientX - this.transform.x, y: e.clientY - this.transform.y };
      this.canvas.style.cursor = 'grabbing';
      return;
    }

    if (e.button !== 0) return;

    const point = this._getCanvasPoint(e);
    const pressure = e.pressure !== undefined && e.pressure > 0 ? e.pressure : 0.5;

    this.isDrawing = true;
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

    // Cursor tracking
    this.callbacks.onCursorMove?.({ x: point.x, y: point.y });

    if (this.isPanning) {
      this.transform.x = e.clientX - this.panStart.x;
      this.transform.y = e.clientY - this.panStart.y;
      return;
    }

    if (!this.isDrawing || !this.currentStroke) return;

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
    if (this.isPanning) {
      this.isPanning = false;
      this.canvas.style.cursor = '';
      return;
    }

    if (!this.isDrawing || !this.currentStroke) return;

    this.isDrawing = false;

    if (this.tool !== 'eraser') {
      this.strokes.push({ ...this.currentStroke });
    }

    this.callbacks.onStrokeEnd?.({
      ...this.currentStroke,
    });

    this.currentStroke = null;
  }

  _onWheel(e) {
    e.preventDefault();
    const scaleFactor = e.deltaY > 0 ? 0.95 : 1.05;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const newScale = Math.max(0.1, Math.min(5, this.transform.scale * scaleFactor));
    const ratio = newScale / this.transform.scale;
    this.transform.x = mx - ratio * (mx - this.transform.x);
    this.transform.y = my - ratio * (my - this.transform.y);
    this.transform.scale = newScale;
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
  }

  // --- Rendering ---

  _startRenderLoop() {
    const render = () => {
      this._render();
      requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  }

  _render() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== canvas.clientWidth * dpr || canvas.height !== canvas.clientHeight * dpr) {
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
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

    // Draw all completed strokes
    for (const stroke of this.strokes) {
      this._drawStroke(stroke);
    }

    // Draw current in-progress stroke
    if (this.currentStroke && this.tool !== 'eraser') {
      this._drawStroke(this.currentStroke);
    }

    // Draw remote cursors
    this._drawRemoteCursors();
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
    for (let i = 1; i < points.length; i += 2) {
      const prev = points[i - 1];
      const curr = points[i];
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      for (let j = 0; j < dist; j += 3) {
        const t = j / dist;
        const x = prev.x + dx * t + (Math.random() - 0.5) * width;
        const y = prev.y + dy * t + (Math.random() - 0.5) * width;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.globalAlpha = stroke.opacity ?? 1;
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

  // --- Public API ---

  setTool(tool) {
    this.tool = tool;
  }

  setColor(color) {
    this.color = color;
  }

  setSize(size) {
    this.size = size;
  }

  setLayer(layer) {
    this.layer = layer;
  }

  setStrokes(strokes) {
    this.strokes = strokes;
  }

  addStroke(stroke) {
    this.strokes.push(stroke);
  }

  removeStrokes(strokeIds) {
    this.strokes = this.strokes.filter((s) => !strokeIds.includes(s.id));
  }

  clearStrokes() {
    this.strokes = [];
  }

  updateRemoteCursor(userId, { x, y, name, color }) {
    this.remoteCursors.set(userId, { x, y, name, color });
  }

  removeRemoteCursor(userId) {
    this.remoteCursors.delete(userId);
  }

  resetView() {
    this.transform = { x: 0, y: 0, scale: 1 };
  }

  // Handle remote stroke events for live drawing
  handleRemoteStrokeStart(data) {
    // Start building a remote stroke
    if (!this._remoteStrokes) this._remoteStrokes = new Map();
    this._remoteStrokes.set(data.userId, {
      id: data.id,
      tool: data.tool,
      color: data.color,
      size: data.size,
      opacity: data.opacity,
      points: [data.point],
      layer: data.layer,
    });
    // Add to strokes for live rendering
    this.strokes.push(this._remoteStrokes.get(data.userId));
  }

  handleRemoteStrokeMove(data) {
    if (!this._remoteStrokes) return;
    const stroke = this._remoteStrokes.get(data.userId);
    if (stroke) {
      stroke.points.push(data.point);
    }
  }

  handleRemoteStrokeEnd(data) {
    if (!this._remoteStrokes) return;
    const existing = this._remoteStrokes.get(data.userId);
    if (existing) {
      // Remove the live-building stroke
      this.strokes = this.strokes.filter((s) => s.id !== existing.id);
    }
    this._remoteStrokes.delete(data.userId);
    // Add the final stroke
    if (data.tool !== 'eraser') {
      this.strokes.push(data);
    }
  }
}
