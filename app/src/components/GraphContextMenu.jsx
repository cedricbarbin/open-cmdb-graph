import React, { useEffect } from 'react';

/** Right-click menu for the dependency graph modal: lets the user narrow an
 * expansion down to specific neighbor node types before fetching them,
 * instead of always pulling in everything. Relationship types aren't chosen
 * directly - whichever relationships connect to the picked node types come
 * along automatically. Controlled component - selection state lives in the
 * parent. */
export default function GraphContextMenu({
  x, y, caption, loading,
  nodeLabelOptions,
  selectedNodeLabels,
  onToggleNodeLabel,
  onApply, onMask, onClose
}) {
  useEffect(() => {
    function handleKey(e) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const hasOptions = nodeLabelOptions.length > 0;

  return (
    <div className="context-menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="context-menu" style={{ left: x, top: y }} onClick={(e) => e.stopPropagation()}>
        <div className="context-menu-header">"{caption}"</div>

        <button type="button" className="context-menu-mask-btn" onClick={onMask}>
          Hide all other nodes
        </button>

        <div className="context-menu-divider" />

        <div className="context-menu-subheader">Expand</div>
        {loading && <p className="readonly-note">Loading options…</p>}
        {!loading && !hasOptions && <p className="readonly-note">No connections to expand.</p>}

        {!loading && hasOptions && (
          <div className="context-menu-section">
            <h5>Include neighbor types</h5>
            {nodeLabelOptions.map((label) => (
              <label className="context-menu-option" key={label}>
                <input type="checkbox" checked={selectedNodeLabels.has(label)} onChange={() => onToggleNodeLabel(label)} />
                {label}
              </label>
            ))}
          </div>
        )}

        <div className="context-menu-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" onClick={onApply} disabled={loading || selectedNodeLabels.size === 0}>Expand</button>
        </div>
      </div>
    </div>
  );
}
