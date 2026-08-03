import { getNodeType } from './nodeTypes.js';
import { fetchNodesByLabel, fetchRelationshipsBetweenLabels } from './neo4j.js';
import { toPlainProperties } from './graphModel.js';
import { toCsvByKey } from './csv.js';
import { importNodesFromCsvText, importRelationshipsFromCsvText } from './csvImport.js';

export const RELATIONSHIPS_FILENAME = 'relationships.csv';
const MANIFEST_FILENAME = 'manifest.json';
const RELATIONSHIP_FIELDS = [{ key: 'relType' }, { key: 'fromId' }, { key: 'toId' }];

// A "mass export" shouldn't silently truncate at the app's normal 1000-row
// list-screen default - this is meant to cover a whole selected type.
const EXPORT_ROW_LIMIT = 200000;

/** Builds a Backup ZIP: one <typeKey>.csv per selected type (all fields,
 * keyed headers - same format as "Get CSV template"/toCsvByKey), a
 * relationships.csv covering edges directly between the selected types,
 * and a manifest.json for traceability. Returns a Blob ready to download. */
export async function buildBackupZip({ typeKeys, database }) {
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const typeDefs = typeKeys.map((key) => getNodeType(key)).filter(Boolean);

  for (const typeDef of typeDefs) {
    const records = await fetchNodesByLabel(
      { label: typeDef.matchLabel, sortField: typeDef.sortField, limit: EXPORT_ROW_LIMIT },
      database
    );
    const rows = records.map((r) => toPlainProperties(r.get('n').properties));
    zip.file(`${typeDef.key}.csv`, toCsvByKey(rows, typeDef.fields));
  }

  const matchLabels = typeDefs.map((t) => t.matchLabel);
  const relRecords = await fetchRelationshipsBetweenLabels({ labels: matchLabels }, database);
  const relRows = relRecords.map((r) => ({
    relType: r.get('relType'),
    fromId: r.get('fromId'),
    toId: r.get('toId')
  }));
  zip.file(RELATIONSHIPS_FILENAME, toCsvByKey(relRows, RELATIONSHIP_FIELDS));

  zip.file(MANIFEST_FILENAME, JSON.stringify({
    exportedAt: new Date().toISOString(),
    database,
    types: typeDefs.map((t) => t.key)
  }, null, 2));

  return zip.generateAsync({ type: 'blob' });
}

/** Restores a Backup ZIP: imports every recognized <typeKey>.csv first
 * (nodes have no cross-file dependency), then relationships.csv last, so
 * the ids it references already exist. Unrecognized files (a foreign zip,
 * or an entry for a type this app no longer knows) are silently ignored
 * rather than failing the whole restore. `onExisting` ('replace' | 'ignore'
 * | 'fail', see importNodesFromCsvText) applies uniformly to every type in
 * the archive - the caller asks once for the whole restore, not per type. */
export async function restoreBackupZip({ file, database, onExisting = 'fail' }) {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(file);
  const results = { types: [], relationships: null };

  for (const filename of Object.keys(zip.files)) {
    const entry = zip.files[filename];
    if (entry.dir || filename === RELATIONSHIPS_FILENAME || filename === MANIFEST_FILENAME) continue;
    if (!filename.toLowerCase().endsWith('.csv')) continue;

    const key = filename.replace(/\.csv$/i, '');
    const typeDef = getNodeType(key);
    if (!typeDef) continue;

    const text = await entry.async('string');
    const summary = await importNodesFromCsvText(typeDef, text, database, onExisting);
    results.types.push({ key, label: typeDef.pluralLabel, ...summary });
  }

  const relEntry = zip.file(RELATIONSHIPS_FILENAME);
  if (relEntry) {
    const text = await relEntry.async('string');
    results.relationships = await importRelationshipsFromCsvText(text, database);
  }

  return results;
}
