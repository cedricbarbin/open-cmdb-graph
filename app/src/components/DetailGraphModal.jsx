import React, { useEffect, useState } from 'react';
import Modal from './Modal.jsx';
import GraphView from './GraphView.jsx';
import GraphContextMenu from './GraphContextMenu.jsx';
import { fetchNeighborhood, fetchNeighborhoodTypes, fetchFilteredNeighborhood } from '../lib/neo4j.js';
import { recordsToGraph, mergeGraphs } from '../lib/graphModel.js';
import { useGraphRelayout } from '../lib/useGraphRelayout.js';

const MENU_WIDTH = 240;
const MENU_MAX_HEIGHT = 360;

function nodeCaption(node) {
  return node.captions?.[0]?.value ?? node.id;
}

function formatPropertyValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/** Shows a node's dependency graph starting from its 1-hop neighborhood.
 * - Single click: shows that node's labels/properties in the side panel.
 * - Double click: fetches all of that node's neighbors and merges them in.
 * - Right click: opens a menu to either hide every other node (isolate this
 *   one) or expand only chosen neighbor node types - whichever relationships
 *   connect to those types come along automatically, there's no separate
 *   relationship-type picker.
 * Purely for exploration: no editing here (use the Graph Explorer or the
 * row's Edit action for that). */
export default function DetailGraphModal({ elementId, caption, database, onClose }) {
  const [graph, setGraph] = useState({ nodes: [], relationships: [] });
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [selectedNode, setSelectedNode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);

  const { nvlRef, triggerRelayout } = useGraphRelayout(graph);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchNeighborhood(elementId, database)
      .then((records) => {
        if (cancelled) return;
        triggerRelayout();
        setGraph(recordsToGraph(records));
        setExpandedIds(new Set([elementId]));
      })
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elementId, database]);

  function mergeAndRelayout(records) {
    const fetched = recordsToGraph(records);
    triggerRelayout();
    setGraph((g) => mergeGraphs(g, fetched));
  }

  async function handleExpand(node) {
    if (expandedIds.has(node.id)) return;
    setLoading(true);
    try {
      const records = await fetchNeighborhood(node.id, database);
      mergeAndRelayout(records);
      setExpandedIds((prev) => new Set(prev).add(node.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleNodeRightClick(node, event) {
    const x = Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 12);
    const y = Math.min(event.clientY, window.innerHeight - MENU_MAX_HEIGHT - 12);
    setContextMenu({ x, y, node, loading: true, nodeLabelOptions: [], selectedNodeLabels: new Set() });
    try {
      const records = await fetchNeighborhoodTypes(node.id, database);
      const nodeLabelOptions = [];
      const seenLabels = new Set();
      for (const record of records) {
        const labels = record.get('nodeLabels');
        if (!labels) continue;
        for (const label of labels) {
          if (!seenLabels.has(label)) {
            seenLabels.add(label);
            nodeLabelOptions.push(label);
          }
        }
      }
      // Unchecked by default - the user opts in to what they want to pull in.
      setContextMenu((menu) => (menu && menu.node.id === node.id
        ? { ...menu, loading: false, nodeLabelOptions, selectedNodeLabels: new Set() }
        : menu));
    } catch (err) {
      setError(err.message);
      setContextMenu(null);
    }
  }

  function toggleNodeLabel(label) {
    setContextMenu((menu) => {
      const next = new Set(menu.selectedNodeLabels);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return { ...menu, selectedNodeLabels: next };
    });
  }

  async function handleApplyFilter() {
    const menu = contextMenu;
    setContextMenu(null);
    setLoading(true);
    try {
      const records = await fetchFilteredNeighborhood({
        elementId: menu.node.id,
        labels: Array.from(menu.selectedNodeLabels)
      }, database);
      mergeAndRelayout(records);
      setExpandedIds((prev) => new Set(prev).add(menu.node.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // Removes every other node from the canvas, leaving only this one. NVL
  // diffs the nodes/rels props it's given and removes anything missing from
  // the new arrays, so simply shrinking `graph` is enough. `expandedIds` is
  // reset too, so double-click/right-click on the isolated node fetches its
  // neighbors fresh instead of being treated as "already expanded".
  function handleMaskOthers(node) {
    setContextMenu(null);
    triggerRelayout();
    setGraph({ nodes: [node], relationships: [] });
    setExpandedIds(new Set());
    setSelectedNode(node);
  }

  return (
    <Modal title={`Dependencies: ${caption}`} onClose={onClose} wide>
      <p className="modal-hint">
        Click a node for details, double-click to expand all its connections, or right-click for more options. {loading && 'Loading…'}
      </p>
      {error && <p className="form-error">{error}</p>}
      <div className="detail-graph">
        <div className="detail-graph-canvas">
          <GraphView
            nvlRef={nvlRef}
            nodes={graph.nodes}
            relationships={graph.relationships}
            onSelectNode={setSelectedNode}
            onDoubleClickNode={handleExpand}
            onNodeRightClick={handleNodeRightClick}
            onSelectRelationship={() => {}}
            onDeselect={() => setSelectedNode(null)}
          />
        </div>
        <div className="detail-node-panel">
          {selectedNode ? (
            <>
              <div className="inspector-labels">
                {selectedNode.labels.map((l) => <span className="label-chip" key={l}>{l}</span>)}
              </div>
              <h4 className="detail-node-title">{nodeCaption(selectedNode)}</h4>
              <dl className="property-list">
                {Object.entries(selectedNode.properties).map(([key, value]) => (
                  <React.Fragment key={key}>
                    <dt>{key}</dt>
                    <dd>{formatPropertyValue(value)}</dd>
                  </React.Fragment>
                ))}
              </dl>
            </>
          ) : (
            <p className="readonly-note">Click a node to see its details.</p>
          )}
        </div>
        {contextMenu && (
          <GraphContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            caption={nodeCaption(contextMenu.node)}
            loading={contextMenu.loading}
            nodeLabelOptions={contextMenu.nodeLabelOptions}
            selectedNodeLabels={contextMenu.selectedNodeLabels}
            onToggleNodeLabel={toggleNodeLabel}
            onApply={handleApplyFilter}
            onMask={() => handleMaskOthers(contextMenu.node)}
            onClose={() => setContextMenu(null)}
          />
        )}
      </div>
    </Modal>
  );
}
