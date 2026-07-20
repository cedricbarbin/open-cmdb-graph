import React, { useRef } from 'react';
import { InteractiveNvlWrapper } from '@neo4j-nvl/react';

const NVL_OPTIONS = {
  initialZoom: 0.9,
  layout: 'forceDirected',
  relationshipThreshold: 0.1
};

/** Thin wrapper around NVL's InteractiveNvlWrapper: renders nodes/rels and
 * forwards click selection up to App so the Inspector panel can show them.
 * `onDoubleClickNode` is optional - only the dependency graph modal uses it
 * (single click there does nothing, double click expands the node).
 * `onNodeRightClick` is optional too - the dependency graph modal uses it to
 * open a "choose what to expand" menu; the browser's own context menu is
 * suppressed whenever a handler is provided.
 * `nvlRef` is optional - pass one in if the caller needs to drive the NVL
 * instance directly (e.g. to trigger a re-layout after adding nodes). */
export default function GraphView({ nodes, relationships, onSelectNode, onSelectRelationship, onDeselect, onDoubleClickNode, onNodeRightClick, nvlRef: externalRef }) {
  const internalRef = useRef(null);
  const nvlRef = externalRef ?? internalRef;

  const mouseEventCallbacks = {
    onNodeClick: (node) => onSelectNode(node),
    onNodeDoubleClick: onDoubleClickNode ? (node) => onDoubleClickNode(node) : undefined,
    onNodeRightClick: onNodeRightClick
      ? (node, hitTargets, event) => {
        event.preventDefault();
        onNodeRightClick(node, event);
      }
      : undefined,
    onRelationshipClick: (rel) => onSelectRelationship(rel),
    onCanvasClick: () => onDeselect(),
    onPan: true,
    onZoom: true,
    onDrag: true
  };

  return (
    <div className="graph-view">
      {nodes.length === 0 ? (
        <div className="graph-empty">
          Connect to a database and run a query to see nodes here.
        </div>
      ) : (
        <InteractiveNvlWrapper
          ref={nvlRef}
          nodes={nodes}
          rels={relationships}
          nvlOptions={NVL_OPTIONS}
          mouseEventCallbacks={mouseEventCallbacks}
        />
      )}
    </div>
  );
}
