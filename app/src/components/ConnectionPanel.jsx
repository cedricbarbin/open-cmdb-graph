import React, { useState } from 'react';

const DEFAULT_FORM = {
  uri: 'neo4j://localhost:7687',
  username: 'neo4j',
  password: '',
  database: 'neo4j'
};

export default function ConnectionPanel({ connected, connecting, error, onConnect, onDisconnect }) {
  const [form, setForm] = useState(DEFAULT_FORM);

  function handleChange(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    onConnect(form);
  }

  if (connected) {
    return (
      <div className="connection-panel connected">
        <span className="status-dot" />
        <span>Connected to {form.uri} ({form.database})</span>
        <button type="button" onClick={onDisconnect}>Disconnect</button>
      </div>
    );
  }

  return (
    <form className="connection-panel" onSubmit={handleSubmit}>
      <input value={form.uri} onChange={handleChange('uri')} placeholder="bolt/neo4j URI" />
      <input value={form.username} onChange={handleChange('username')} placeholder="username" />
      <input
        type="password"
        value={form.password}
        onChange={handleChange('password')}
        placeholder="password"
      />
      <input value={form.database} onChange={handleChange('database')} placeholder="database" />
      <button type="submit" disabled={connecting}>
        {connecting ? 'Connecting…' : 'Connect'}
      </button>
      {error && <span className="connection-error">{error}</span>}
    </form>
  );
}
