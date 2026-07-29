import React from 'react';
import { NODE_TYPES, NODE_TYPE_CATEGORIES } from '../lib/nodeTypes.js';
import { useMenuPrefs } from '../lib/MenuPrefsContext.jsx';

export default function MenuSettingsPage() {
  const { hiddenTypes, setTypeHidden, showAllTypes, hideAllTypes } = useMenuPrefs();

  return (
    <div className="page entity-list-page">
      <div className="page-header">
        <h2>Menu Settings</h2>
        <div className="page-header-actions">
          <button type="button" onClick={showAllTypes}>Show all</button>
          <button type="button" onClick={() => hideAllTypes(NODE_TYPES.map((t) => t.key))}>Hide all</button>
        </div>
      </div>

      <p className="readonly-note">
        Choose which entity types show up in your sidebar. This is a preference stored in this
        browser only — it doesn't change what data exists or what you're allowed to do, and a
        hidden type is still reachable directly by URL.
      </p>

      <div className="menu-settings-groups">
        {NODE_TYPE_CATEGORIES.map((category) => (
          <div className="menu-settings-group" key={category}>
            <h4>{category}</h4>
            {NODE_TYPES.filter((t) => t.category === category).map((t) => (
              <label className="menu-settings-item" key={t.key}>
                <input
                  type="checkbox"
                  checked={!hiddenTypes.has(t.key)}
                  onChange={(e) => setTypeHidden(t.key, !e.target.checked)}
                />
                {t.pluralLabel}
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
