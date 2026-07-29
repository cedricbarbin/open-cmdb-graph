import { toNeo4jDate, toNeo4jDateTime } from './neo4j.js';

/** Converts a flat object of string values (form state, or a CSV row) into
 * Neo4j-ready properties for a given type: numbers/dates/datetimes are
 * coerced per the field's inputType, blank values are omitted entirely
 * (so an edit's SET n += properties doesn't clobber existing values with
 * empty strings, and a CSV import doesn't write '' for unfilled cells).
 * Shared by EntityFormModal.jsx (manual create/edit) and csvImport.js
 * (single-type and bulk backup/restore CSV import), so both paths coerce
 * field types identically. */
export function buildProperties(typeDef, values) {
  const out = {};
  for (const field of typeDef.fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === '') continue;
    if (field.inputType === 'number') out[field.key] = Number(raw);
    else if (field.inputType === 'date') out[field.key] = toNeo4jDate(raw);
    else if (field.inputType === 'datetime') out[field.key] = toNeo4jDateTime(raw);
    else out[field.key] = raw;
  }
  return out;
}
