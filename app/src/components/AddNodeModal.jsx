import React, { useState } from 'react';
import Modal from './Modal.jsx';
import PropertyEditor, { rowsToProperties } from './PropertyEditor.jsx';

const CMDB_LABELS = [
  'Datacenter', 'CloudRegion', 'Physical', 'Virtual', 'Container',
  'Application', 'Team', 'Person', 'Incident', 'Ticket'
];

export default function AddNodeModal({ knownLabels = [], onClose, onCreate, busy }) {
  const [labelsInput, setLabelsInput] = useState('');
  const [rows, setRows] = useState([{ key: 'id', value: '' }, { key: 'name', value: '' }]);
  const [formError, setFormError] = useState(null);

  const suggestions = Array.from(new Set([...CMDB_LABELS, ...knownLabels]));

  function toggleLabel(label) {
    const current = labelsInput.split(',').map((l) => l.trim()).filter(Boolean);
    if (current.includes(label)) {
      setLabelsInput(current.filter((l) => l !== label).join(', '));
    } else {
      setLabelsInput([...current, label].join(', '));
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    const labels = labelsInput.split(',').map((l) => l.trim()).filter(Boolean);
    if (labels.length === 0) {
      setFormError('Pick at least one label.');
      return;
    }
    const properties = rowsToProperties(rows);
    if (!properties.id) {
      setFormError('Every node needs an "id" property (used for MERGE lookups elsewhere).');
      return;
    }
    try {
      await onCreate({ labels, properties });
    } catch (err) {
      setFormError(err.message);
    }
  }

  return (
    <Modal title="Add node" onClose={onClose}>
      <form onSubmit={handleSubmit} className="entity-form">
        <label>Labels</label>
        <div className="chip-picker">
          {suggestions.map((label) => (
            <button
              type="button"
              key={label}
              className={`chip ${labelsInput.includes(label) ? 'chip-selected' : ''}`}
              onClick={() => toggleLabel(label)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          value={labelsInput}
          onChange={(e) => setLabelsInput(e.target.value)}
          placeholder="e.g. Server, Physical"
        />

        <label>Properties</label>
        <PropertyEditor rows={rows} onChange={setRows} />

        {formError && <p className="form-error">{formError}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create node'}</button>
        </div>
      </form>
    </Modal>
  );
}
