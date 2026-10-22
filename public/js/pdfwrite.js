// Writing a PDF out of page pictures, in the browser.
//
// Splitting a scan (siteinfo-split.js) renders every page to a JPEG with pdfpages.js, and the
// pieces then have to be PDFs again: a FICA page is filed as a one-page PDF, and the remaining
// pages are put back together for the ordinary import routes. pdf.js reads PDFs; it does not
// write them, and the CSP forbids fetching a library that does. This writes the one kind of PDF
// needed here -- each page a single JPEG, drawn to fill it -- which is a few objects and a
// cross-reference table, not a library.
//
// The JPEG goes in as it is (DCTDecode): nothing is re-encoded, so a page loses nothing more
// than the render already cost it. It is also the form api/_lib/pdfimages.js reads, so a PDF
// written here can be OCR'd and classified on the server like any scan.
//
// Loaded as a plain script in the browser (TX.pdfWrite) and with require() by the test suite.

(function (root) {
  'use strict';

  // The long edge of every page in points: A4's 842. A rendered page carries its pixel size and
  // nothing about paper, so it is laid out at A4 whatever resolution it was rendered at.
  const LONG_EDGE_PT = 842;

  function bytesOf(s) {
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
    return b;
  }

  /** Is this a JPEG? The writer only knows how to carry one. */
  function isJpeg(bytes) {
    return !!bytes && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  /**
   * @param {Array<{bytes:Uint8Array, width:number, height:number}>} pages  JPEGs, in page order
   * @returns {Uint8Array} the PDF
   */
  function fromJpegs(pages) {
    if (!Array.isArray(pages) || !pages.length) throw new Error('A PDF needs at least one page.');
    for (const p of pages) {
      if (!isJpeg(p && p.bytes)) throw new Error('Every page must be a JPEG.');
      if (!(p.width > 0 && p.height > 0)) throw new Error('Every page needs its size in pixels.');
    }

    const parts = [];
    const offsets = [];       // byte offset of object n at offsets[n - 1]
    let length = 0;
    const push = (b) => { parts.push(b); length += b.length; };
    const text = (s) => push(bytesOf(s));
    const begin = (n) => { offsets[n - 1] = length; text(n + ' 0 obj\n'); };

    // 1 catalog, 2 page tree, then three objects per page: page, image, drawing.
    const pageObj = (i) => 3 + i * 3;
    const n = pages.length;

    // A binary comment on line two tells anything reading this that the file holds binary.
    text('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');

    begin(1);
    text('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    begin(2);
    text('<< /Type /Pages /Count ' + n + ' /Kids ['
      + pages.map((p, i) => pageObj(i) + ' 0 R').join(' ') + '] >>\nendobj\n');

    pages.forEach((p, i) => {
      const scale = LONG_EDGE_PT / Math.max(p.width, p.height);
      const w = (p.width * scale).toFixed(2);
      const h = (p.height * scale).toFixed(2);
      const pg = pageObj(i);

      begin(pg);
      text('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + ']'
        + ' /Resources << /XObject << /Im0 ' + (pg + 1) + ' 0 R >> >>'
        + ' /Contents ' + (pg + 2) + ' 0 R >>\nendobj\n');

      begin(pg + 1);
      text('<< /Type /XObject /Subtype /Image /Width ' + p.width + ' /Height ' + p.height
        + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode'
        + ' /Length ' + p.bytes.length + ' >>\nstream\n');
      push(p.bytes);
      text('\nendstream\nendobj\n');

      const draw = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q';
      begin(pg + 2);
      text('<< /Length ' + draw.length + ' >>\nstream\n' + draw + '\nendstream\nendobj\n');
    });

    // The cross-reference table: every entry exactly 20 bytes, offsets ten digits wide.
    const xref = length;
    const count = offsets.length + 1;
    text('xref\n0 ' + count + '\n0000000000 65535 f \n'
      + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')
      + 'trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

    const out = new Uint8Array(length);
    let at = 0;
    for (const b of parts) { out.set(b, at); at += b.length; }
    return out;
  }

  const api = { fromJpegs, isJpeg, LONG_EDGE_PT };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TX.pdfWrite = api;
})(typeof window !== 'undefined' ? window : this);
