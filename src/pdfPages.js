const path = require('path');

// The vision model takes images only, so an uploaded PDF is turned into its first pages as JPEGs and the text printed
// in it (none for a scanned PDF). pdfjs-dist renders through @napi-rs/canvas.
const DIST = path.dirname(require.resolve('pdfjs-dist/package.json'));
// pdfjs wants its data folders as paths ending in a forward slash, on Windows too.
const dataDir = (name) => `${path.join(DIST, name).replace(/\\/g, '/')}/`;
let pdfjs;

async function pdfPages(data, { maxPages = 3, maxSide = 2000, maxTextPages = 10, maxText = 20000 } = {}) {
  pdfjs ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  const { getDocument } = await pdfjs;
  const task = getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl: dataDir('standard_fonts'),
    cMapUrl: dataDir('cmaps'),
    wasmUrl: dataDir('wasm'),
    iccUrl: dataDir('iccs'),
    isEvalSupported: false,
    verbosity: 0,
  });
  try {
    let doc;
    try {
      doc = await task.promise;
    } catch (err) {
      // A damaged or password-locked file: trying again does not help, another upload does.
      throw Object.assign(new Error(`The PDF cannot be opened: ${err.message}`), { unreadable: true });
    }
    const images = [];
    const texts = [];
    for (let n = 1; n <= Math.min(doc.numPages, Math.max(maxPages, maxTextPages)); n += 1) {
      const page = await doc.getPage(n);
      if (n <= maxTextPages) {
        const { items } = await page.getTextContent();
        texts.push(items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').trim());
      }
      if (n <= maxPages) {
        // About twice the PDF's own size, with the long side capped: sharp enough to read, small enough to send.
        const size = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2, maxSide / Math.max(size.width, size.height)) });
        const { canvas } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvas, viewport }).promise;
        images.push(Buffer.from(await canvas.encode('jpeg', 85)));
      }
      page.cleanup();
    }
    return { pageCount: doc.numPages, images, text: texts.filter(Boolean).join('\n\n').slice(0, maxText) };
  } finally {
    await task.destroy();
  }
}

module.exports = { pdfPages };
