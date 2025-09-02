#!/usr/bin/env node
/*
  Generates an HTML report summarizing:
    - Hour-of-day posting frequency
    - Day-of-week posting frequency
  using the SQLite DB (hs.db) produced by scraper.py.

  Output: report.html at project root.

  Usage:
    node generate_report.js
*/

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'hs.db');
const OUTPUT = path.join(ROOT, 'report.html');

function loadRows() {
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare('SELECT id, title, url, user, points, time_posted FROM posts').all();
  db.close();
  return rows;
}

function computeTrends(rows) {
  const hourCounts = new Map(); // 0..23
  const dowCounts = new Map();  // 0..6 (Sun=0)

  const parseWhen = (val) => {
    if (!val) return null;
    if (typeof val === 'number') return new Date(val);
    if (typeof val === 'string') {
      // Handle formats like: "2025-08-29T21:01:53 1756501313"
      const parts = val.trim().split(/\s+/);
      // Prefer epoch seconds if present and numeric
      const maybeEpoch = parts[parts.length - 1];
      if (/^\d{10}$/.test(maybeEpoch)) {
        const ms = Number(maybeEpoch) * 1000;
        const d = new Date(ms);
        if (!isNaN(d)) return d;
      }
      // Fallback to the first token (ISO) or whole string
      const iso = parts[0] || val;
      const d = new Date(iso);
      if (!isNaN(d)) return d;
    }
    return null;
  };

  for (const r of rows) {
    const d = parseWhen(r.time_posted);
    if (!d) continue; // skip if unknown/unparsable
    // Date#getHours and #getDay return local time components
    const hour = d.getHours();
    const dow = d.getDay();

    hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    dowCounts.set(dow, (dowCounts.get(dow) || 0) + 1);
  }

  // Build arrays and filter zeroes as requested
  const hourArr = Array.from({ length: 24 }, (_, h) => [h, hourCounts.get(h) || 0])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const dowNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dowArr = Array.from({ length: 7 }, (_, d) => [dowNames[d], dowCounts.get(d) || 0])
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  return { hourArr, dowArr };
}

function generateHtml(hourArr, dowArr) {
  const TEMPLATE_PATH = path.join(ROOT, 'report.template.html');

  const hourRows = hourArr.map(([h, c]) => `<tr><td>${String(h).padStart(2, '0')}:00</td><td>${c}</td></tr>`).join('');
  const dowRows = dowArr.map(([d, c]) => `<tr><td>${d}</td><td>${c}</td></tr>`).join('');

  const now = new Date();
  const title = 'Hacker News Posting Trends';

  const hourTable = hourArr.length
    ? `<table>
      <thead><tr><th>Hour</th><th>Count</th></tr></thead>
      <tbody>${hourRows}</tbody>
    </table>`
    : `<p class="empty">No hour-of-day data yet.</p>`;

  const dowTable = dowArr.length
    ? `<table>
      <thead><tr><th>Day</th><th>Count</th></tr></thead>
      <tbody>${dowRows}</tbody>
    </table>`
    : `<p class="empty">No day-of-week data yet.</p>`;

  // Try to read external template; if missing, fallback to a minimal builtin template
  let template;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  } catch (e) {
    template = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{TITLE}}</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, 'Helvetica Neue', Arial, 'Noto Sans'; margin: 24px; background: #0b0c10; color: #e5e7eb; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 16px; }
    table { width: 100%; border-collapse: collapse; border-radius: 8px; overflow: hidden; }
    thead th { text-align: left; padding: 8px 10px; background: rgba(255,255,255,0.06); }
    tbody td { padding: 8px 10px; border-top: 1px solid rgba(255,255,255,0.08); }
    tbody tr:nth-child(even) { background: rgba(255,255,255,0.03); }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <h1>{{TITLE}}</h1>
  <p>Generated at {{GENERATED_AT}}</p>
  <div class="grid">
    <div>
      <h2>By Hour of Day (local time)</h2>
      {{HOUR_TABLE}}
    </div>
    <div>
      <h2>By Day of Week (local time)</h2>
      {{DOW_TABLE}}
    </div>
  </div>
  <p>Data source: SQLite database (hs.db) populated by scraper.py</p>
</body>
</html>`;
  }

  return template
    .replace(/{{TITLE}}/g, title)
    .replace(/{{GENERATED_AT}}/g, now.toLocaleString())
    .replace(/{{HOUR_TABLE}}/g, hourTable)
    .replace(/{{DOW_TABLE}}/g, dowTable);
}

(function main() {
  try {
    const rows = loadRows();
    const { hourArr, dowArr } = computeTrends(rows);
    const html = generateHtml(hourArr, dowArr);
    fs.writeFileSync(OUTPUT, html, 'utf8');
    console.log(`Report written to ${OUTPUT}. Rows analyzed: ${rows.length}`);
  } catch (err) {
    console.error('Failed to generate report:', err);
    process.exitCode = 1;
  }
})();
