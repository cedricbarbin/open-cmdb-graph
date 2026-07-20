import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { searchNodesForAutocomplete } from '../lib/neo4j.js';
import { captionForNode } from '../lib/graphModel.js';

// Stable reference for the "no exclusions passed" case. A `= []` default
// parameter would instead be re-evaluated (as a brand new array) on every
// render, including renders caused by this component's own setState calls -
// which, sitting in the effect's dependency array below, would make the
// effect see a "changed" dependency after every run and re-fire forever
// ("Maximum update depth exceeded").
const NO_EXCLUSIONS = [];

/** Search-as-you-type input for picking a related node. Purely a picker -
 * it doesn't render "already selected" state; the parent form renders
 * selected items as chips and mounts one of these to add more.
 *
 * The results menu is rendered through a portal into document.body at a
 * fixed position computed from the input's bounding rect, instead of being
 * absolutely positioned inside this component. It's used inside
 * EntityFormModal, which sits in a `.modal` that scrolls
 * (`overflow-y: auto`) for long forms - an absolutely-positioned dropdown
 * there gets clipped by that scroll container for any field that isn't
 * right at the top, making it silently invisible even though it "opened". */
export default function NodeAutocomplete({ targetLabels, onSelect, placeholder, database, excludeIds = NO_EXCLUSIONS }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  const [menuRect, setMenuRect] = useState(null);
  const debounceRef = useRef(null);
  const inputRef = useRef(null);
  // Read at fetch time via a ref instead of a dependency: excludeIds
  // changing shouldn't itself trigger a new search, only affect which
  // results the *next* search filters out.
  const excludeIdsRef = useRef(excludeIds);
  excludeIdsRef.current = excludeIds;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (term.trim().length < 2) {
      setResults([]);
      setError(null);
      setOpen(false);
      return undefined;
    }

    setLoading(true);
    setError(null);
    setOpen(true);
    if (inputRef.current) {
      const rect = inputRef.current.getBoundingClientRect();
      setMenuRect({ left: rect.left, top: rect.bottom + 4, width: rect.width });
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const nodes = await searchNodesForAutocomplete({ term, labels: targetLabels }, database);
        setResults(nodes.filter((n) => !excludeIdsRef.current.includes(n.elementId)));
      } catch (err) {
        // Surface the failure instead of silently showing "no matches" -
        // a missing/stale fulltext index or a connection drop should be
        // visible, not indistinguishable from an empty result set.
        setResults([]);
        setError(err.message || 'Search failed');
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [term, targetLabels, database]);

  function handlePick(node) {
    onSelect({ elementId: node.elementId, caption: captionForNode(node), labels: node.labels });
    setTerm('');
    setResults([]);
    setError(null);
    setOpen(false);
  }

  const menu = open && menuRect && (
    <ul
      className="autocomplete-menu"
      style={{ position: 'fixed', left: menuRect.left, top: menuRect.top, width: menuRect.width }}
      // Keep the input focused (and thus the menu open) when clicking inside it.
      onMouseDown={(e) => e.preventDefault()}
    >
      {loading && <li className="autocomplete-empty">Searching…</li>}
      {!loading && error && <li className="autocomplete-empty autocomplete-error">{error}</li>}
      {!loading && !error && results.map((node) => (
        <li key={node.elementId} onClick={() => handlePick(node)}>
          <span className="autocomplete-caption">{captionForNode(node)}</span>
          <span className="autocomplete-labels">{node.labels.join(':')}</span>
        </li>
      ))}
      {!loading && !error && results.length === 0 && <li className="autocomplete-empty">No matches</li>}
    </ul>
  );

  return (
    <div className="autocomplete">
      <input
        ref={inputRef}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => term.trim().length >= 2 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder ?? 'Search…'}
      />
      {menu && createPortal(menu, document.body)}
    </div>
  );
}
