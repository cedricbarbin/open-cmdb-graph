import React from 'react';

/** Renders a list of editable key/value rows and reports changes as a
 * plain object via onChange. Values are parsed as JSON when possible
 * (so numbers/booleans/null survive), otherwise kept as strings. */
export default function PropertyEditor({ rows, onChange }) {
  function updateRow(index, patch) {
    const next = rows.slice();
    next[index] = { ...next[index], ...patch };
    onChange(next);
  }

  function addRow() {
    onChange([...rows, { key: '', value: '' }]);
  }

  function removeRow(index) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className="property-editor">
      {rows.map((row, index) => (
        <div className="property-row" key={index}>
          <input
            className="property-key"
            placeholder="property"
            value={row.key}
            onChange={(e) => updateRow(index, { key: e.target.value })}
          />
          <input
            className="property-value"
            placeholder="value"
            value={row.value}
            onChange={(e) => updateRow(index, { value: e.target.value })}
          />
          <button type="button" className="icon-btn" onClick={() => removeRow(index)} title="Remove">
            &times;
          </button>
        </div>
      ))}
      <button type="button" className="link-btn" onClick={addRow}>
        + add property
      </button>
    </div>
  );
}

export function rowsToProperties(rows) {
  const properties = {};
  for (const { key, value } of rows) {
    if (!key.trim()) continue;
    properties[key.trim()] = parseValue(value);
  }
  return properties;
}

export function propertiesToRows(properties = {}) {
  return Object.entries(properties).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value)
  }));
}

function parseValue(raw) {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (!Number.isNaN(Number(trimmed)) && trimmed !== '') return Number(trimmed);
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === 'object') return parsed;
  } catch {
    // not JSON - keep as plain string
  }
  return trimmed;
}
