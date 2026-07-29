import React, { createContext, useCallback, useContext, useState } from 'react';
import {
  connect as driverConnect,
  disconnect as driverDisconnect,
  getCurrentUserProfile,
  changeOwnPassword,
  isCredentialsExpiredError,
  fetchAllLabels,
  fetchAllRelationshipTypes
} from './neo4j.js';

const ConnectionContext = createContext(null);

export function ConnectionProvider({ children }) {
  const [connection, setConnection] = useState(null); // { database }
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const [profile, setProfile] = useState(null); // { username, roles, profile: 'admin'|'readonly', detected }
  const [knownLabels, setKnownLabels] = useState([]);
  const [knownTypes, setKnownTypes] = useState([]);

  // Set instead of `connection` when Neo4j reports the account is CHANGE
  // REQUIRED (e.g. a brand new user's first sign-in): { uri, username,
  // password, database } for the attempt that got rejected, kept only so
  // changePassword() below can run the self-service ALTER and then
  // reconnect with the new password.
  const [pendingCredentials, setPendingCredentials] = useState(null);

  // Derived from the 4-tier profile ('readonly' | 'operator' | 'superuser' |
  // 'admin') - see getCurrentUserProfile in neo4j.js for how it's detected.
  const isAdmin = profile?.profile === 'admin';
  const canWrite = !!profile && profile.profile !== 'readonly';
  // Everything in the sidebar's "Admin" group is admin-only except Menu
  // Settings (which has no gate at all - it's a display preference, not a
  // permission).
  const canAccessGraphExplorer = isAdmin;
  const canManageUsers = isAdmin;
  const canAccessBackupRestore = isAdmin;
  const database = connection?.database;

  async function finishSignIn(form) {
    const detectedProfile = await getCurrentUserProfile();
    setProfile(detectedProfile);
    setConnection({ database: form.database });
    const [labels, types] = await Promise.all([
      fetchAllLabels(form.database),
      fetchAllRelationshipTypes(form.database)
    ]);
    setKnownLabels(labels);
    setKnownTypes(types);
  }

  const connect = useCallback(async (form) => {
    setConnecting(true);
    setConnectionError(null);
    setPendingCredentials(null);
    try {
      await driverConnect(form);
      await finishSignIn(form);
    } catch (err) {
      if (isCredentialsExpiredError(err)) {
        // Auth itself succeeded (the password is correct) - Neo4j is just
        // refusing every query but the password change below until a new
        // one is set. Keep the driver connected with the old password so
        // that ALTER CURRENT USER (the one command it will still run) can
        // use it.
        setPendingCredentials(form);
      } else {
        setConnectionError(err.message);
      }
    } finally {
      setConnecting(false);
    }
  }, []);

  const changePassword = useCallback(async (newPassword) => {
    if (!pendingCredentials) return;
    setConnecting(true);
    setConnectionError(null);
    try {
      await changeOwnPassword({ oldPassword: pendingCredentials.password, newPassword });
      // The old password is invalid now, and the existing driver's auth
      // token still embeds it - reconnect with the new one so any
      // connection the pool opens later authenticates correctly.
      const nextForm = { ...pendingCredentials, password: newPassword };
      await driverConnect(nextForm);
      await finishSignIn(nextForm);
      setPendingCredentials(null);
    } catch (err) {
      setConnectionError(err.message);
    } finally {
      setConnecting(false);
    }
  }, [pendingCredentials]);

  const cancelPasswordChange = useCallback(() => {
    driverDisconnect();
    setPendingCredentials(null);
    setConnectionError(null);
  }, []);

  const disconnect = useCallback(() => {
    driverDisconnect();
    setConnection(null);
    setProfile(null);
    setKnownLabels([]);
    setKnownTypes([]);
    setPendingCredentials(null);
  }, []);

  const refreshSchema = useCallback(async () => {
    if (!connection) return;
    const [labels, types] = await Promise.all([
      fetchAllLabels(connection.database),
      fetchAllRelationshipTypes(connection.database)
    ]);
    setKnownLabels(labels);
    setKnownTypes(types);
  }, [connection]);

  const value = {
    connected: !!connection,
    connecting,
    connectionError,
    profile,
    canWrite,
    canAccessGraphExplorer,
    canManageUsers,
    canAccessBackupRestore,
    database,
    knownLabels,
    knownTypes,
    connect,
    disconnect,
    refreshSchema,
    passwordChangeRequired: !!pendingCredentials,
    pendingUsername: pendingCredentials?.username ?? null,
    changePassword,
    cancelPasswordChange
  };

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection() {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within a ConnectionProvider');
  return ctx;
}
