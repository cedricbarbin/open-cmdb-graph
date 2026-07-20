import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App.jsx';
import { ConnectionProvider } from './lib/ConnectionContext.jsx';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ConnectionProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </ConnectionProvider>
  </React.StrictMode>
);
