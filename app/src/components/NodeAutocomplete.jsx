import React, { useEffect, useRef, useState } from 'react';
import { searchNodesForAutocomplete } from '../lib/neo4j.js';
import { captionForNode } from '../lib/graphModel.js';

/** Search-as-you-type input for picking a related node. Purely a picker -
 * it doesn't render "already selected" state; the parent form renders
 * selected items as chips and mounts one of these to add more. */
export default function NodeAutocomplete({ targetLabels, onSelect, placeholder, database, excludeIds = [] }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (term.trim().length < 2) {
      setResults([]);
      return undefined;
    }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const nodes = await searchNodesForAutocomplete({ term, labels: targetLabels }, database);
        setResults(nodes.filter((n) => !excludeIds.includes(n.elementId)));
        setOpen(true);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [term, targetLabels, database, excludeIds]);

  function handlePick(node) {
    onSelect({ elementId: node.elementId, caption: captionForNode(node), labels: node.labels });
    setTerm('');
    setResults([]);
    setOpen(false);
  }

  return (
    <div className="autocomplete">
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder ?? 'Search…'}
      />
      {open && (loading || term.trim().length >= 2) && (
        <ul className="autocomplete-menu">
          {loading && <li className="autocomplete-empty">Searching…</li>}
          {!loading && results.map((node) => (
            <li key={node.elementId} onMouseDown={() => handlePick(node)}>
              <span className="autocomplete-caption">{captionForNode(node)}</span>
              <span className="autocomplete-labels">{node.labels.join(':')}</span>
            </li>
          ))}
          {!loading && results.length === 0 && <li className="autocomplete-empty">No matches</li>}
        </ul>
      )}
    </div>
  );
}
