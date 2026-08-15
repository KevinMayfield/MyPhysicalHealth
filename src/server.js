const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { generateReportHtml } = require('./pipeline');
const { renderPdf, shutdown } = require('./pdf');

const PORT = process.env.PORT || 3000;
const REPORT_TTL_MS = 60 * 60 * 1000;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** @type {Map<string, { rideName: string, html: string, createdAt: number }>} */
const reports = new Map();

function cleanupExpiredReports() {
  const now = Date.now();
  for (const [id, report] of reports) {
    if (now - report.createdAt > REPORT_TTL_MS) reports.delete(id);
  }
}

app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>MyPhysicalHealth — Ride Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #eae6d9; color: #262620; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fdfbf3; border-radius: 20px; box-shadow: 0 8px 24px rgba(38,38,32,0.08); padding: 40px; max-width: 420px; width: 90%; text-align: center; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { color: #6f6c5f; line-height: 1.5; margin-bottom: 24px; }
  input[type="file"] { display: block; width: 100%; margin-bottom: 20px; }
  button { background: #262620; color: #fdfbf3; border: none; border-radius: 999px; padding: 12px 28px; font-size: 15px; font-weight: 700; cursor: pointer; }
  button:disabled { opacity: 0.6; }
  .error { color: #c1502f; margin-bottom: 16px; }
  #status { color: #6f6c5f; margin-top: 16px; font-size: 14px; }
</style>
</head>
<body>
  <div class="card">
    <h1>Turn your ride into a report</h1>
    <p>Upload a GPX file from your bike ride and get a poster-style report showing the
      cardio and strength sides of your ride, with a map, elevation profile, and a
      downloadable PDF.</p>
    <form id="form" method="post" action="/generate" enctype="multipart/form-data">
      <input type="file" name="gpxfile" accept=".gpx" required />
      <button type="submit">Generate report</button>
    </form>
    <div id="status"></div>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', () => {
      document.querySelector('button').disabled = true;
      document.getElementById('status').textContent = 'Analysing your ride — this can take a few seconds (fetching the map and place names)…';
    });
  </script>
</body>
</html>`);
});

app.post('/generate', upload.single('gpxfile'), async (req, res) => {
  if (!req.file) {
    res.status(400).send('No GPX file uploaded.');
    return;
  }
  try {
    cleanupExpiredReports();
    const xml = req.file.buffer.toString('utf8');
    const id = crypto.randomUUID();
    const { html, rideName } = await generateReportHtml(xml, { includeToolbar: true, pdfHref: `/report/${id}/pdf` });
    reports.set(id, { rideName, html, createdAt: Date.now() });
    res.redirect(`/report/${id}`);
  } catch (err) {
    console.error(err);
    res.status(400).send(`Couldn't generate a report from that file: ${err.message}`);
  }
});

app.get('/report/:id', (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) {
    res.status(404).send('Report not found or has expired. Please upload the GPX file again.');
    return;
  }
  res.type('html').send(report.html);
});

app.get('/report/:id/pdf', async (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) {
    res.status(404).send('Report not found or has expired. Please upload the GPX file again.');
    return;
  }
  try {
    const pdf = await renderPdf(report.html);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${report.rideName.replace(/[^a-z0-9-_]+/gi, '_')}.pdf"`,
    });
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to render PDF.');
  }
});

const server = app.listen(PORT, () => {
  console.log(`MyPhysicalHealth listening on http://localhost:${PORT}`);
});

process.on('SIGTERM', async () => {
  await shutdown();
  server.close(() => process.exit(0));
});
process.on('SIGINT', async () => {
  await shutdown();
  server.close(() => process.exit(0));
});
