import React, { useState } from 'react';
import Modal from './Modal.jsx';
import PropertyEditor, { rowsToProperties } from './PropertyEditor.jsx';

const CMDB_REL_TYPES = [
  'LOCATED_IN', 'HOSTED_ON', 'RUNS_ON', 'DEPLOYED_ON', 'DEPENDS_ON',
  'OWNS', 'MANAGES', 'MEMBER_OF', 'IMPACTS', 'REPORTED_BY',
  'TRACKS', 'CONCERNS', 'ASSIGNED_TO', 'OPENED_BY',
  'HAS_INTERFACE', 'HAS_IP', 'SUPPLIED_BY', 'COVERED_BY', 'PROVIDED_BY',
  'REQUESTED_BY', 'APPROVED_BY', 'RELATES_TO', 'IN_ENVIRONMENT', 'HAS_SLA',
  'OWNS_DATA', 'CONSUMES_DATA', 'CLASSIFIED_AS', 'STORED_ON'
];

export default function AddRelationshipModal({ nodes = [], knownTypes = [], onClose, onCreate, busy }) {
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [type, setType] = useState('');
  const [rows, setRows] = useState([]);
  const [formError, setFormError] = useState(null);

  const typeSuggestions = Array.from(new Set([...CMDB_REL_TYPES, ...knownTypes]));

  function nodeLabel(node) {
    return `${node.captions?.[0]?.value ?? node.id} [${node.labels.join(':')}]`;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    if (!fromId || !toId) {
      setFormError('Choose both a source and a target node.');
      return;
    }
    if (!type.trim()) {
      setFormError('Relationship type is required.');
      return;
    }
    try {
      await onCreate({
        fromElementId: fromId,
        toElementId: toId,
        type: type.trim().toUpperCase(),
        properties: rowsToProperties(rows)
      });
    } catch (err) {
      setFormError(err.message);
    }
  }

  return (
    <Modal title="Add relationship" onClose={onClose}>
      <form onSubmit={handleSubmit} className="entity-form">
        <label>From</label>
        <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
          <option value="">Select source node…</option>
          {nodes.map((n) => (
            <option value={n.id} key={n.id}>{nodeLabel(n)}</option>
          ))}
        </select>

        <label>To</label>
        <select value={toId} onChange={(e) => setToId(e.target.value)}>
          <option value="">Select target node…</option>
          {nodes.map((n) => (
            <option value={n.id} key={n.id}>{nodeLabel(n)}</option>
          ))}
        </select>

        <label>Type</label>
        <input
          value={type}
          onChange={(e) => setType(e.target.value)}
          placeholder="e.g. DEPENDS_ON"
          list="rel-type-suggestions"
        />
        <datalist id="rel-type-suggestions">
          {typeSuggestions.map((t) => <option value={t} key={t} />)}
        </datalist>

        <label>Properties</label>
        <PropertyEditor rows={rows} onChange={setRows} />

        {formError && <p className="form-error">{formError}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create relationship'}</button>
        </div>
      </form>
    </Modal>
  );
}
