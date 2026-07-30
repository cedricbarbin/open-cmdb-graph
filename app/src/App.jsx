import React, { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import ConnectionPanel from './components/ConnectionPanel.jsx';
import Sidebar from './components/Sidebar.jsx';
import { useConnection } from './lib/ConnectionContext.jsx';
import { NODE_TYPES } from './lib/nodeTypes.js';

// Route-level code splitting: each page (and whatever heavy libs only it
// needs - @neo4j-nvl for Graph Explorer/DetailGraphModal, jszip for Backup
// & Restore) lands in its own chunk instead of one ~2.7MB bundle everyone
// downloads on first load, regardless of which screen they actually open.
const GraphExplorerPage = lazy(() => import('./pages/GraphExplorerPage.jsx'));
const EntityListScreen = lazy(() => import('./pages/EntityListScreen.jsx'));
const UserManagementPage = lazy(() => import('./pages/UserManagementPage.jsx'));
const MenuSettingsPage = lazy(() => import('./pages/MenuSettingsPage.jsx'));
const BackupRestorePage = lazy(() => import('./pages/BackupRestorePage.jsx'));

export default function App() {
  const {
    connected, connecting, connectionError, profile,
    canAccessGraphExplorer, canManageUsers, canAccessBackupRestore, connect, disconnect,
    passwordChangeRequired, pendingUsername, changePassword, cancelPasswordChange
  } = useConnection();

  const defaultPath = canAccessGraphExplorer ? '/graph' : `/type/${NODE_TYPES[0].key}`;

  return (
    <div className="app">
      <header className="app-header">
        <img className="app-logo" src="/logo-horizontal-dark.svg" alt="Open CMDB Graph" />
        <ConnectionPanel
          connected={connected}
          connecting={connecting}
          error={connectionError}
          profile={profile}
          onConnect={connect}
          onDisconnect={disconnect}
          passwordChangeRequired={passwordChangeRequired}
          pendingUsername={pendingUsername}
          onChangePassword={changePassword}
          onCancelPasswordChange={cancelPasswordChange}
        />
      </header>

      {connected ? (
        <div className="app-body">
          <Sidebar />
          <div className="app-content">
            <Suspense fallback={<p className="readonly-note app-loading">Loading…</p>}>
              <Routes>
                <Route
                  path="/graph"
                  element={canAccessGraphExplorer ? <GraphExplorerPage /> : <Navigate to={defaultPath} replace />}
                />
                <Route path="/type/:typeKey" element={<EntityListScreen />} />
                <Route
                  path="/users"
                  element={canManageUsers ? <UserManagementPage /> : <Navigate to={defaultPath} replace />}
                />
                <Route path="/menu-settings" element={<MenuSettingsPage />} />
                <Route
                  path="/backup-restore"
                  element={canAccessBackupRestore ? <BackupRestorePage /> : <Navigate to={defaultPath} replace />}
                />
                <Route path="*" element={<Navigate to={defaultPath} replace />} />
              </Routes>
            </Suspense>
          </div>
        </div>
      ) : (
        <div className="app-welcome">
          <p>Sign in to a Neo4j database above to browse and manage the CMDB.</p>
        </div>
      )}
    </div>
  );
}
