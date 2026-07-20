import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import GraphView from './GraphView.jsx';
import { fetchNeighborhood } from '../lib/neo4j.js';
import { recordsToGraph, mergeGraphs } from '../lib/graphModel.js';

/** Shows a node's dependency graph starting from its 1-hop neighborhood.
 * Clicking any node in the canvas fetches *that* node's neighbors too and
 * merges them in - the graph grows as you explore instead of navigating
 * away. Purely for exploration: no editing here (use the Graph Explorer or
 * the row's Edit action for that). */
export default function DetailGraphModal({ elementId, caption, database, onClose }) {
  const [graph, setGraph] = useState({ nodes: [], relationships: [] });
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchNeighborhood(elementId, database)
      .then((records) => {
        if (cancelled) return;
        setGraph(recordsToGraph(records));
        setExpandedIds(new Set([elementId]));
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [elementId, database]);

  async function handleExpand(node) {
    if (expandedIds.has(node.id)) return;
    setLoading(true);
    try {
      const records = await fetchNeighborhood(node.id, database);
      const fetched = recordsToGraph(records);
      setGraph((g) => mergeGraphs(g, fetched));
      setExpandedIds((prev) => new Set(prev).add(node.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal title={`Dependencies: ${caption}`} onClose={onClose} wide>
      <p className="modal-hint">
        Click a node to expand its connections. {loading && 'Loading…'}
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="detail-graph">
        <GraphView
          nodes={graph.nodes}
          relationships={graph.relationships}
          onSelectNode={handleExpand}
          onSelectRelationship={() => {}}
          onDeselect={() => {}}
        />
      </div>
    </Modal>
  );
}
