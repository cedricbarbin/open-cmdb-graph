import React, { useRef } from 'react';
import { InteractiveNvlWrapper } from '@neo4j-nvl/react';

const NVL_OPTIONS = {
  initialZoom: 0.9,
  layout: 'forceDirected',
  relationshipThreshold: 0.1
};

/** Thin wrapper around NVL's InteractiveNvlWrapper: renders nodes/rels and
 * forwards click selection up to App so the Inspector panel can show them. */
export default function GraphView({ nodes, relationships, onSelectNode, onSelectRelationship, onDeselect }) {
  const nvlRef = useRef(null);

  const mouseEventCallbacks = {
    onNodeClick: (node) => onSelectNode(node),
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
