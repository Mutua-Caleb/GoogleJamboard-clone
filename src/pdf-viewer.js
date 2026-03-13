/**
 * PDF viewer and annotation layer.
 * Renders PDF pages onto a canvas and syncs annotations in real-time.
 */

export class PDFViewer {
  constructor(container, { onPageChange }) {
    this.container = container;
    this.onPageChange = onPageChange;

    this.pdfDoc = null;
    this.currentPage = 1;
    this.totalPages = 0;
    this.scale = 1.5;
    this.pdfCanvas = null;
    this.pdfCtx = null;
    this.rendering = false;

    this._init();
  }

  _init() {
    // Create PDF render canvas (sits behind the drawing canvas)
    this.pdfCanvas = document.createElement('canvas');
    this.pdfCanvas.className = 'pdf-canvas';
    this.container.appendChild(this.pdfCanvas);
    this.pdfCtx = this.pdfCanvas.getContext('2d');
  }

  async loadPDF(url) {
    // Dynamic import pdfjs-dist
    const pdfjsLib = await import('pdfjs-dist');
    pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;

    const loadingTask = pdfjsLib.getDocument(url);
    this.pdfDoc = await loadingTask.promise;
    this.totalPages = this.pdfDoc.numPages;
    this.currentPage = 1;

    await this.renderPage(this.currentPage);
    this._updatePageInfo();
    return { totalPages: this.totalPages };
  }

  async renderPage(pageNum) {
    if (!this.pdfDoc || this.rendering) return;
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

  async goToPage(num) {
    if (num >= 1 && num <= this.totalPages) {
      await this.renderPage(num);
      this._updatePageInfo();
      this.onPageChange?.(this.currentPage);
    }
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
    if (this.pdfCanvas && this.pdfCanvas.parentNode) {
      this.pdfCanvas.parentNode.removeChild(this.pdfCanvas);
    }
    this.pdfDoc = null;
  }

  isLoaded() {
    return this.pdfDoc !== null;
  }
}
