import React, { useState } from 'react';
import { CMDB_PROFILES } from '../lib/neo4j.js';

const DEFAULT_FORM = {
  uri: 'neo4j://localhost:7687',
  username: 'neo4j',
  password: '',
  database: 'neo4j'
};

function ChangePasswordForm({ connecting, error, username, onSubmit, onCancel }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [validationError, setValidationError] = useState(null);

  function handleSubmit(e) {
    e.preventDefault();
    if (!newPassword) {
      setValidationError('Enter a new password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setValidationError('Passwords do not match.');
      return;
    }
    setValidationError(null);
    onSubmit(newPassword);
  }

  return (
    <form className="connection-panel" onSubmit={handleSubmit}>
      <span>Neo4j requires a new password for {username ?? 'this account'}</span>
      <input
        type="password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        placeholder="new password"
        autoFocus
      />
      <input
        type="password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        placeholder="confirm new password"
      />
      <button type="submit" disabled={connecting}>
        {connecting ? 'Updating…' : 'Set password'}
      </button>
      <button type="button" onClick={onCancel} disabled={connecting}>
        Cancel
      </button>
      {(validationError || error) && <span className="connection-error">{validationError || error}</span>}
    </form>
  );
}

export default function ConnectionPanel({
  connected, connecting, error, profile, onConnect, onDisconnect,
  passwordChangeRequired, pendingUsername, onChangePassword, onCancelPasswordChange
}) {
  const [form, setForm] = useState(DEFAULT_FORM);

  function handleChange(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    onConnect(form);
  }

  if (connected) {
    const profileLabel = CMDB_PROFILES.find((p) => p.profile === profile?.profile)?.label ?? profile?.profile;
    return (
      <div className="connection-panel connected">
        <span className="status-dot" />
        <span>Connected to {form.uri} ({form.database})</span>
        {profile && (
          <span
            className={`profile-badge profile-${profile.profile}`}
            title={profile.detected ? `Neo4j roles: ${profile.roles.join(', ') || '(none)'}` : 'Role could not be determined'}
          >
            {profile.username ?? form.username} · {profileLabel}
          </span>
        )}
        <button type="button" onClick={onDisconnect}>Sign out</button>
      </div>
    );
  }

  if (passwordChangeRequired) {
    return (
      <ChangePasswordForm
        connecting={connecting}
        error={error}
        username={pendingUsername ?? form.username}
        onSubmit={onChangePassword}
        onCancel={onCancelPasswordChange}
      />
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
        {connecting ? 'Signing in…' : 'Sign in'}
      </button>
      {error && <span className="connection-error">{error}</span>}
    </form>
  );
}
