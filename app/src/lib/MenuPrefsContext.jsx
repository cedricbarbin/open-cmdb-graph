import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const STORAGE_KEY = 'cmdb-hidden-menu-types';
const MenuPrefsContext = createContext(null);

function loadHiddenTypes() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

/** Which entity types show up in the sidebar - a per-browser display
 * preference (localStorage), not a permission: hiding a type here doesn't
 * restrict access to it, it's still reachable by URL and unaffected by
 * Neo4j privileges. */
export function MenuPrefsProvider({ children }) {
  const [hiddenTypes, setHiddenTypes] = useState(loadHiddenTypes);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(hiddenTypes)));
  }, [hiddenTypes]);

  const setTypeHidden = useCallback((key, hidden) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (hidden) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const showAllTypes = useCallback(() => setHiddenTypes(new Set()), []);
  const hideAllTypes = useCallback((keys) => setHiddenTypes(new Set(keys)), []);

  const value = { hiddenTypes, setTypeHidden, showAllTypes, hideAllTypes };
  return <MenuPrefsContext.Provider value={value}>{children}</MenuPrefsContext.Provider>;
}

export function useMenuPrefs() {
  const ctx = useContext(MenuPrefsContext);
  if (!ctx) throw new Error('useMenuPrefs must be used within a MenuPrefsProvider');
  return ctx;
}
