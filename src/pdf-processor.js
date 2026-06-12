/**
 * Client-side PDF and image optimization.
 *
 * PDFs are rasterized page-by-page into compressed bitmaps (WebP, falling
 * back to JPEG) at upload time, so collaborators only ever download
 * lightweight page images instead of the original PDF. Page flips become
 * instant image swaps instead of pdf.js re-renders, which keeps real-time
 * annotation smooth for everyone in the room.
 *
 * Images are downscaled and re-encoded before upload for the same reason.
 */

const PAGE_TARGET_WIDTH = 1600;   // rendered pixel width — crisp text, small files
const PAGE_MAX_SCALE = 2.5;
const PAGE_MAX_DIMENSION = 2400;  // hard cap for oversized pages (posters, plans)
const PAGE_QUALITY = 0.85;
const UPLOAD_BATCH_SIZE = 6;      // pages per upload request

const IMAGE_MAX_DIMENSION = 1920;
const IMAGE_QUALITY = 0.85;

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

// Load pdf.js with its worker bundled locally (no CDN dependency)
export async function loadPdfjs() {
  const pdfjsLib = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.js?url')).default;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  return pdfjsLib;
}

// Prefer WebP (~30% smaller); browsers that can't encode it return a
// blob of a different type (or null), in which case we fall back to JPEG.
async function encodePageBlob(canvas) {
  let blob = await canvasToBlob(canvas, 'image/webp', PAGE_QUALITY);
  if (!blob || blob.type !== 'image/webp') {
    blob = await canvasToBlob(canvas, 'image/jpeg', PAGE_QUALITY);
  }
  return blob;
}

/**
 * Convert a PDF file into compressed page images and upload them.
 * Returns a document descriptor shared with the room:
 *   { id, name, pageCount, pages: [{ url, width, height, baseWidth, baseHeight }] }
 * baseWidth/baseHeight are the page dimensions at pdf.js scale 1, which the
 * viewer multiplies by its display scale so existing annotations stay aligned.
 */
export async function processAndUploadPDF(file, { onProgress } = {}) {
  const pdfjsLib = await loadPdfjs();

  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const totalPages = pdf.numPages;

  // Reserve a document folder on the server
  const docRes = await fetch('/api/pdf-docs', { method: 'POST' });
  if (!docRes.ok) throw new Error('Failed to create PDF document');
  const { id: docId } = await docRes.json();

  const pages = new Array(totalPages);
  let batch = [];

  const flushBatch = async () => {
    if (!batch.length) return;
    const form = new FormData();
    for (const p of batch) {
      const ext = p.blob.type === 'image/webp' ? 'webp' : 'jpg';
      form.append('pages', p.blob, `page-${p.num}.${ext}`);
    }
    const res = await fetch(`/api/pdf-docs/${docId}/pages`, { method: 'POST', body: form });
    if (!res.ok) throw new Error('Failed to upload PDF pages');
    const { files } = await res.json();
    for (const p of batch) {
      const uploaded = files.find((f) => f.page === p.num);
      if (!uploaded) throw new Error(`Page ${p.num} was not stored`);
      pages[p.num - 1] = {
        url: uploaded.url,
        width: p.width,
        height: p.height,
        baseWidth: p.baseWidth,
        baseHeight: p.baseHeight,
      };
    }
    batch = [];
  };

  try {
    for (let num = 1; num <= totalPages; num++) {
      const page = await pdf.getPage(num);
      const base = page.getViewport({ scale: 1 });

      let scale = Math.max(1, Math.min(PAGE_TARGET_WIDTH / base.width, PAGE_MAX_SCALE));
      const maxDim = Math.max(base.width, base.height) * scale;
      if (maxDim > PAGE_MAX_DIMENSION) scale = PAGE_MAX_DIMENSION / Math.max(base.width, base.height);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      // WebP/JPEG have no transparency concept worth keeping for documents
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup();

      const blob = await encodePageBlob(canvas);
      if (!blob) throw new Error(`Failed to encode page ${num}`);

      batch.push({
        num,
        blob,
        width: canvas.width,
        height: canvas.height,
        baseWidth: base.width,
        baseHeight: base.height,
      });
      canvas.width = 0;
      canvas.height = 0;

      if (batch.length >= UPLOAD_BATCH_SIZE) await flushBatch();
      onProgress?.(num, totalPages);
    }
    await flushBatch();
  } finally {
    pdf.destroy();
  }

  return { id: docId, name: file.name, pageCount: totalPages, pages };
}

/**
 * Downscale and re-encode an image file before upload.
 * Returns the original file when compression wouldn't help
 * (animated GIFs, SVGs, or already-small files).
 */
export async function compressImage(file) {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // undecodable here — let the server/img tag deal with it
  }

  const scale = Math.min(1, IMAGE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  let blob = await canvasToBlob(canvas, 'image/webp', IMAGE_QUALITY);
  if (!blob || blob.type !== 'image/webp') {
    const keepAlpha = file.type === 'image/png';
    if (!keepAlpha) {
      // JPEG drops alpha — lay white underneath first
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }
    blob = await canvasToBlob(canvas, keepAlpha ? 'image/png' : 'image/jpeg', IMAGE_QUALITY);
  }
  canvas.width = 0;
  canvas.height = 0;

  if (!blob || (scale === 1 && blob.size >= file.size)) return file;

  const ext = blob.type === 'image/webp' ? 'webp' : blob.type === 'image/png' ? 'png' : 'jpg';
  const baseName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
  return new File([blob], `${baseName}.${ext}`, { type: blob.type });
}
