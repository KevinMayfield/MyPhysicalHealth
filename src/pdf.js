const puppeteer = require('puppeteer');

let browserPromise;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  return browserPromise;
}

/**
 * Renders the same self-contained report HTML to a PDF buffer, using the
 * document's own @media print stylesheet (forces light theme, A4 with
 * break-inside: avoid on cards).
 */
async function renderPdf(html) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    const bytes = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
    return Buffer.from(bytes);
  } finally {
    await page.close();
  }
}

async function shutdown() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
}

module.exports = { renderPdf, shutdown };
