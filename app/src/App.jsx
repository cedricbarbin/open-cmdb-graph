import React, { useCallback, useState } from 'react';
import ConnectionPanel from './components/ConnectionPanel.jsx';
import GraphView from './components/GraphView.jsx';
import Inspector from './components/Inspector.jsx';
import QueryBar from './components/QueryBar.jsx';
import AddNodeModal from './components/AddNodeModal.jsx';
import AddRelationshipModal from './components/AddRelationshipModal.jsx';
import {
  connect,
  disconnect,
  runCypher,
  createNode,
  updateNodeProperties,
  addLabel,
  deleteNode,
  createRelationship,
  updateRelationshipProperties,
  deleteRelationship,
  fetchAllLabels,
  fetchAllRelationshipTypes,
  getCurrentUserProfile
} from './lib/neo4j.js';
import { recordsToGraph } from './lib/graphModel.js';

export default function App() {
  const [connection, setConnection] = useState(null); // { database }
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const [profile, setProfile] = useState(null); // { username, roles, profile: 'admin'|'readonly', detected }
  const isAdmin = profile?.profile === 'admin';

  const [graph, setGraph] = useState({ nodes: [], relationships: [] });
  const [selection, setSelection] = useState(null); // { kind: 'node'|'relationship', data }
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const [knownLabels, setKnownLabels] = useState([]);
  const [knownTypes, setKnownTypes] = useState([]);
  const [modal, setModal] = useState(null); // 'addNode' | 'addRelationship' | null

  function flashError(err) {
    setToast({ kind: 'error', message: err.message || String(err) });
    setTimeout(() => setToast(null), 6000);
  }

  const runAndRender = useCallback(async (cypher) => {
    setRunning(true);
    try {
      const records = await runCypher(cypher, {}, connection?.database);
      setGraph(recordsToGraph(records));
    } catch (err) {
      flashError(err);
    } finally {
      setRunning(false);
    }
  }, [connection]);

  async function handleConnect(form) {
    setConnecting(true);
    setConnectionError(null);
    try {
      await connect(form);
      const detectedProfile = await getCurrentUserProfile();
      setProfile(detectedProfile);
      setConnection({ database: form.database });
      const [labels, types] = await Promise.all([
        fetchAllLabels(form.database),
        fetchAllRelationshipTypes(form.database)
      ]);
      setKnownLabels(labels);
      setKnownTypes(types);
      await runAndRender('MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 150');
    } catch (err) {
      setConnectionError(err.message);
    } finally {
      setConnecting(false);
    }
  }

  function handleDisconnect() {
    disconnect();
    setConnection(null);
    setProfile(null);
    setGraph({ nodes: [], relationships: [] });
    setSelection(null);
  }

  /** Defense-in-depth: the real enforcement is Neo4j's own role privileges
   * (a write rejected server-side stays rejected regardless of this check).
   * This just keeps mutation handlers from firing when the UI that should
   * have hidden them was somehow bypassed. */
  function requireAdmin() {
    if (!isAdmin) {
      throw new Error('Read-only profile: this account cannot make changes.');
    }
  }

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
    const records = await runCypher('MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 150', {}, connection?.database);
    setGraph(recordsToGraph(records));
  }

  async function handleCreateNode({ labels, properties }) {
    requireAdmin();
    await createNode({ labels, properties }, connection?.database);
    setModal(null);
    await withBusy(refresh);
  }

  async function handleCreateRelationship(payload) {
    requireAdmin();
    await createRelationship(payload, connection?.database);
    setModal(null);
    await withBusy(refresh);
  }

  function handleUpdateNode(elementId, properties) {
    withBusy(async () => {
      requireAdmin();
      await updateNodeProperties({ elementId, properties }, connection?.database);
      await refresh();
      setSelection(null);
    });
  }

  function handleAddLabel(elementId, label) {
    withBusy(async () => {
      requireAdmin();
      await addLabel({ elementId, label }, connection?.database);
      await refresh();
      setSelection(null);
    });
  }

  function handleDeleteNode(elementId) {
    withBusy(async () => {
      requireAdmin();
      await deleteNode({ elementId }, connection?.database);
      await refresh();
      setSelection(null);
    });
  }

  function handleUpdateRelationship(elementId, properties) {
    withBusy(async () => {
      requireAdmin();
      await updateRelationshipProperties({ elementId, properties }, connection?.database);
      await refresh();
      setSelection(null);
    });
  }

  function handleDeleteRelationship(elementId) {
    withBusy(async () => {
      requireAdmin();
      await deleteRelationship({ elementId }, connection?.database);
      await refresh();
      setSelection(null);
    });
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>CMDB Graph Explorer</h1>
        <ConnectionPanel
          connected={!!connection}
          connecting={connecting}
          error={connectionError}
          profile={profile}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
        />
      </header>

      {connection && (
        <>
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
        </>
      )}

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
