// OCR for scanned site documents.
//
// The first dependency this project has ever taken. It is here because the alternative was an
// external OCR service, and site documents would then leave our infrastructure — which is the
// thing every other decision in this codebase exists to prevent. Tesseract runs inside the
// function; nothing is sent anywhere.
//
// THE LANGUAGE DATA IS VENDORED ON PURPOSE. tesseract.js downloads eng.traineddata from a CDN on
// first use and writes it next to the process. On Vercel the filesystem is read-only apart from
// /tmp, so that fetch would fail, and even where it succeeded it would make every cold start
// depend on a third-party host being up. The file is committed under tessdata/ and langPath
// points at it, so recognition never touches the network.
//
// WHAT OCR IS WORTH HERE
//
// Printed text reads well. HANDWRITING DOES NOT — Tesseract is a print engine, and the
// handwritten entries on a filled-in jobcard will come back wrong or empty. Every caller must
// treat the output as a suggestion for a person to confirm. The one place it is used as a
// control rather than a convenience is the FICA classifier, and there it only ever makes the
// classifier stricter: text it finds can BLOCK a file, never clear one.

'use strict';

const path = require('path');

const LANG = 'eng';
const TESSDATA = path.join(__dirname, 'tessdata');

// A scanned page is ~1-2s warm. The ceiling is generous enough for a slow cold start and small
// enough to leave room inside the function's own maxDuration for the Airtable writes that follow.
const TIMEOUT_MS = 20000;

let workerPromise = null;

/**
 * The shared worker. Vercel keeps a container warm between requests, so the ~1s of engine start
 * up is paid once rather than per upload. A failed start is not cached — otherwise one transient
 * error would poison every later request in that container.
 */
function getWorker() {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const { createWorker } = require('tesseract.js');
    return createWorker(LANG, 1, {
      langPath: TESSDATA,
      cachePath: '/tmp',      // the only writable path on Vercel
      gzip: false,            // the vendored file is not gzipped
      logger: () => {},
    });
  })().catch((e) => { workerPromise = null; throw e; });
  return workerPromise;
}

/** Drop the shared worker, so the next call starts a clean one. */
async function reset() {
  const p = workerPromise;
  workerPromise = null;
  if (!p) return;
  try { const w = await p; await w.terminate(); } catch (e) { /* already gone */ }
}

/**
 * Recognise one image.
 *
 * @param {Buffer} image  JPEG or PNG bytes
 * @returns {Promise<{text:string, confidence:number}>}
 */
async function recognise(image) {
  const worker = await getWorker();

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('OCR timed out')), TIMEOUT_MS);
  });

  try {
    const res = await Promise.race([worker.recognize(image), timeout]);
    return {
      text: String((res && res.data && res.data.text) || ''),
      confidence: Number((res && res.data && res.data.confidence) || 0),
    };
  } catch (e) {
    // A timed-out or crashed recognition leaves the worker in an unknown state. Throwing it away
    // costs one cold start; keeping it risks every later request in this container failing.
    await reset();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read every page of a document.
 *
 * @param {Buffer} buf
 * @param {string} filename
 * @param {string} contentType
 * @param {number} [maxPages]
 * @param {boolean} [spread]  sample across the whole document rather than reading its front.
 * @returns {Promise<{text:string, confidence:number, pages:number, note:string,
 *                    available:number}>}
 */
async function readDocument(buf, filename, contentType, maxPages, spread) {
  const isPdf = /pdf/i.test(contentType || '') || /\.pdf$/i.test(filename || '');

  // A Word or Excel file needs unzipping, not OCR — its text is already text.
  const office = require('./officetext.js');
  if (office.isOffice(filename, contentType) || /\.(doc|xls)$/i.test(filename || '')) {
    const r = office.officeText(buf, filename, contentType);
    return {
      text: r.text,
      confidence: r.text.trim() ? 100 : 0,   // read, not recognised: nothing was guessed
      pages: r.text.trim() ? 1 : 0,
      available: r.text.trim() ? 1 : 0,
      note: r.note,
    };
  }

  if (!isPdf) {
    if (!/^image\//i.test(contentType || '') && !/\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(filename || '')) {
      return { text: '', confidence: 0, pages: 0, note: 'Not an image or a PDF.', available: 0 };
    }
    const r = await recognise(buf);
    return { text: r.text, confidence: r.confidence, pages: 1, note: '', available: 1 };
  }

  const { extractPageImages } = require('./pdfimages.js');
  const { images, unsupported, available } = extractPageImages(buf, maxPages || 2, spread);

  if (!images.length) {
    return {
      text: '',
      confidence: 0,
      pages: 0,
      available: 0,
      note: unsupported.length
        ? 'The scan uses ' + unsupported.join(' / ') + ' compression, which cannot be read here. '
          + 'Re-scan or re-save the PDF as JPEG-compressed and try again.'
        : 'No page image was found in this PDF, so there was nothing to read.',
    };
  }

  const parts = [];
  let total = 0;
  for (const img of images) {
    const r = await recognise(img.data);
    parts.push(r.text);
    total += r.confidence;
  }
  return {
    text: parts.join('\n'),
    confidence: Math.round(total / images.length),
    pages: images.length,
    available: available || images.length,
    note: available > images.length
      ? 'Read ' + images.length + ' of ' + available + ' pages.'
      : '',
  };
}

/**
 * Read pages that have already been rendered to images.
 *
 * The caller did the compositing -- see public/js/pdfpages.js for why a PDF cannot be read here
 * by lifting its images out. Each page is recognised on its own and the texts are joined in the
 * order they were sent, so a field that spans a page break still reads in order.
 *
 * @param {Buffer[]} images  JPEG or PNG bytes, one per page, in document order
 * @returns {Promise<{text:string, confidence:number, pages:number, note:string, available:number}>}
 */
async function readPages(images) {
  const list = (images || []).filter((b) => b && b.length);
  if (!list.length) {
    return { text: '', confidence: 0, pages: 0, available: 0, note: 'No page image was sent.' };
  }
  const parts = [];
  let total = 0;
  for (const img of list) {
    const r = await recognise(img);
    parts.push(r.text);
    total += r.confidence;
  }
  return {
    text: parts.join('\n'),
    confidence: Math.round(total / list.length),
    pages: list.length,
    available: list.length,
    note: '',
  };
}

module.exports = { readDocument, readPages, recognise, reset, LANG, TESSDATA, TIMEOUT_MS };
