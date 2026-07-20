import React, { useEffect, useState } from 'react';
import PropertyEditor, { propertiesToRows, rowsToProperties } from './PropertyEditor.jsx';

export default function Inspector({ selection, onUpdateNode, onDeleteNode, onAddLabel, onUpdateRelationship, onDeleteRelationship, onClose, busy }) {
  const [rows, setRows] = useState([]);
  const [newLabel, setNewLabel] = useState('');

  useEffect(() => {
    if (selection) setRows(propertiesToRows(selection.data.properties));
  }, [selection]);

  if (!selection) {
    return (
      <div className="inspector empty">
        <p>Click a node or relationship to inspect and edit it.</p>
      </div>
    );
  }

  const { kind, data } = selection;

  function handleSave() {
    const properties = rowsToProperties(rows);
    if (kind === 'node') {
      onUpdateNode(data.id, properties);
    } else {
      onUpdateRelationship(data.id, properties);
    }
  }

  function handleDelete() {
    const confirmed = window.confirm(
      kind === 'node'
        ? `Delete node "${data.captions?.[0]?.value ?? data.id}" and all its relationships?`
        : `Delete this ${data.type} relationship?`
    );
    if (!confirmed) return;
    if (kind === 'node') onDeleteNode(data.id);
    else onDeleteRelationship(data.id);
  }

  function handleAddLabel(e) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    onAddLabel(data.id, newLabel.trim());
    setNewLabel('');
  }

  return (
    <div className="inspector">
      <div className="inspector-header">
        <div>
          {kind === 'node' ? (
            <>
              <div className="inspector-labels">
                {data.labels.map((l) => (
                  <span className="label-chip" key={l}>{l}</span>
                ))}
              </div>
              <h3>{data.captions?.[0]?.value}</h3>
            </>
          ) : (
            <h3>:{data.type}</h3>
          )}
        </div>
        <button type="button" className="icon-btn" onClick={onClose}>&times;</button>
      </div>

      {kind === 'node' && (
        <form className="inline-form" onSubmit={handleAddLabel}>
          <input
            placeholder="add label…"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <button type="submit">Add</button>
        </form>
      )}

      <h4>Properties</h4>
      <PropertyEditor rows={rows} onChange={setRows} />

      <div className="inspector-actions">
        <button type="button" onClick={handleSave} disabled={busy}>Save changes</button>
        <button type="button" className="danger" onClick={handleDelete} disabled={busy}>Delete {kind}</button>
      </div>
    </div>
  );
}
