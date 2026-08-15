const css = `
:root {
  --bg: #eae6d9;
  --bg-card: #fdfbf3;
  --bg-card-soft: #f6f2e6;
  --ink: #262620;
  --ink-muted: #6f6c5f;
  --border: rgba(38, 38, 32, 0.1);
  --shadow: 0 8px 24px rgba(38, 38, 32, 0.08);

  --cardio: #c1502f;
  --cardio-soft: #f3ddd2;
  --cardio-ink: #8a3a20;

  --strength: #2f6b4f;
  --strength-soft: #dde9df;
  --strength-ink: #234f3a;

  --recovery: #c99a2e;
  --recovery-soft: #f2e6c6;

  --band-bg: #23291f;
  --band-ink: #f4f1e6;
  --band-muted: #b9b6a6;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #1c1c17;
    --bg-card: #262620;
    --bg-card-soft: #2c2c24;
    --ink: #eeece0;
    --ink-muted: #a6a290;
    --border: rgba(238, 236, 224, 0.12);
    --shadow: 0 8px 24px rgba(0, 0, 0, 0.4);

    --cardio: #e08561;
    --cardio-soft: #3a2a22;
    --cardio-ink: #f0b79c;

    --strength: #6fae8a;
    --strength-soft: #223129;
    --strength-ink: #a9d6bd;

    --recovery: #e0b854;
    --recovery-soft: #362d18;

    --band-bg: #0f120d;
    --band-ink: #f4f1e6;
    --band-muted: #8f8c7c;
  }
}

:root[data-theme="dark"] {
  --bg: #1c1c17;
  --bg-card: #262620;
  --bg-card-soft: #2c2c24;
  --ink: #eeece0;
  --ink-muted: #a6a290;
  --border: rgba(238, 236, 224, 0.12);
  --shadow: 0 8px 24px rgba(0, 0, 0, 0.4);

  --cardio: #e08561;
  --cardio-soft: #3a2a22;
  --cardio-ink: #f0b79c;

  --strength: #6fae8a;
  --strength-soft: #223129;
  --strength-ink: #a9d6bd;

  --recovery: #e0b854;
  --recovery-soft: #362d18;

  --band-bg: #0f120d;
  --band-ink: #f4f1e6;
  --band-muted: #8f8c7c;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
}

.poster {
  max-width: 900px;
  margin: 0 auto;
  padding: 32px 24px 64px;
}

.eyebrow {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin: 0 0 8px;
}

h1, h2, h3 { margin: 0; letter-spacing: -0.01em; }

.hero { text-align: center; margin-bottom: 32px; }
.hero h1 { font-size: clamp(32px, 6vw, 48px); font-weight: 800; margin-bottom: 12px; }
.hero .subtitle {
  color: var(--ink-muted);
  font-size: 17px;
  max-width: 560px;
  margin: 0 auto 24px;
  line-height: 1.5;
}

.stat-strip {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0;
  background: var(--bg-card);
  border-radius: 20px;
  box-shadow: var(--shadow);
  overflow: hidden;
  border: 1px solid var(--border);
}
.stat-strip .stat {
  flex: 1 1 140px;
  padding: 18px 20px;
  text-align: center;
  border-right: 1px solid var(--border);
}
.stat-strip .stat:last-child { border-right: none; }
.stat .value { font-size: 26px; font-weight: 800; }
.stat .unit { font-size: 15px; font-weight: 600; color: var(--ink-muted); }
.stat .label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-muted);
  margin-top: 4px;
}

section { margin-bottom: 32px; }
.section-head { text-align: center; margin-bottom: 20px; }
.section-head h2 { font-size: 26px; font-weight: 800; margin: 6px 0 10px; }
.section-head p { color: var(--ink-muted); max-width: 620px; margin: 0 auto; line-height: 1.5; }

.card {
  background: var(--bg-card);
  border-radius: 20px;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  padding: 20px;
  break-inside: avoid;
}

.map-card { padding: 16px; margin-bottom: 16px; }
.map-card img, .map-card svg { display: block; width: 100%; height: auto; border-radius: 12px; }
.map-attribution { font-size: 12px; color: var(--ink-muted); text-align: right; margin: 8px 4px 0; }
.map-attribution a { color: var(--ink-muted); }

.legend {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 24px;
  margin: 18px 0 8px;
  font-size: 14px;
  font-weight: 600;
}
.legend .swatch { display: inline-flex; align-items: center; gap: 8px; }
.legend .dot { width: 22px; height: 8px; border-radius: 4px; display: inline-block; }

.elevation-card h3 { font-size: 15px; font-weight: 700; margin-bottom: 12px; }

.panels {
  display: flex;
  gap: 20px;
  align-items: stretch;
}
.panel {
  flex: 1 1 0;
  border-radius: 20px;
  box-shadow: var(--shadow);
  border: 1px solid var(--border);
  padding: 24px;
  break-inside: avoid;
}
.panel.cardio { background: var(--cardio-soft); }
.panel.strength { background: var(--strength-soft); }

.panel .icon {
  width: 40px; height: 40px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 10px;
  color: #fff;
}
.panel.cardio .icon { background: var(--cardio); }
.panel.strength .icon { background: var(--strength); }

.panel .spot {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 4px;
}
.panel.cardio .spot { color: var(--cardio-ink); }
.panel.strength .spot { color: var(--strength-ink); }

.panel h3 { font-size: 22px; font-weight: 800; margin-bottom: 12px; }
.panel p.copy { line-height: 1.55; margin-bottom: 16px; }

.panel .stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
  border-top: 1px solid rgba(38,38,32,0.12);
  padding-top: 14px;
}
.panel .stat-row + .stat-row { border-top: none; padding-top: 0; margin-top: -2px; }
.panel .stat-row .item { min-width: 88px; }
.panel .stat-row .value { display: block; font-size: 19px; font-weight: 800; }
.panel .stat-row .label {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink-muted);
}

.benefit-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.benefit-card {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  background: var(--bg-card-soft);
  border-radius: 16px;
  padding: 16px 18px;
  border: 1px solid var(--border);
  break-inside: avoid;
}
.benefit-card .icon {
  flex: none;
  width: 34px; height: 34px;
  border-radius: 50%;
  background: var(--strength-soft);
  color: var(--strength-ink);
  display: flex; align-items: center; justify-content: center;
}
.benefit-card h4 { font-size: 15px; font-weight: 700; margin-bottom: 4px; }
.benefit-card p { font-size: 13.5px; color: var(--ink-muted); line-height: 1.5; margin: 0; }

.takeaway {
  background: var(--band-bg);
  color: var(--band-ink);
  border-radius: 20px;
  padding: 32px 28px;
  text-align: center;
  break-inside: avoid;
}
.takeaway .eyebrow { color: var(--band-muted); }
.takeaway h2 { font-size: 26px; font-weight: 800; margin-bottom: 12px; }
.takeaway p { color: var(--band-muted); max-width: 640px; margin: 0 auto; line-height: 1.6; }
.takeaway strong { color: var(--band-ink); }

footer {
  text-align: center;
  color: var(--ink-muted);
  font-size: 13px;
  margin-top: 24px;
}

.toolbar {
  position: fixed;
  right: 24px;
  bottom: 24px;
  display: flex;
  justify-content: center;
  margin-top: 8px;
}
.btn {
  background: var(--ink);
  color: var(--bg-card);
  border: none;
  border-radius: 999px;
  padding: 12px 24px;
  font-size: 15px;
  font-weight: 700;
  text-decoration: none;
  box-shadow: var(--shadow);
  cursor: pointer;
}

@media (max-width: 600px) {
  .panels { flex-direction: column; }
  .benefit-grid { grid-template-columns: 1fr; }
  .stat-strip .stat { flex: 1 1 45%; }
}

@media print {
  html, body { background: #eae6d9 !important; color: #262620 !important; }
  :root {
    --bg: #eae6d9; --bg-card: #fdfbf3; --bg-card-soft: #f6f2e6; --ink: #262620; --ink-muted: #6f6c5f;
    --border: rgba(38,38,32,0.12); --shadow: none;
    --cardio: #c1502f; --cardio-soft: #f3ddd2; --cardio-ink: #8a3a20;
    --strength: #2f6b4f; --strength-soft: #dde9df; --strength-ink: #234f3a;
    --recovery: #c99a2e; --recovery-soft: #f2e6c6;
    --band-bg: #23291f; --band-ink: #f4f1e6; --band-muted: #b9b6a6;
  }
  .no-print { display: none !important; }
  .poster { max-width: none; padding: 0; }
  .card, .panel, .benefit-card, .takeaway, section { break-inside: avoid; }
  @page { size: A4; margin: 12mm; }
}
`;

module.exports = { css };
