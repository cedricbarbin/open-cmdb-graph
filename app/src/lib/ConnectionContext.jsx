import React, { createContext, useCallback, useContext, useState } from 'react';
import {
  connect as driverConnect,
  disconnect as driverDisconnect,
  getCurrentUserProfile,
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

  const isAdmin = profile?.profile === 'admin';
  const database = connection?.database;

  const connect = useCallback(async (form) => {
    setConnecting(true);
    setConnectionError(null);
    try {
      await driverConnect(form);
      const detectedProfile = await getCurrentUserProfile();
      setProfile(detectedProfile);
      setConnection({ database: form.database });
      const [labels, types] = await Promise.all([
        fetchAllLabels(form.database),
        fetchAllRelationshipTypes(form.database)
      ]);
      setKnownLabels(labels);
      setKnownTypes(types);
    } catch (err) {
      setConnectionError(err.message);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    driverDisconnect();
    setConnection(null);
    setProfile(null);
    setKnownLabels([]);
    setKnownTypes([]);
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
    isAdmin,
    database,
    knownLabels,
    knownTypes,
    connect,
    disconnect,
    refreshSchema
  };

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection() {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within a ConnectionProvider');
  return ctx;
}
