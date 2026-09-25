import React, { useRef, useState } from 'react';
import { useConnection } from '../lib/ConnectionContext.jsx';
import { IMPORTERS, getImporter, detectImporter, defaultOptions, loadImportGraph } from '../lib/importers/index.js';
import ImportModeModal from '../components/ImportModeModal.jsx';

const MAX_SHOWN_WARNINGS = 8;

/** "Import from tools": upload an RVTools / EfficientIP / Proxmox /
 * understand-anything export and load it straight into Neo4j from the
 * browser - the in-app counterpart of the tools/*2cypher CLIs (same
 * mapping, same ids, same options), with the same replace/ignore choice as
 * the CSV import for nodes that already exist. */
export default function ImportPage() {
  const { database, canWrite, canAccessGraphExplorer, refreshSchema } = useConnection();
  const [files, setFiles] = useState([]);
  const [sourceKey, setSourceKey] = useState('');
  const [detected, setDetected] = useState(null);
  const [options, setOptions] = useState({});
  // Enrichment labels (Cluster, Datastore, IPSpace …) are new labels; creating
  // them needs NAME MANAGEMENT, which only superuser/admin hold - operators
  // get the strict (model labels only) form of every importer.
  const strictForced = !canAccessGraphExplorer;
  const [strict, setStrict] = useState(strictForced);
  const [purge, setPurge] = useState(false);
  const [graph, setGraph] = useState(null);
  const [busy, setBusy] = useState(null); // progress text while analysing / importing
  const [error, setError] = useState(null);
  const [results, setResults] = useState(null);
  const [askMode, setAskMode] = useState(false);
  const fileInputRef = useRef(null);

  const importer = getImporter(sourceKey);

  function pickSource(key) {
    setSourceKey(key);
    const imp = getImporter(key);
    setOptions(imp ? defaultOptions(imp) : {});
    setGraph(null);
    setResults(null);
  }

  async function handleFiles(e) {
    const list = Array.from(e.target.files || []);
    e.target.value = '';
    if (list.length === 0) return;
    setFiles(list);
    setGraph(null);
    setResults(null);
    setError(null);
    setBusy('Detecting the source…');
    try {
      const key = await detectImporter(list);
      setDetected(key);
      if (key) pickSource(key);
      else if (!sourceKey) setError('Could not tell which tool produced these files - pick the source below.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  function setOption(key, value) {
    setOptions((prev) => ({ ...prev, [key]: value }));
    setGraph(null);
  }

  async function analyse() {
    if (!importer || files.length === 0) return null;
    setError(null);
    setResults(null);
    setBusy('Reading the files…');
    try {
      const g = await importer.build(files, { ...options, strict: strictForced || strict });
      setGraph(g);
      return g;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function startImport() {
    const g = graph || (await analyse());
    if (g) setAskMode(true);
  }

  async function runImport(onExisting) {
    setAskMode(false);
    if (!graph) return;
    setError(null);
    setBusy('Importing…');
    try {
      const r = await loadImportGraph(graph, { database, onExisting, purge, onProgress: setBusy });
      setResults(r);
      await refreshSchema();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const totalNodes = graph ? graph.nodes.length : 0;
  const totalRels = graph ? graph.rels.length : 0;

  return (
    <div className="page entity-list-page">
      <div className="page-header">
        <h2>Import from tools</h2>
        <div className="page-header-actions">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={importer ? importer.accept : '.xlsx,.xlsm,.csv,.json'}
            style={{ display: 'none' }}
            onChange={handleFiles}
          />
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={!!busy || !canWrite}>
            Choose files…
          </button>
          <button type="button" onClick={analyse} disabled={!!busy || !importer || files.length === 0}>
            Preview
          </button>
          <button type="button" onClick={startImport} disabled={!!busy || !importer || files.length === 0 || !canWrite}>
            {busy && busy.startsWith('Import') ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>

      <p className="readonly-note">
        Upload an export from one of the supported tools and load it into the CMDB with the same mapping the
        command-line importers in <code>tools/</code> use (same ids, same labels). Nodes the export refreshes
        (servers, subnets, addresses…) get the same replace/ignore choice as a CSV import when they already exist;
        reference nodes it only creates when missing (applications, environments, locations…) always keep their
        current properties. <strong>Preview</strong> reads the files without writing anything.
      </p>

      <div className="import-setup">
        <label className="form-field">
          <span>Source</span>
          <select value={sourceKey} onChange={(e) => pickSource(e.target.value)} disabled={!!busy}>
            <option value="">{detected === null && files.length > 0 ? 'Pick a source…' : 'Auto-detect from the files'}</option>
            {IMPORTERS.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
          </select>
        </label>
        {importer && <p className="readonly-note import-hint">{importer.hint}</p>}
        {files.length > 0 && (
          <p className="readonly-note">
            {files.length} file{files.length === 1 ? '' : 's'}: {files.map((f) => f.name).join(', ')}
            {detected && importer && detected === importer.key && ' (detected)'}
          </p>
        )}

        {importer && (
          <div className="import-options">
            {importer.options.map((o) => (
              <label className={o.type === 'checkbox' ? 'menu-settings-item' : 'form-field'} key={o.key}>
                {o.type === 'checkbox' && (
                  <input type="checkbox" checked={!!options[o.key]} onChange={(e) => setOption(o.key, e.target.checked)} disabled={!!busy} />
                )}
                <span>{o.label}</span>
                {o.type === 'text' && (
                  <input type="text" value={options[o.key] ?? ''} placeholder={o.placeholder || ''}
                    onChange={(e) => setOption(o.key, e.target.value)} disabled={!!busy} />
                )}
                {o.type === 'select' && (
                  <select value={options[o.key] ?? o.default} onChange={(e) => setOption(o.key, e.target.value)} disabled={!!busy}>
                    {o.options.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                )}
              </label>
            ))}
            <label className="menu-settings-item">
              <input type="checkbox" checked={strictForced || strict} disabled={strictForced || !!busy}
                onChange={(e) => { setStrict(e.target.checked); setGraph(null); }} />
              <span>
                Model labels only (strict: no Cluster / Datastore / IPSpace… enrichment nodes)
                {strictForced && ' - required for your profile, new labels need the superuser role'}
              </span>
            </label>
            <label className="menu-settings-item">
              <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} disabled={!!busy} />
              <span>Remove the previous import from this source first (purge: drops entries that left the export)</span>
            </label>
          </div>
        )}
      </div>

      {busy && <p className="readonly-note">{busy}</p>}
      {error && <p className="form-error">{error}</p>}

      {graph && !results && (
        <div className="backup-summary">
          <h4>Preview: {totalNodes} nodes, {totalRels} relationships</h4>
          <ul>
            {Object.entries(graph.summary.nodes).map(([label, n]) => <li key={label}>{label}: {n}</li>)}
          </ul>
          <ul>
            {Object.entries(graph.summary.relationships).map(([type, n]) => <li key={type}>{type}: {n}</li>)}
          </ul>
          {graph.serverLinks && <p className="readonly-note">{graph.serverLinks.length} addresses to link to existing servers.</p>}
          {graph.summary.warnings.length > 0 && (
            <p className="form-error">
              {graph.summary.warnings.length} warning{graph.summary.warnings.length === 1 ? '' : 's'}:{' '}
              {graph.summary.warnings.slice(0, MAX_SHOWN_WARNINGS).join('; ')}
              {graph.summary.warnings.length > MAX_SHOWN_WARNINGS && ` … and ${graph.summary.warnings.length - MAX_SHOWN_WARNINGS} more`}
            </p>
          )}
          <details>
            <summary>Input details</summary>
            <pre className="import-details">{JSON.stringify(graph.summary.input, null, 2)}</pre>
          </details>
        </div>
      )}

      {results && (
        <div className="backup-summary">
          <h4>Import results</h4>
          <ul>
            {results.purge && <li>Purged {results.purge.nodes} nodes and {results.purge.relationships} relationships from the previous import.</li>}
            {results.nodes.map((n) => (
              <li key={n.label}>
                {n.label}: created {n.created} of {n.total}
                {n.replaced > 0 && `, replaced ${n.replaced}`}
                {n.ignored > 0 && `, ${n.mode === 'create' ? 'kept' : 'ignored'} ${n.ignored}`}
                {n.failed.length > 0 && ` (failed: ${n.failed.map((f) => f.message).join('; ')})`}
              </li>
            ))}
            {results.relationships.map((r) => (
              <li key={`${r.fromLabel}-${r.type}-${r.toLabel}`}>
                {r.fromLabel} -[{r.type}]-&gt; {r.toLabel}: merged {r.created} of {r.total}
                {r.failed.length > 0 && ` (failed: ${r.failed.map((f) => f.message).join('; ')})`}
              </li>
            ))}
            {results.serverLinks && (
              <li>
                Addresses linked to existing servers: {results.serverLinks.linked} of {results.serverLinks.candidates}
                {results.serverLinks.failed.length > 0 && ` (failed: ${results.serverLinks.failed.map((f) => f.message).join('; ')})`}
              </li>
            )}
          </ul>
        </div>
      )}

      {askMode && (
        <ImportModeModal onChoose={runImport} onClose={() => setAskMode(false)} />
      )}
    </div>
  );
}
