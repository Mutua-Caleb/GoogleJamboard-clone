/**
 * PDF viewer and annotation layer.
 *
 * Two modes:
 *  - 'images' (preferred): displays pre-rendered, compressed page bitmaps
 *    produced at upload time. Page flips are instant image swaps, with
 *    neighbouring pages prefetched and an LRU cache keeping memory bounded.
 *  - 'pdfjs' (legacy): renders the raw PDF with pdf.js, kept for jams saved
 *    before page pre-rendering existed.
 */

const DISPLAY_SCALE = 1.5;          // matches the legacy pdf.js render scale so saved strokes stay aligned
const PREFETCH_RADIUS = 3;          // pages to warm around the current one
const CACHE_LIMIT = 80;             // max cached page images
const FULL_PRELOAD_MAX_PAGES = 60;  // background-preload entire docs up to this size

export class PDFViewer {
  constructor(container, { onPageChange }) {
    this.container = container;
    this.onPageChange = onPageChange;

    this.mode = null; // 'images' | 'pdfjs'
    this.doc = null;  // image-mode document descriptor
    this.pdfDoc = null;
    this.currentPage = 1;
    this.totalPages = 0;
    this.scale = DISPLAY_SCALE;
    this.pdfCanvas = null;
    this.pdfCtx = null;
    this.rendering = false;
    this._imageCache = new Map(); // pageNum -> Promise<HTMLImageElement>
    this._destroyed = false;

    this._init();
  }

  _init() {
    // Create PDF render canvas (sits behind the drawing canvas)
    this.pdfCanvas = document.createElement('canvas');
    this.pdfCanvas.className = 'pdf-canvas';
    this.container.appendChild(this.pdfCanvas);
    this.pdfCtx = this.pdfCanvas.getContext('2d');
  }

  // ============================
  // Image-document mode
  // ============================

  async loadDoc(doc) {
    this.mode = 'images';
    this.doc = doc;
    this.totalPages = doc.pageCount;
    this.currentPage = 1;

    await this.renderPage(1);
    this._updatePageInfo();
    this._startBackgroundPreload();
    return { totalPages: this.totalPages };
  }

  async _renderImagePage(pageNum) {
    const page = this.doc?.pages?.[pageNum - 1];
    if (!page) return;
    this.rendering = true;

    try {
      const img = await this._getImage(pageNum);
      if (this._destroyed) return;

      // CSS size follows the page's scale-1 dimensions so annotations line up
      // with what pdf.js used to render; the backing store keeps the full
      // image resolution for crisp text.
      const cssW = Math.round((page.baseWidth || page.width) * this.scale);
      const cssH = Math.round((page.baseHeight || page.height) * this.scale);
      this.pdfCanvas.width = img.naturalWidth;
      this.pdfCanvas.height = img.naturalHeight;
      this.pdfCanvas.style.width = cssW + 'px';
      this.pdfCanvas.style.height = cssH + 'px';

      this.pdfCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.pdfCtx.drawImage(img, 0, 0);
      this.currentPage = pageNum;
    } finally {
      this.rendering = false;
    }

    this._prefetchAround(pageNum);
  }

  _getImage(pageNum) {
    const cached = this._imageCache.get(pageNum);
    if (cached) {
      // LRU bump
      this._imageCache.delete(pageNum);
      this._imageCache.set(pageNum, cached);
      return cached;
    }

    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => {
        this._imageCache.delete(pageNum);
        reject(new Error(`Failed to load page ${pageNum}`));
      };
      img.src = this.doc.pages[pageNum - 1].url;
    });
    this._imageCache.set(pageNum, promise);
    this._evictCache();
    return promise;
  }

  _evictCache() {
    for (const key of this._imageCache.keys()) {
      if (this._imageCache.size <= CACHE_LIMIT) break;
      if (key === this.currentPage) continue;
      this._imageCache.delete(key);
    }
  }

  _prefetchAround(pageNum) {
    if (this.mode !== 'images' || this._destroyed) return;
    for (let offset = 1; offset <= PREFETCH_RADIUS; offset++) {
      for (const n of [pageNum + offset, pageNum - offset]) {
        if (n >= 1 && n <= this.totalPages) {
          this._getImage(n).catch(() => {});
        }
      }
    }
  }

  async _startBackgroundPreload() {
    if (this.totalPages > FULL_PRELOAD_MAX_PAGES) return;
    for (let n = 1; n <= this.totalPages; n++) {
      if (this._destroyed || this.mode !== 'images') return;
      await this._getImage(n).catch(() => {});
    }
  }

  // ============================
  // Legacy pdf.js mode
  // ============================

  async loadPDF(url) {
    this.mode = 'pdfjs';

    const { loadPdfjs } = await import('./pdf-processor.js');
    const pdfjsLib = await loadPdfjs();

    const loadingTask = pdfjsLib.getDocument(url);
    this.pdfDoc = await loadingTask.promise;
    this.totalPages = this.pdfDoc.numPages;
    this.currentPage = 1;

    await this.renderPage(this.currentPage);
    this._updatePageInfo();
    return { totalPages: this.totalPages };
  }

  async renderPage(pageNum) {
    if (this.rendering) return;
    if (this.mode === 'images') return this._renderImagePage(pageNum);
    if (!this.pdfDoc) return;
    this.rendering = true;

    try {
      const page = await this.pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: this.scale });

      this.pdfCanvas.width = viewport.width * (window.devicePixelRatio || 1);
      this.pdfCanvas.height = viewport.height * (window.devicePixelRatio || 1);
      this.pdfCanvas.style.width = viewport.width + 'px';
      this.pdfCanvas.style.height = viewport.height + 'px';

      const ctx = this.pdfCtx;
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);

      await page.render({ canvasContext: ctx, viewport }).promise;
      this.currentPage = pageNum;
    } finally {
      this.rendering = false;
    }
  }

  // ============================
  // Navigation (both modes)
  // ============================

  async nextPage() {
    if (this.currentPage < this.totalPages) {
      await this.renderPage(this.currentPage + 1);
      this._updatePageInfo();
      this.onPageChange?.(this.currentPage);
    }
  }

  async prevPage() {
    if (this.currentPage > 1) {
      await this.renderPage(this.currentPage - 1);
      this._updatePageInfo();
      this.onPageChange?.(this.currentPage);
    }
  }

  async goToPage(num, { silent = false } = {}) {
    if (num < 1 || num > this.totalPages) return;
    // Skip the re-render when already on the page (e.g. server echoing our
    // own page change back); silent avoids re-broadcasting remote changes.
    if (num !== this.currentPage) await this.renderPage(num);
    this._updatePageInfo();
    if (!silent) this.onPageChange?.(this.currentPage);
  }

  _updatePageInfo() {
    const el = document.getElementById('pdf-page-info');
    if (el) {
      el.textContent = `${this.currentPage} / ${this.totalPages}`;
    }
  }

  getCanvasSize() {
    return {
      width: parseInt(this.pdfCanvas.style.width) || 800,
      height: parseInt(this.pdfCanvas.style.height) || 600,
    };
  }

  destroy() {
    this._destroyed = true;
    this._imageCache.clear();
    if (this.pdfCanvas && this.pdfCanvas.parentNode) {
      this.pdfCanvas.parentNode.removeChild(this.pdfCanvas);
    }
    this.pdfDoc = null;
    this.doc = null;
    this.mode = null;
  }

  isLoaded() {
    return this.pdfDoc !== null || (this.mode === 'images' && this.doc !== null);
  }
}
