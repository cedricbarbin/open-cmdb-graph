import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import ConnectionPanel from './components/ConnectionPanel.jsx';
import Sidebar from './components/Sidebar.jsx';
import GraphExplorerPage from './pages/GraphExplorerPage.jsx';
import EntityListScreen from './pages/EntityListScreen.jsx';
import { useConnection } from './lib/ConnectionContext.jsx';

export default function App() {
  const { connected, connecting, connectionError, profile, connect, disconnect } = useConnection();

  return (
    <div className="app">
      <header className="app-header">
        <h1>CMDB Graph Explorer</h1>
        <ConnectionPanel
          connected={connected}
          connecting={connecting}
          error={connectionError}
          profile={profile}
          onConnect={connect}
          onDisconnect={disconnect}
        />
      </header>

      {connected ? (
        <div className="app-body">
          <Sidebar />
          <div className="app-content">
            <Routes>
              <Route path="/graph" element={<GraphExplorerPage />} />
              <Route path="/type/:typeKey" element={<EntityListScreen />} />
              <Route path="*" element={<Navigate to="/graph" replace />} />
            </Routes>
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
