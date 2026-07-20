import React, { useCallback, useEffect, useState } from 'react';
import GraphView from '../components/GraphView.jsx';
import Inspector from '../components/Inspector.jsx';
import QueryBar from '../components/QueryBar.jsx';
import AddNodeModal from '../components/AddNodeModal.jsx';
import AddRelationshipModal from '../components/AddRelationshipModal.jsx';
import { useConnection } from '../lib/ConnectionContext.jsx';
import {
  runCypher,
  createNode,
  updateNodeProperties,
  addLabel,
  deleteNode,
  createRelationship,
  updateRelationshipProperties,
  deleteRelationship
} from '../lib/neo4j.js';
import { recordsToGraph } from '../lib/graphModel.js';

const DEFAULT_QUERY = 'MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 150';

export default function GraphExplorerPage() {
  const { database, isAdmin, knownLabels, knownTypes, refreshSchema } = useConnection();

  const [graph, setGraph] = useState({ nodes: [], relationships: [] });
  const [selection, setSelection] = useState(null); // { kind: 'node'|'relationship', data }
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null); // 'addNode' | 'addRelationship' | null

  function flashError(err) {
    setToast({ kind: 'error', message: err.message || String(err) });
    setTimeout(() => setToast(null), 6000);
  }

  const runAndRender = useCallback(async (cypher) => {
    setRunning(true);
    try {
      const records = await runCypher(cypher, {}, database);
      setGraph(recordsToGraph(records));
    } catch (err) {
      flashError(err);
    } finally {
      setRunning(false);
    }
  }, [database]);

  useEffect(() => {
    runAndRender(DEFAULT_QUERY);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database]);

  function handleSelectNode(node) {
    const full = graph.nodes.find((n) => n.id === node.id) || node;
    setSelection({ kind: 'node', data: full });
  }

  function handleSelectRelationship(rel) {
    const full = graph.relationships.find((r) => r.id === rel.id) || rel;
    setSelection({ kind: 'relationship', data: full });
  }

  async function withBusy(fn) {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      flashError(err);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    const records = await runCypher(DEFAULT_QUERY, {}, database);
    setGraph(recordsToGraph(records));
  }

  function requireAdmin() {
    if (!isAdmin) {
      throw new Error('Read-only profile: this account cannot make changes.');
    }
  }

  async function handleCreateNode({ labels, properties }) {
    requireAdmin();
    await createNode({ labels, properties }, database);
    setModal(null);
    await withBusy(refresh);
    refreshSchema();
  }

  async function handleCreateRelationship(payload) {
    requireAdmin();
    await createRelationship(payload, database);
    setModal(null);
    await withBusy(refresh);
    refreshSchema();
  }

  function handleUpdateNode(elementId, properties) {
    withBusy(async () => {
      requireAdmin();
      await updateNodeProperties({ elementId, properties }, database);
      await refresh();
      setSelection(null);
    });
  }

  function handleAddLabel(elementId, label) {
    withBusy(async () => {
      requireAdmin();
      await addLabel({ elementId, label }, database);
      await refresh();
      setSelection(null);
      refreshSchema();
    });
  }

  function handleDeleteNode(elementId) {
    withBusy(async () => {
      requireAdmin();
      await deleteNode({ elementId }, database);
      await refresh();
      setSelection(null);
    });
  }

  function handleUpdateRelationship(elementId, properties) {
    withBusy(async () => {
      requireAdmin();
      await updateRelationshipProperties({ elementId, properties }, database);
      await refresh();
      setSelection(null);
    });
  }

  function handleDeleteRelationship(elementId) {
    withBusy(async () => {
      requireAdmin();
      await deleteRelationship({ elementId }, database);
      await refresh();
      setSelection(null);
    });
  }

  return (
    <div className="page graph-explorer-page">
      <div className="toolbar">
        <QueryBar onRun={runAndRender} running={running} readOnly={!isAdmin} />
        <div className="toolbar-actions">
          {isAdmin ? (
            <>
              <button type="button" onClick={() => setModal('addNode')}>+ Node</button>
              <button type="button" onClick={() => setModal('addRelationship')}>+ Relationship</button>
            </>
          ) : (
            <span className="readonly-note">Read-only profile — sign in as admin to add or edit data.</span>
          )}
        </div>
      </div>

      <div className="main">
        <GraphView
          nodes={graph.nodes}
          relationships={graph.relationships}
          onSelectNode={handleSelectNode}
          onSelectRelationship={handleSelectRelationship}
          onDeselect={() => setSelection(null)}
        />
        <Inspector
          selection={selection}
          busy={busy}
          readOnly={!isAdmin}
          onUpdateNode={handleUpdateNode}
          onAddLabel={handleAddLabel}
          onDeleteNode={handleDeleteNode}
          onUpdateRelationship={handleUpdateRelationship}
          onDeleteRelationship={handleDeleteRelationship}
          onClose={() => setSelection(null)}
        />
      </div>

      {modal === 'addNode' && isAdmin && (
        <AddNodeModal
          knownLabels={knownLabels}
          busy={busy}
          onClose={() => setModal(null)}
          onCreate={handleCreateNode}
        />
      )}
      {modal === 'addRelationship' && isAdmin && (
        <AddRelationshipModal
          nodes={graph.nodes}
          knownTypes={knownTypes}
          busy={busy}
          onClose={() => setModal(null)}
          onCreate={handleCreateRelationship}
        />
      )}

      {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
    </div>
  );
}
