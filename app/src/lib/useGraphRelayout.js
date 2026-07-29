import { useEffect, useRef } from 'react';

/** Wires an NVL ref to a `graph` state's updates so the force layout
 * actually recomputes when nodes are set/replaced/merged in.
 *
 * NVL's React wrapper only diffs nodes/rels props and calls
 * addAndUpdateElementsInGraph() - it never restarts the force simulation
 * itself. New/replaced nodes therefore render wherever the (already
 * cooled-down) simulation last settled, i.e. stacked on top of each other
 * at the center, and stay stuck there until something else - dragging a
 * node - happens to wake the simulation back up. Call the returned
 * `triggerRelayout()` right before every `setGraph(...)`; this hook's
 * effect then calls `nvlRef.current.restart(undefined, false)` once the
 * new nodes have actually landed in the NVL instance (child effects commit
 * before this one, so by the time it runs the nodes already exist to lay
 * out) - `retainPositions=false` recomputes every node's position from
 * scratch, which is what actually untangles things, rather than leaving
 * previously-placed nodes pinned. */
export function useGraphRelayout(graph) {
  const nvlRef = useRef(null);
  const pendingRelayoutRef = useRef(false);

  useEffect(() => {
    if (pendingRelayoutRef.current && nvlRef.current) {
      nvlRef.current.restart(undefined, false);
      pendingRelayoutRef.current = false;
    }
  }, [graph]);

  function triggerRelayout() {
    pendingRelayoutRef.current = true;
  }

  return { nvlRef, triggerRelayout };
}
