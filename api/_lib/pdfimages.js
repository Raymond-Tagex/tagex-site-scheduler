// Pull the page images out of a scanned PDF, in a form an OCR engine will accept.
//
// WHY NOT A PDF RENDERER
//
// OCR needs a bitmap, and the obvious route is to rasterise the PDF with pdf.js. That drags in
// ~15MB of renderer to do something a scan does not need: a scanned page is not a drawing, it is
// a photograph of a page wrapped in a few lines of PDF. Lifting the photograph out is the job.
//
// THREE SHAPES OF SCAN, ALL SEEN IN PRACTICE
//
//   1. /DCTDecode                    — the page is a JPEG. Its bytes ARE a JPEG file.
//   2. /Filter [/FlateDecode /DCTDecode] — the same, zlib-wrapped. Inflate, then a JPEG.
//   3. /CCITTFaxDecode               — a bilevel fax-compressed page, which is what an office
//                                      MFP produces in its default black-and-white text mode.
//
// Shape 3 was initially dismissed as needing a decoder nobody wanted to write. It does not:
// CCITT Group 3/4 is exactly the compression a TIFF file uses, byte for byte, so wrapping the
// stream in a ~90-byte TIFF header hands it to the decoder already inside the OCR engine.
// That was verified against a real Xerox scan before this code was written, not assumed.
//
// WHAT IS STILL NOT SUPPORTED: JPX (JPEG 2000) and JBIG2. Those return no image and NAME
// themselves in `unsupported`, so the caller reports "this scan could not be read" rather than
// a blank page that looks like a clean one.
//
// PICKING THE PAGES
//
// A scanner using Mixed Raster Content splits each page into layers: a low-detail JPEG
// background and one or more bilevel masks carrying the text. A real file measured here had 38
// backgrounds and 571 masks for 26 pages, and OCR of the backgrounds returned nothing but a
// logo — the words were all in the masks. Selecting "every image" would therefore burn the page
// budget on layers with no text in them. The rule is to keep images within a factor of the
// largest, which picks the full-page layer and discards backgrounds, logos and tiles.
//
// Nothing here trusts the file. Lengths are bounds-checked against the buffer, the object count
// is capped, dimensions are sanity-checked before they are used to size a header, and a stream
// that does not begin with a JPEG signature is discarded rather than handed to a decoder.

'use strict';

const zlib = require('zlib');

const MAX_OBJECTS = 20000;        // an MRC scan legitimately has hundreds of image objects;
                                  // this still stops a crafted file from running forever.
const MIN_PIXELS = 200 * 200;     // below this it is a logo, a tile or a signature stamp.
const MAX_DIMENSION = 20000;      // a page is not 20000px on a side; refuse to size a header from it.
const AREA_RATIO = 0.4;           // keep images at least this fraction of the largest one's area.

/** Encodings this extractor deliberately does not decode. */
const UNSUPPORTED = ['JPXDecode', 'JBIG2Decode'];

/**
 * Read a PDF dictionary starting at `<<`, respecting nesting, and return its text and end index.
 * Returns null when the dictionary is unterminated.
 */
function readDict(s, start) {
  if (s.slice(start, start + 2) !== '<<') return null;
  let depth = 0;
  let i = start;
  while (i < s.length) {
    if (s[i] === '<' && s[i + 1] === '<') { depth++; i += 2; continue; }
    if (s[i] === '>' && s[i + 1] === '>') {
      depth--;
      i += 2;
      if (depth === 0) return { text: s.slice(start, i), end: i };
      continue;
    }
    i++;
  }
  return null;
}

/** The value of a simple /Name or /Number key, or '' when absent or indirect. */
function dictValue(dict, key) {
  const m = new RegExp('\\/' + key + '\\s*(\\/?-?[A-Za-z0-9.+-]+)').exec(dict);
  return m ? m[1] : '';
}

/** An integer key, or the supplied fallback. */
function dictInt(dict, key, fallback) {
  const v = dictValue(dict, key);
  return /^-?\d+$/.test(v) ? Number(v) : fallback;
}

/**
 * A single-strip TIFF wrapper around a CCITT Group 3/4 payload.
 *
 * The payload is not touched — TIFF stores exactly the same bitstream the PDF filter does, so
 * this only writes a header describing it.
 *
 * On polarity: PDF's BlackIs1 and TIFF's PhotometricInterpretation express the same idea with
 * opposite defaults, and the two conventions are widely muddled in real files. Both readings
 * were tried against a real scan and OCR recovered the same text either way — the engine
 * normalises polarity itself — so the fax convention (WhiteIsZero) is used, inverted when the
 * PDF explicitly asks for it.
 */
function ccittToTiff(data, width, height, opts) {
  const o = opts || {};
  const k = o.k || 0;
  // TIFF: 2 = Modified Huffman, 3 = Group 3, 4 = Group 4.
  const compression = k < 0 ? 4 : 3;
  const photometric = o.blackIs1 ? 1 : 0;

  const entries = [
    [256, 4, 1, width],                 // ImageWidth
    [257, 4, 1, height],                // ImageLength
    [258, 3, 1, 1],                     // BitsPerSample
    [259, 3, 1, compression],           // Compression
    [262, 3, 1, photometric],           // PhotometricInterpretation
    [273, 4, 1, 0],                     // StripOffsets — patched to the data offset below
    [277, 3, 1, 1],                     // SamplesPerPixel
    [278, 4, 1, height],                // RowsPerStrip — one strip holds the page
    [279, 4, 1, data.length],           // StripByteCounts
  ];
  if (compression === 3) {
    // T4Options: bit 0 = 2D coding (K > 0 means mixed 1D/2D), bit 2 = byte-aligned rows.
    const t4 = (k > 0 ? 1 : 0) | (o.byteAlign ? 4 : 0);
    entries.push([292, 4, 1, t4]);
  }
  entries.sort((a, b) => a[0] - b[0]);   // TIFF requires tags in ascending order

  const ifdSize = 2 + entries.length * 12 + 4;
  const head = Buffer.alloc(8 + ifdSize);
  head.write('II', 0, 'latin1');         // little-endian
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(8, 4);              // the IFD follows the header
  head.writeUInt16LE(entries.length, 8);

  const dataOffset = 8 + ifdSize;
  entries.forEach((e, i) => {
    const off = 10 + i * 12;
    head.writeUInt16LE(e[0], off);       // tag
    head.writeUInt16LE(e[1], off + 2);   // type: 3 = SHORT, 4 = LONG
    head.writeUInt32LE(e[2], off + 4);   // count
    const value = e[0] === 273 ? dataOffset : e[3];
    if (e[1] === 3) { head.writeUInt16LE(value, off + 8); head.writeUInt16LE(0, off + 10); }
    else head.writeUInt32LE(value, off + 8);
  });
  head.writeUInt32LE(0, 8 + 2 + entries.length * 12);   // no next IFD

  return Buffer.concat([head, data]);
}

/**
 * The declared stream length, or -1 when it is an indirect reference and so unknowable here.
 *
 * `/Length 8 0 R` points at object 8; `/Length 8` means eight bytes. Both begin "/Length 8",
 * and confusing them silently truncates every stream in the file.
 */
function streamLength(dictText) {
  if (/\/Length\s+\d+\s+\d+\s+R\b/.test(dictText)) return -1;
  const m = /\/Length\s+(\d+)\b/.exec(dictText);
  return m ? Number(m[1]) : -1;
}

/** The raw bytes of the stream that follows a dictionary, or null. */
function streamBytes(buf, s, dict) {
  let q = dict.end;
  while (q < s.length && /\s/.test(s[q])) q++;
  if (s.slice(q, q + 6) !== 'stream') return null;
  q += 6;
  if (s[q] === '\r') q++;
  if (s[q] === '\n') q++;

  // /Length may be an INDIRECT REFERENCE — `/Length 8 0 R` — which cannot be resolved without a
  // full object table. It must not be read as "length 8": that truncates the stream to its first
  // eight bytes, which then fails the JPEG signature check and is silently discarded. A real
  // Xerox scan whose every image used the indirect form produced zero readable pages that way.
  // Detect the reference form explicitly and fall back to the endstream marker.
  const declared = streamLength(dict.text);
  let end;
  if (declared >= 0 && q + declared <= buf.length) {
    end = q + declared;
  } else {
    const marker = s.indexOf('endstream', q);
    if (marker < 0) return null;
    end = marker;
    while (end > q && (s[end - 1] === '\n' || s[end - 1] === '\r')) end--;
  }
  if (end <= q || end > buf.length) return null;
  return buf.slice(q, end);
}

/**
 * Every readable page image in a scanned PDF, in document order.
 *
 * @param {Buffer} buf         the PDF file
 * @param {number} [limit]     stop after this many images (default 4)
 * @param {boolean} [spread]   sample evenly across the whole document instead of taking the
 *                             first `limit` pages. Field extraction wants the front of a job
 *                             card; the FICA check wants coverage, because the thing it is
 *                             looking for is rarely on page one — in a real subscription pack
 *                             the bank statements were on pages 11 to 13 of 26.
 * @returns {{images: Array<{data:Buffer, contentType:string, width:number, height:number,
 *            kind:string}>, unsupported: string[], objects: number, available: number}}
 */
function extractPageImages(buf, limit, spread) {
  const cap = Math.max(1, limit || 4);
  const s = buf.toString('latin1');
  const found = [];
  const unsupported = [];
  let objects = 0;

  const re = /\bobj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (++objects > MAX_OBJECTS) break;

    let p = m.index + 3;
    while (p < s.length && /\s/.test(s[p])) p++;
    const dict = readDict(s, p);
    if (!dict) continue;
    if (!/\/Subtype\s*\/Image/.test(dict.text)) continue;

    const unsup = UNSUPPORTED.find((f) => dict.text.indexOf('/' + f) >= 0);
    if (unsup) {
      if (unsupported.indexOf(unsup) < 0) unsupported.push(unsup);
      continue;
    }

    const width = dictInt(dict.text, 'Width', 0);
    const height = dictInt(dict.text, 'Height', 0);
    if (!(width > 0 && height > 0)) continue;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) continue;
    if (width * height < MIN_PIXELS) continue;

    const isDct = dict.text.indexOf('/DCTDecode') >= 0;
    const isCcitt = dict.text.indexOf('/CCITTFaxDecode') >= 0;
    if (!isDct && !isCcitt) continue;

    const raw = streamBytes(buf, s, dict);
    if (!raw) continue;

    if (isDct) {
      // A Flate-wrapped JPEG is common in scanner output; inflate before looking for the
      // JPEG signature, or a perfectly readable page is discarded as "not a JPEG".
      let data = raw;
      if (/\/Filter\s*\[[^\]]*\/FlateDecode/.test(dict.text)) {
        try { data = zlib.inflateSync(raw); } catch (e) { continue; }
      }
      // A DCTDecode stream must start SOI. Anything else means the length was wrong or the
      // file is lying; do not pass it to a decoder.
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) continue;
      found.push({
        data, contentType: 'image/jpeg', width, height, kind: 'jpeg', area: width * height,
      });
      continue;
    }

    // CCITT. Columns/Rows in DecodeParms describe the coded data and win over Width/Height.
    const parms = /\/DecodeParms\s*(<<[\s\S]{0,400}?>>)/.exec(dict.text);
    const pd = parms ? parms[1] : dict.text;
    const columns = dictInt(pd, 'Columns', 1728);
    const rows = dictInt(pd, 'Rows', height);
    if (!(columns > 0 && rows > 0) || columns > MAX_DIMENSION || rows > MAX_DIMENSION) continue;

    found.push({
      data: ccittToTiff(raw, columns, rows, {
        k: dictInt(pd, 'K', 0),
        blackIs1: /\/BlackIs1\s+true/.test(pd),
        byteAlign: /\/EncodedByteAlign\s+true/.test(pd),
      }),
      contentType: 'image/tiff',
      width: columns,
      height: rows,
      kind: 'ccitt',
      area: columns * rows,
    });
  }

  // Keep the full-page layers and drop the rest. See the note on Mixed Raster Content above.
  const maxArea = found.reduce((a, x) => Math.max(a, x.area), 0);
  const pages = found.filter((x) => x.area >= AREA_RATIO * maxArea);

  let chosen;
  if (spread && pages.length > cap) {
    // Evenly spaced, first page always included. Reading pages 1..cap of a 26-page pack tells
    // you only what its cover says.
    const step = (pages.length - 1) / (cap - 1);
    const seen = new Set();
    chosen = [];
    for (let i = 0; i < cap; i++) {
      const idx = Math.round(i * step);
      if (seen.has(idx)) continue;
      seen.add(idx);
      chosen.push(pages[idx]);
    }
  } else {
    chosen = pages.slice(0, cap);
  }

  const images = chosen.map(({ data, contentType, width, height, kind }) => (
    { data, contentType, width, height, kind }));

  return { images, unsupported, objects, available: pages.length };
}

module.exports = {
  extractPageImages, ccittToTiff, readDict, dictInt, streamLength,
  UNSUPPORTED, MIN_PIXELS, AREA_RATIO,
};
