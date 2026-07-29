import React, { useEffect, useState } from 'react';
import Modal from '../components/Modal.jsx';
import { useConnection } from '../lib/ConnectionContext.jsx';
import {
  fetchUsers,
  createUser,
  setUserRole,
  setUserPassword,
  deleteUser,
  CMDB_PROFILES,
  deriveCmdbProfile
} from '../lib/neo4j.js';

function UserFormModal({ mode, initialUser, onClose, onSaved }) {
  const currentProfile = initialUser ? deriveCmdbProfile(initialUser.roles) : null;
  const [username, setUsername] = useState(initialUser?.username ?? '');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(currentProfile?.role ?? CMDB_PROFILES[0].role);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);

    if (mode === 'create' && (!username.trim() || !password)) {
      setFormError('Username and password are required.');
      return;
    }

    setSaving(true);
    try {
      if (mode === 'create') {
        await createUser({ username: username.trim(), password, role });
      } else {
        if (!currentProfile || currentProfile.role !== role) {
          await setUserRole({ username: initialUser.username, role, previousRole: currentProfile?.role });
        }
        if (password) {
          await setUserPassword({ username: initialUser.username, password });
        }
      }
      onSaved();
      onClose();
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={mode === 'create' ? 'New User' : `Edit ${initialUser.username}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="entity-form">
        <div className="form-field">
          <label>Username *</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={mode === 'edit'}
          />
        </div>
        <div className="form-field">
          <label>{mode === 'create' ? 'Password *' : 'New password (leave blank to keep current)'}</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="form-field">
          <label>Profile *</label>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {CMDB_PROFILES.map((p) => <option key={p.role} value={p.role}>{p.label}</option>)}
          </select>
        </div>

        {formError && <p className="form-error">{formError}</p>}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function UserManagementPage() {
  const { profile } = useConnection();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [formModal, setFormModal] = useState(null); // { mode, initialUser } | null

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setUsers(await fetchUsers());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(user) {
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    try {
      await deleteUser({ username: user.username });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="page entity-list-page">
      <div className="page-header">
        <h2>Manage Users</h2>
        <div className="page-header-actions">
          <button type="button" onClick={() => setFormModal({ mode: 'create' })}>+ New User</button>
        </div>
      </div>

      <p className="readonly-note">
        Every user is assigned to exactly one of the app's 4 profiles: Read-only, Operator, Superuser, or Admin
        (see cypher/00_security_setup.cypher for what each one can actually do in Neo4j).
      </p>

      {error && <p className="form-error">{error}</p>}

      {loading ? (
        <p className="readonly-note">Loading…</p>
      ) : (
        <div className="table-wrapper">
          <table className="entity-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Profile</th>
                <th>Neo4j roles</th>
                <th>Status</th>
                <th className="row-actions-header">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const cmdbProfile = deriveCmdbProfile(u.roles);
                const isSelf = u.username === profile?.username;
                return (
                  <tr key={u.username}>
                    <td>{u.username}{isSelf ? ' (you)' : ''}</td>
                    <td>{cmdbProfile ? cmdbProfile.label : '—'}</td>
                    <td>{u.roles.join(', ') || '(none)'}</td>
                    <td>{u.suspended ? 'suspended' : 'active'}</td>
                    <td className="row-actions">
                      <button type="button" onClick={() => setFormModal({ mode: 'edit', initialUser: u })}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={isSelf}
                        title={isSelf ? "You can't delete your own account" : undefined}
                        onClick={() => handleDelete(u)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td colSpan={5} className="table-empty">No users found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {formModal && (
        <UserFormModal
          mode={formModal.mode}
          initialUser={formModal.initialUser}
          onClose={() => setFormModal(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
