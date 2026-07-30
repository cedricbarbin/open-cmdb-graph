function csvEscape(value) {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** columns: [{key,label}], rows: array of plain objects keyed by column.key */
export function toCsv(rows, columns) {
  const header = columns.map((c) => csvEscape(c.label)).join(',');
  const lines = rows.map((row) => columns.map((c) => csvEscape(row[c.key])).join(','));
  return [header, ...lines].join('\r\n');
}

/** Header-only CSV for a "fill this in" template - uses each field's raw
 * property key (not its display label) so a filled-in copy round-trips
 * straight back through parseCsv() into the right property names. */
export function toCsvTemplate(fields) {
  return fields.map((f) => csvEscape(f.key)).join(',') + '\r\n';
}

/** Like toCsv, but headered by each field's raw property key instead of
 * its display label - the machine round-trip format used by Backup &
 * Restore (and matching what toCsvTemplate/"Get CSV template" produces),
 * as opposed to toCsv's human-report format for one-off Export CSV. */
export function toCsvByKey(rows, fields) {
  const header = fields.map((f) => csvEscape(f.key)).join(',');
  const lines = rows.map((row) => fields.map((f) => csvEscape(row[f.key])).join(','));
  return [header, ...lines].join('\r\n');
}

export function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function downloadCsv(filename, csvContent) {
  downloadBlob(filename, new Blob([csvContent], { type: 'text/csv;charset=utf-8;' }));
}

/** Minimal RFC4180-ish CSV parser: handles quoted fields ("" for a literal
 * quote, commas/newlines inside quotes) and both \r\n and \n line endings.
 * Returns an array of row arrays; the caller pairs the first row with the
 * rest as a header. */
export function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += char; i += 1; continue;
    }
    if (char === '"') { inQuotes = true; i += 1; continue; }
    if (char === ',') { row.push(field); field = ''; i += 1; continue; }
    if (char === '\r') { i += 1; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += char; i += 1;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/** Parses CSV text with a header row into an array of plain objects keyed
 * by (trimmed) header cell. Missing cells for a row become ''. */
export function parseCsv(text) {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const [header, ...dataRows] = rows;
  const keys = header.map((h) => h.trim());
  return dataRows.map((cells) => {
    const obj = {};
    keys.forEach((key, idx) => { obj[key] = (cells[idx] ?? '').trim(); });
    return obj;
  });
}
