import React from 'react';
import { NavLink } from 'react-router-dom';
import { NODE_TYPES, NODE_TYPE_CATEGORIES } from '../lib/nodeTypes.js';
import { useConnection } from '../lib/ConnectionContext.jsx';
import { useMenuPrefs } from '../lib/MenuPrefsContext.jsx';

function sidebarLinkClass({ isActive }) {
  return `sidebar-link ${isActive ? 'active' : ''}`;
}

export default function Sidebar() {
  const { canAccessGraphExplorer, canManageUsers, canAccessBackupRestore } = useConnection();
  const { hiddenTypes } = useMenuPrefs();

  return (
    <nav className="sidebar">
      {NODE_TYPE_CATEGORIES.map((category) => {
        const types = NODE_TYPES.filter((t) => t.category === category && !hiddenTypes.has(t.key));
        if (types.length === 0) return null;
        return (
          <div className="sidebar-group" key={category}>
            <h4>{category}</h4>
            {types.map((t) => (
              <NavLink key={t.key} to={`/type/${t.key}`} className={sidebarLinkClass}>
                {t.pluralLabel}
              </NavLink>
            ))}
          </div>
        );
      })}

      <hr className="sidebar-separator" />

      <div className="sidebar-group">
        <h4>Admin</h4>
        {canAccessGraphExplorer && (
          <NavLink to="/graph" className={sidebarLinkClass}>
            Graph Explorer
          </NavLink>
        )}
        {canManageUsers && (
          <NavLink to="/users" className={sidebarLinkClass}>
            Manage Users
          </NavLink>
        )}
        <NavLink to="/menu-settings" className={sidebarLinkClass}>
          Menu Settings
        </NavLink>
        {canAccessBackupRestore && (
          <NavLink to="/backup-restore" className={sidebarLinkClass}>
            Backup &amp; Restore
          </NavLink>
        )}
      </div>
    </nav>
  );
}
