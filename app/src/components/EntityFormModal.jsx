import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import NodeAutocomplete from './NodeAutocomplete.jsx';
import {
  createNode,
  updateNodeProperties,
  createRelationship,
  deleteRelationship,
  fetchRelated,
  toNeo4jDate,
  toNeo4jDateTime
} from '../lib/neo4j.js';
import { captionForNode } from '../lib/graphModel.js';

function slugify(text) {
  return String(text).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function initFieldValues(typeDef, mode, initialNode) {
  const out = {};
  for (const field of typeDef.fields) {
    const raw = mode === 'edit' ? initialNode?.properties?.[field.key] : undefined;
    if (raw === null || raw === undefined) {
      out[field.key] = '';
    } else if (field.inputType === 'date') {
      out[field.key] = String(raw).slice(0, 10);
    } else if (field.inputType === 'datetime') {
      out[field.key] = String(raw).slice(0, 16);
    } else {
      out[field.key] = raw;
    }
  }
  return out;
}

function initEmptyRelValues(typeDef) {
  const out = {};
  for (const rel of typeDef.relationships) {
    out[rel.key] = rel.cardinality === 'one' ? { selected: null, initial: null } : { selected: [], initial: [] };
  }
  return out;
}

function buildProperties(typeDef, values) {
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

function createRelationshipForRel(elementId, rel, target, database) {
  return rel.direction === 'in'
    ? createRelationship({ fromElementId: target.elementId, toElementId: elementId, type: rel.relType, properties: {} }, database)
    : createRelationship({ fromElementId: elementId, toElementId: target.elementId, type: rel.relType, properties: {} }, database);
}

async function syncRelationship({ elementId, rel, relValue, database }) {
  if (!relValue) return;
  if (rel.cardinality === 'one') {
    const initial = relValue.initial ?? null;
    const selected = relValue.selected ?? null;
    if ((initial?.elementId ?? null) === (selected?.elementId ?? null)) return;
    if (initial?.relId) await deleteRelationship({ elementId: initial.relId }, database);
    if (selected) await createRelationshipForRel(elementId, rel, selected, database);
  } else {
    const initial = relValue.initial ?? [];
    const selected = relValue.selected ?? [];
    const initialIds = new Set(initial.map((n) => n.elementId));
    const selectedIds = new Set(selected.map((n) => n.elementId));
    for (const item of initial) {
      if (!selectedIds.has(item.elementId) && item.relId) {
        await deleteRelationship({ elementId: item.relId }, database);
      }
    }
    for (const item of selected) {
      if (!initialIds.has(item.elementId)) {
        await createRelationshipForRel(elementId, rel, item, database);
      }
    }
  }
}

function ScalarField({ field, value, onChange, disabled }) {
  if (field.options) {
    return (
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">—</option>
        {field.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (field.inputType === 'textarea') {
    return <textarea rows={3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
  }
  const type = field.inputType === 'datetime' ? 'datetime-local' : (field.inputType || 'text');
  return <input type={type} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} />;
}

export default function EntityFormModal({ typeDef, mode, initialNode, onClose, onSaved, database }) {
  const [values, setValues] = useState(() => initFieldValues(typeDef, mode, initialNode));
  const [relValues, setRelValues] = useState(() => initEmptyRelValues(typeDef));
  const [loadingRelationships, setLoadingRelationships] = useState(mode === 'edit' && typeDef.relationships.length > 0);
  const [idTouched, setIdTouched] = useState(mode === 'edit');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  useEffect(() => {
    if (mode !== 'edit' || typeDef.relationships.length === 0) return undefined;
    let cancelled = false;
    (async () => {
      const next = {};
      for (const rel of typeDef.relationships) {
        const records = await fetchRelated(
          { elementId: initialNode.elementId, relType: rel.relType, direction: rel.direction },
          database
        );
        const items = records.map((r) => {
          const node = r.get('t');
          return { elementId: node.elementId, relId: r.get('relId'), caption: captionForNode(node), labels: node.labels };
        });
        next[rel.key] = rel.cardinality === 'one'
          ? { selected: items[0] ?? null, initial: items[0] ?? null }
          : { selected: items, initial: items };
      }
      if (!cancelled) {
        setRelValues(next);
        setLoadingRelationships(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initialNode, typeDef]);

  function handleFieldChange(field, raw) {
    setValues((v) => {
      const next = { ...v, [field.key]: raw };
      if (field.key === 'name' && mode === 'create' && !idTouched) {
        next.id = raw ? `${typeDef.idPrefix}-${slugify(raw)}` : '';
      }
      return next;
    });
  }

  function handleIdChange(raw) {
    setIdTouched(true);
    setValues((v) => ({ ...v, id: raw }));
  }

  function handleRelSelectOne(relKey, node) {
    setRelValues((v) => ({ ...v, [relKey]: { ...v[relKey], selected: node } }));
  }
  function handleRelClearOne(relKey) {
    setRelValues((v) => ({ ...v, [relKey]: { ...v[relKey], selected: null } }));
  }
  function handleRelAddMany(relKey, node) {
    setRelValues((v) => {
      const cur = v[relKey]?.selected ?? [];
      if (cur.some((n) => n.elementId === node.elementId)) return v;
      return { ...v, [relKey]: { ...v[relKey], selected: [...cur, node] } };
    });
  }
  function handleRelRemoveMany(relKey, elementId) {
    setRelValues((v) => ({
      ...v,
      [relKey]: { ...v[relKey], selected: (v[relKey]?.selected ?? []).filter((n) => n.elementId !== elementId) }
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);

    for (const field of typeDef.fields) {
      if (field.required && !values[field.key]) {
        setFormError(`${field.label} is required.`);
        return;
      }
    }
    for (const rel of typeDef.relationships) {
      if (rel.required && rel.cardinality === 'one' && !relValues[rel.key]?.selected) {
        setFormError(`${rel.label} is required.`);
        return;
      }
    }

    setSaving(true);
    try {
      const properties = buildProperties(typeDef, values);
      let elementId;
      if (mode === 'create') {
        const created = await createNode({ labels: typeDef.labels, properties }, database);
        elementId = created.elementId;
      } else {
        elementId = initialNode.elementId;
        const { id: _id, ...rest } = properties;
        await updateNodeProperties({ elementId, properties: rest }, database);
      }

      for (const rel of typeDef.relationships) {
        await syncRelationship({ elementId, rel, relValue: relValues[rel.key], database });
      }

      onSaved();
      onClose();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`${mode === 'create' ? 'New' : 'Edit'} ${typeDef.label}`} onClose={onClose} wide>
      <form onSubmit={handleSubmit} className="entity-form">
        {typeDef.fields.map((field) => (
          <div className="form-field" key={field.key}>
            <label>{field.label}{field.required && ' *'}</label>
            {field.key === 'id' ? (
              <input
                type="text"
                value={values.id ?? ''}
                onChange={(e) => handleIdChange(e.target.value)}
                disabled={mode === 'edit' && field.readOnlyOnEdit}
                placeholder={`e.g. ${typeDef.idPrefix}-example`}
              />
            ) : (
              <ScalarField field={field} value={values[field.key]} onChange={(v) => handleFieldChange(field, v)} />
            )}
          </div>
        ))}

        {typeDef.relationships.length > 0 && <h4>Relationships</h4>}
        {loadingRelationships && <p className="readonly-note">Loading current relationships…</p>}
        {!loadingRelationships && typeDef.relationships.map((rel) => (
          <div className="form-field relationship-field" key={rel.key}>
            <label>{rel.label}{rel.required && ' *'}</label>
            {rel.cardinality === 'one' ? (
              relValues[rel.key]?.selected ? (
                <div className="chip-row">
                  <span className="chip chip-selected">
                    {relValues[rel.key].selected.caption}
                    <button type="button" className="chip-remove" onClick={() => handleRelClearOne(rel.key)}>&times;</button>
                  </span>
                </div>
              ) : (
                <NodeAutocomplete
                  targetLabels={rel.targetLabels}
                  database={database}
                  placeholder={`Search ${rel.label.toLowerCase()}…`}
                  onSelect={(node) => handleRelSelectOne(rel.key, node)}
                />
              )
            ) : (
              <>
                <div className="chip-row">
                  {(relValues[rel.key]?.selected ?? []).map((item) => (
                    <span className="chip chip-selected" key={item.elementId}>
                      {item.caption}
                      <button type="button" className="chip-remove" onClick={() => handleRelRemoveMany(rel.key, item.elementId)}>&times;</button>
                    </span>
                  ))}
                </div>
                <NodeAutocomplete
                  targetLabels={rel.targetLabels}
                  database={database}
                  placeholder={`Add ${rel.label.toLowerCase()}…`}
                  excludeIds={(relValues[rel.key]?.selected ?? []).map((i) => i.elementId)}
                  onSelect={(node) => handleRelAddMany(rel.key, node)}
                />
              </>
            )}
          </div>
        ))}

        {formError && <p className="form-error">{formError}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={saving || loadingRelationships}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
