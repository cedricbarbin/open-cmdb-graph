import React from 'react';
import { NavLink } from 'react-router-dom';
import { NODE_TYPES, NODE_TYPE_CATEGORIES } from '../lib/nodeTypes.js';

export default function Sidebar() {
  return (
    <nav className="sidebar">
      <NavLink to="/graph" className={({ isActive }) => `sidebar-link sidebar-top-link ${isActive ? 'active' : ''}`}>
        Graph Explorer
      </NavLink>
      {NODE_TYPE_CATEGORIES.map((category) => (
        <div className="sidebar-group" key={category}>
          <h4>{category}</h4>
          {NODE_TYPES.filter((t) => t.category === category).map((t) => (
            <NavLink
              key={t.key}
              to={`/type/${t.key}`}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            >
              {t.pluralLabel}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}
