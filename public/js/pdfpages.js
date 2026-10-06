// Turning a PDF into page pictures, in the browser.
//
// WHY THIS EXISTS
//
// The server used to read a scanned PDF by lifting the embedded images out of it — no renderer,
// no dependency, and it worked on the scans we had: one photograph of a page, wrapped in a few
// lines of PDF.
//
// It does not work on a scan that has been COMPOSITED. A 38-page site agreement from the field
// turned out to hold 609 image objects — about sixteen per page, because the scanner separated
// each page into layers and strips (the usual MRC trick: a sharp mask for the text, a coarse
// picture behind it). Lifting those out gives you sixteen fragments where you wanted one page.
// On that file the old reader found four fragments in thirty-eight pages, and the proposal built
// from them was worthless.
//
// A PDF renderer composites the layers back into the page a person sees. The browser already
// has one — it is what the PDF viewer in a browser tab is — so the rendering happens here, on
// the machine that already has the file, and the server receives ordinary page pictures of the
// kind it has always been able to read.
//
// THE LIBRARY IS VENDORED, for the same reason the OCR language data is: `script-src 'self'`
// (see vercel.json) forbids loading it from a CDN, and a page that depends on a third party
// being up is a page that stops working for reasons nobody here can fix. public/vendor/ holds
// pdf.min.js and its worker, Apache-2.0, unmodified.
//
// NOTHING LEAVES THE MACHINE. The render is local. What is sent afterwards is what was always
// sent: a picture of a page, for OCR.

(function () {
  'use strict';

  const LIB = '/vendor/pdf.min.js';
  const WORKER = '/vendor/pdf.worker.min.js';

  // ~200 dpi across an A4 page, which is what Tesseract wants and what the photograph path
  // already targets (OCR_MAX_EDGE in siteinfo-batch.js). Higher is slower and no more readable.
  const EDGE = 2000;
  const QUALITY = 0.8;

  // A ceiling on the render, not on the document. A 300-page file is opened and its first pages
  // read; the old path refused the whole thing because the FILE was too big to send.
  const MAX_PAGES = 12;

  let libPromise = null;

  /** Loads the vendored library once. A failed load is not cached. */
  function lib() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = LIB;
      s.onload = () => {
        if (!window.pdfjsLib) { reject(new Error('The PDF reader did not load.')); return; }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER;
        resolve(window.pdfjsLib);
      };
      s.onerror = () => reject(new Error('The PDF reader could not be loaded.'));
      document.head.appendChild(s);
    }).catch((e) => { libPromise = null; throw e; });
    return libPromise;
  }

  /** Is this file one we render rather than send as it stands? */
  const isPdf = (file) => /pdf/i.test((file && file.type) || '')
    || /\.pdf$/i.test((file && file.name) || '');

  /**
   * Which pages to read, given how many there are.
   *
   * THE FRONT, AND THEN A SPREAD. The fields we are looking for are on the first pages of a job
   * card. The FICA check is a different question — a bank statement bound into the back of a
   * 38-page agreement is exactly what it exists to catch — and sampling only the front would
   * miss it. So: every page up to `front`, then evenly spaced pages through the rest.
   *
   * @returns {number[]} 1-based page numbers, in order, no duplicates
   */
  function pagePlan(total, front, sample) {
    const take = [];
    for (let n = 1; n <= Math.min(front, total); n++) take.push(n);
    const remaining = total - take.length;
    if (remaining > 0 && sample > 0) {
      const step = remaining / Math.min(sample, remaining);
      for (let i = 0; i < Math.min(sample, remaining); i++) {
        const n = take.length + 1 + Math.floor(i * step);
        if (n <= total && take.indexOf(n) < 0) take.push(n);
      }
    }
    return take.slice(0, MAX_PAGES);
  }

  /**
   * Render a PDF's pages to JPEG.
   *
   * @param {File|Blob} file
   * @param {{front?:number, sample?:number, onProgress?:function}} [opts]
   * @returns {Promise<{pages:Array<{page:number, blob:Blob}>, total:number}>}
   */
  async function render(file, opts) {
    const o = opts || {};
    const front = o.front === undefined ? 3 : o.front;
    const sample = o.sample === undefined ? 5 : o.sample;

    const pdfjs = await lib();
    const bytes = new Uint8Array(await file.arrayBuffer());

    let doc;
    try {
      doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    } catch (e) {
      // A password, a corrupt file, or something that is not a PDF at all. Said plainly: the
      // old path's "over the reading limit" was a guess that was usually wrong.
      throw new Error((e && e.name === 'PasswordException')
        ? 'That PDF is password protected, so it cannot be read.'
        : 'That PDF could not be opened. It may be damaged.');
    }

    const plan = pagePlan(doc.numPages, front, sample);
    const pages = [];

    for (const n of plan) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(EDGE / Math.max(base.width, base.height), 3);
      const vp = page.getViewport({ scale: scale > 0 ? scale : 1 });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(vp.width));
      canvas.height = Math.max(1, Math.ceil(vp.height));
      const ctx = canvas.getContext('2d');
      // A PDF page is transparent where nothing is drawn, and a transparent JPEG comes out
      // black. White first, as paper is.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // RENDERING PAUSES WHILE THE TAB IS HIDDEN, and resumes when it is shown again.
      //
      // A browser does not paint a background tab, and pdf.js's canvas rendering stops with it.
      // Somebody who drops a folder and switches to their mail comes back to a job that has not
      // moved; it then finishes normally. Measured, not assumed: test/pdfpages-harness.html
      // renders nothing at all while its pane is hidden and renders every page once it is not.
      //
      // pdf.js's own onContinue hook takes requestAnimationFrame out of its continuation loop,
      // and that alone does NOT fix this -- the stall is further down. So it is not used here:
      // a frame-paced loop is kinder to the page while the person IS watching, which is the
      // case that matters.
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
      if (blob) pages.push({ page: n, blob });
      if (o.onProgress) o.onProgress(pages.length, plan.length);
    }

    try { await doc.destroy(); } catch (e) { /* already gone */ }
    return { pages, total: doc.numPages };
  }

  TX.pdfPages = { render, isPdf, pagePlan, EDGE, QUALITY, MAX_PAGES, LIB, WORKER };
})();
