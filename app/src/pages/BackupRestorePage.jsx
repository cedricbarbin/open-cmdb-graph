import React, { useRef, useState } from 'react';
import { NODE_TYPES, NODE_TYPE_CATEGORIES } from '../lib/nodeTypes.js';
import { useConnection } from '../lib/ConnectionContext.jsx';
import { buildBackupZip, restoreBackupZip } from '../lib/backup.js';
import { downloadBlob } from '../lib/csv.js';
import ImportModeModal from '../components/ImportModeModal.jsx';

function timestampForFilename() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export default function BackupRestorePage() {
  const { database, canWrite } = useConnection();
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState(null);
  const [restoreSummary, setRestoreSummary] = useState(null);
  const [pendingRestoreFile, setPendingRestoreFile] = useState(null); // File awaiting a replace/ignore choice
  const fileInputRef = useRef(null);

  function toggleKey(key) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll() {
    setSelectedKeys(new Set(NODE_TYPES.map((t) => t.key)));
  }

  function selectNone() {
    setSelectedKeys(new Set());
  }

  async function handleExport() {
    if (selectedKeys.size === 0) {
      setError('Select at least one data type to export.');
      return;
    }
    setExporting(true);
    setError(null);
    try {
      const blob = await buildBackupZip({ typeKeys: Array.from(selectedKeys), database });
      downloadBlob(`cmdb-backup-${timestampForFilename()}.zip`, blob);
    } catch (err) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  }

  function handleRestoreClick() {
    fileInputRef.current?.click();
  }

  function handleRestoreFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file on a retry
    if (!file) return;
    setError(null);
    setRestoreSummary(null);
    setPendingRestoreFile(file);
  }

  async function runRestore(onExisting) {
    const file = pendingRestoreFile;
    setPendingRestoreFile(null);
    if (!file) return;

    setRestoring(true);
    try {
      const results = await restoreBackupZip({ file, database, onExisting });
      setRestoreSummary(results);
    } catch (err) {
      setError(err.message);
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="page entity-list-page">
      <div className="page-header">
        <h2>Backup &amp; Restore</h2>
        <div className="page-header-actions">
          <button type="button" onClick={selectAll}>Select all</button>
          <button type="button" onClick={selectNone}>Select none</button>
          <button type="button" onClick={handleExport} disabled={exporting || selectedKeys.size === 0}>
            {exporting ? 'Exporting…' : 'Export ZIP'}
          </button>
          {canWrite && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                style={{ display: 'none' }}
                onChange={handleRestoreFile}
              />
              <button type="button" onClick={handleRestoreClick} disabled={restoring}>
                {restoring ? 'Restoring…' : 'Restore ZIP'}
              </button>
            </>
          )}
        </div>
      </div>

      <p className="readonly-note">
        Export bundles one CSV per selected data type below (every field, keyed headers - same format as
        "Get CSV template") plus a <code>relationships.csv</code> covering edges directly between the
        selected types, into a single ZIP. Restore reads a ZIP built the same way: it imports every
        recognized <code>&lt;type&gt;.csv</code> first, then <code>relationships.csv</code> last, so the
        ids it references already exist. Before importing, you'll be asked whether rows whose <code>id</code>
        already exists should replace the existing node's properties or be left alone - new ids are
        always created either way.
      </p>

      {error && <p className="form-error">{error}</p>}

      <div className="menu-settings-groups">
        {NODE_TYPE_CATEGORIES.map((category) => (
          <div className="menu-settings-group" key={category}>
            <h4>{category}</h4>
            {NODE_TYPES.filter((t) => t.category === category).map((t) => (
              <label className="menu-settings-item" key={t.key}>
                <input
                  type="checkbox"
                  checked={selectedKeys.has(t.key)}
                  onChange={() => toggleKey(t.key)}
                />
                {t.pluralLabel}
              </label>
            ))}
          </div>
        ))}
      </div>

      {restoreSummary && (
        <div className="backup-summary">
          <h4>Restore results</h4>
          <ul>
            {restoreSummary.types.map((t) => (
              <li key={t.key}>
                {t.label}: created {t.created} of {t.total}
                {t.replaced > 0 && `, replaced ${t.replaced}`}
                {t.ignored > 0 && `, ignored ${t.ignored}`}
                {t.failed.length > 0 && ` (${t.failed.length} failed)`}
              </li>
            ))}
            {restoreSummary.types.length === 0 && !restoreSummary.relationships && (
              <li>No recognized data-type CSVs or relationships.csv found in that ZIP.</li>
            )}
            {restoreSummary.relationships && (
              <li>
                Relationships: created {restoreSummary.relationships.created} of {restoreSummary.relationships.total}
                {restoreSummary.relationships.failed.length > 0 && ` (${restoreSummary.relationships.failed.length} failed)`}
              </li>
            )}
          </ul>
        </div>
      )}
      {pendingRestoreFile && (
        <ImportModeModal
          onChoose={runRestore}
          onClose={() => setPendingRestoreFile(null)}
        />
      )}
    </div>
  );
}
