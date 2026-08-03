import { createNode, replaceNodeByBusinessId, findExistingIds, createRelationshipByBusinessId } from './neo4j.js';
import { buildProperties } from './formUtils.js';
import { parseCsv } from './csv.js';

/** Resolves a parsed CSV row's headers against a type's fields by either
 * property key (the "Get CSV template" header) or display label (what
 * "Export CSV" writes), case-insensitively - so a round-tripped export
 * (edited in a spreadsheet) and a filled-in template both import cleanly.
 * Unrecognized extra columns are ignored. */
export function normalizeImportRow(typeDef, raw) {
  const lower = {};
  for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;
  const out = {};
  for (const field of typeDef.fields) {
    out[field.key] = lower[field.key.toLowerCase()] ?? lower[field.label.toLowerCase()] ?? '';
  }
  return out;
}

/** Bulk-creates (or, for rows whose `id` already exists, replaces/ignores)
 * nodes of one type from CSV text: one row per node, via the same
 * createNode + buildProperties path as a manual Create form submit.
 * Rows missing a required field fail validation before any write; every
 * other row is attempted independently. Shared by the single-type "Import
 * CSV" on each business screen and the multi-type Backup & Restore screen.
 *
 * `onExisting` controls what happens when a row's `id` already exists:
 *   - 'replace' - overwrite the existing node's properties (SET n = ...)
 *   - 'ignore'  - leave the existing node untouched, skip the row
 *   - 'fail'    - (default) attempt CREATE regardless; a duplicate id is
 *                 rejected by the uniqueness constraint and recorded as a
 *                 per-row failure, same as before this mode existed
 * Rows whose `id` is new are always created, regardless of `onExisting`. */
export async function importNodesFromCsvText(typeDef, csvText, database, onExisting = 'fail') {
  const parsedRows = parseCsv(csvText);
  const rows = parsedRows.map((raw) => normalizeImportRow(typeDef, raw));
  const summary = { total: rows.length, created: 0, replaced: 0, ignored: 0, failed: [] };

  const existingIds = onExisting === 'fail'
    ? new Set()
    : new Set(await findExistingIds(
      { matchLabel: typeDef.matchLabel, ids: rows.map((r) => r.id).filter(Boolean) },
      database
    ));

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const rowNumber = i + 2; // header is row 1
    const missingField = typeDef.fields.find((f) => f.required && !row[f.key]);
    if (missingField) {
      summary.failed.push({ row: rowNumber, id: row.id, message: `${missingField.label} is required` });
      continue;
    }
    const exists = existingIds.has(row.id);
    try {
      if (exists && onExisting === 'ignore') {
        summary.ignored += 1;
      } else if (exists && onExisting === 'replace') {
        const properties = buildProperties(typeDef, row);
        await replaceNodeByBusinessId({ id: row.id, properties }, database);
        summary.replaced += 1;
      } else {
        const properties = buildProperties(typeDef, row);
        await createNode({ labels: typeDef.labels, properties }, database);
        summary.created += 1;
      }
    } catch (err) {
      summary.failed.push({ row: rowNumber, id: row.id, message: err.message });
    }
  }

  return summary;
}

/** Bulk-creates relationships from CSV text shaped like the app's own
 * relationships.csv export: relType,fromId,toId columns (case-insensitive
 * header match, extra columns ignored). Used by Backup & Restore, after
 * all the node CSVs in the same archive have already been imported so the
 * ids these rows reference actually exist. */
export async function importRelationshipsFromCsvText(csvText, database) {
  const parsedRows = parseCsv(csvText);
  const summary = { total: parsedRows.length, created: 0, failed: [] };

  for (let i = 0; i < parsedRows.length; i += 1) {
    const rowNumber = i + 2;
    const lower = {};
    for (const [k, v] of Object.entries(parsedRows[i])) lower[k.toLowerCase()] = v;
    const relType = lower.reltype;
    const fromId = lower.fromid;
    const toId = lower.toid;
    if (!relType || !fromId || !toId) {
      summary.failed.push({ row: rowNumber, message: 'relType, fromId, and toId are all required' });
      continue;
    }
    try {
      await createRelationshipByBusinessId({ fromId, toId, type: relType }, database);
      summary.created += 1;
    } catch (err) {
      summary.failed.push({ row: rowNumber, message: `${fromId} -[${relType}]-> ${toId}: ${err.message}` });
    }
  }

  return summary;
}
