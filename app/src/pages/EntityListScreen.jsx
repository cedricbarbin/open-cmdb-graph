import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getNodeType } from '../lib/nodeTypes.js';
import { useConnection } from '../lib/ConnectionContext.jsx';
import { fetchNodesByLabel, deleteNode } from '../lib/neo4j.js';
import { toPlainProperties, captionFor } from '../lib/graphModel.js';
import { toCsv, downloadCsv } from '../lib/csv.js';
import EntityFormModal from '../components/EntityFormModal.jsx';
import DetailGraphModal from '../components/DetailGraphModal.jsx';

function formatCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

export default function EntityListScreen() {
  const { typeKey } = useParams();
  const typeDef = getNodeType(typeKey);
  const { database, isAdmin } = useConnection();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterText, setFilterText] = useState('');
  const [formModal, setFormModal] = useState(null); // { mode, initialNode } | null
  const [detailModal, setDetailModal] = useState(null); // { elementId, caption } | null

  useEffect(() => {
    if (!typeDef) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeDef?.key, database]);

  async function load() {
    if (!typeDef) return;
    setLoading(true);
    setError(null);
    try {
      const records = await fetchNodesByLabel({ label: typeDef.matchLabel, sortField: typeDef.sortField }, database);
      let nextRows = records.map((r) => {
        const node = r.get('n');
        return { elementId: node.elementId, labels: node.labels, properties: toPlainProperties(node.properties) };
      });
      if (typeDef.sortDirection === 'DESC') nextRows = nextRows.reverse();
      setRows(nextRows);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const filteredRows = useMemo(() => {
    if (!typeDef || !filterText.trim()) return rows;
    const term = filterText.toLowerCase();
    return rows.filter((row) =>
      typeDef.columns.some((col) => String(row.properties[col.key] ?? '').toLowerCase().includes(term))
    );
  }, [rows, filterText, typeDef]);

  function handleExportCsv() {
    const csvRows = filteredRows.map((row) => row.properties);
    const csv = toCsv(csvRows, typeDef.columns);
    downloadCsv(`${typeDef.key}.csv`, csv);
  }

  async function handleDelete(row) {
    const caption = captionFor(row.labels, row.properties);
    if (!window.confirm(`Delete ${typeDef.label.toLowerCase()} "${caption}" and all its relationships?`)) return;
    try {
      await deleteNode({ elementId: row.elementId }, database);
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!typeDef) {
    return (
      <div className="page">
        <p>Unknown entity type "{typeKey}".</p>
      </div>
    );
  }

  return (
    <div className="page entity-list-page">
      <div className="page-header">
        <h2>{typeDef.pluralLabel}</h2>
        <div className="page-header-actions">
          <input
            className="filter-input"
            placeholder="Filter…"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          <button type="button" onClick={handleExportCsv} disabled={filteredRows.length === 0}>
            Export CSV
          </button>
          {isAdmin && (
            <button type="button" onClick={() => setFormModal({ mode: 'create' })}>
              + New {typeDef.label}
            </button>
          )}
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p className="readonly-note">Loading…</p>
      ) : (
        <div className="table-wrapper">
          <table className="entity-table">
            <thead>
              <tr>
                {typeDef.columns.map((col) => <th key={col.key}>{col.label}</th>)}
                <th className="row-actions-header">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row) => (
                <tr key={row.elementId}>
                  {typeDef.columns.map((col) => (
                    <td key={col.key}>{formatCell(row.properties[col.key])}</td>
                  ))}
                  <td className="row-actions">
                    <button
                      type="button"
                      onClick={() => setDetailModal({ elementId: row.elementId, caption: captionFor(row.labels, row.properties) })}
                    >
                      Detail
                    </button>
                    {isAdmin && (
                      <>
                        <button type="button" onClick={() => setFormModal({ mode: 'edit', initialNode: row })}>
                          Edit
                        </button>
                        <button type="button" className="danger" onClick={() => handleDelete(row)}>
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={typeDef.columns.length + 1} className="table-empty">
                    No {typeDef.pluralLabel.toLowerCase()} found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {formModal && (
        <EntityFormModal
          typeDef={typeDef}
          mode={formModal.mode}
          initialNode={formModal.initialNode}
          database={database}
          onClose={() => setFormModal(null)}
          onSaved={load}
        />
      )}
      {detailModal && (
        <DetailGraphModal
          elementId={detailModal.elementId}
          caption={detailModal.caption}
          database={database}
          onClose={() => setDetailModal(null)}
        />
      )}
    </div>
  );
}
