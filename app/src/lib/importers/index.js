// Registry of the in-browser importers (ports of tools/*2cypher) plus the
// loader that writes an importer's graph into Neo4j with the same
// replace/ignore choice as the CSV import (ImportModeModal). Used by
// pages/ImportPage.jsx.
import {
  findExistingKeys, mergeImportNodes, mergeImportRelationships, purgeImport, linkImportedIpsToServers
} from '../neo4j.js';
import { jsonObjects, parseCsvObjects, readTextFile } from './common.js';
import { RVTOOLS_OPTIONS, buildRvtoolsGraph, looksLikeRvtools } from './rvtools.js';
import { EFFICIENTIP_OPTIONS, buildEfficientipGraph, detectEfficientipKind } from './efficientip.js';
import { PROXMOX_OPTIONS, buildProxmoxGraph, classifyProxmox } from './proxmox.js';
import { UA_OPTIONS, buildUaGraph, classifyUaFile } from './ua.js';

export const IMPORTERS = [
  {
    key: 'rvtools', label: 'RVTools (VMware vSphere)', accept: '.xlsx,.xlsm,.csv',
    hint: 'The RVTools .xlsx export, or its RVTools_tab*.csv files (vInfo required; vHost, vCluster, vDatastore, vNetwork used when present).',
    options: RVTOOLS_OPTIONS, build: buildRvtoolsGraph
  },
  {
    key: 'efficientip', label: 'EfficientIP SOLIDserver (IPAM)', accept: '.csv,.json',
    hint: 'Network, address and VLAN exports (CSV from the GUI or JSON from the REST API); each file is recognised from its columns.',
    options: EFFICIENTIP_OPTIONS, build: buildEfficientipGraph
  },
  {
    key: 'proxmox', label: 'Proxmox VE', accept: '.json',
    hint: 'pvesh get … --output-format json files: /cluster/resources (recommended), /cluster/status, /nodes, per-node guest lists, guest configs (config-<vmid>.json), pools.',
    options: PROXMOX_OPTIONS, build: buildProxmoxGraph
  },
  {
    key: 'ua', label: 'understand-anything (code graph)', accept: '.json',
    hint: 'knowledge-graph.json (required) and domain-graph.json from a project\'s .ua/ directory.',
    options: UA_OPTIONS, build: buildUaGraph
  }
];

export function getImporter(key) {
  return IMPORTERS.find((i) => i.key === key) || null;
}

/** Guess which importer the selected files belong to (null when unsure). */
export async function detectImporter(files) {
  if (files.some((f) => /\.(xlsx|xlsm)$/i.test(f.name))) return 'rvtools';
  const csvSheets = {};
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.json')) {
      let data;
      try { data = JSON.parse(await readTextFile(f)); } catch { continue; }
      if (classifyUaFile(data)) return 'ua';
      const objs = jsonObjects(JSON.stringify(data));
      if (objs.some((o) => classifyProxmox(o))) return 'proxmox';
      if (detectEfficientipKind(objs)) return 'efficientip';
    } else if (lower.endsWith('.csv')) {
      csvSheets[f.name] = parseCsvObjects(await readTextFile(f));
    }
  }
  if (Object.keys(csvSheets).length > 0) {
    if (looksLikeRvtools(csvSheets)) return 'rvtools';
    if (Object.values(csvSheets).some((rows) => detectEfficientipKind(rows))) return 'efficientip';
  }
  return null;
}

/** Default option values for an importer's option schema. */
export function defaultOptions(importer) {
  const out = {};
  for (const o of importer.options) out[o.key] = o.default !== undefined ? o.default : (o.type === 'checkbox' ? false : '');
  return out;
}

const BATCH = 500;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Writes an importer graph into Neo4j.
 *
 * `onExisting` mirrors the CSV import's choice for nodes the importer
 * *refreshes* (servers, subnets, addresses …):
 *   - 'replace' - MERGE + SET n += row: an existing node gets the imported properties
 *   - 'ignore'  - MERGE + ON CREATE SET: an existing node is left untouched
 * Reference nodes the importer only *creates if missing* (Application,
 * Environment, Location, BusinessDomain, VLAN …) are ON CREATE SET in both
 * modes, exactly like the CLI tools - a hand-maintained application keeps
 * its owner/SLA/description. Relationships are always MERGEd.
 *
 * `purge` first deletes the inventory part of a previous import from the
 * same source (nodes with the importer's origin, the labels the tool's
 * --purge covers), so entries that disappeared from the export disappear
 * from the CMDB too. */
export async function loadImportGraph(graph, { database, onExisting = 'ignore', purge = false, onProgress } = {}) {
  const progress = (msg) => { if (onProgress) onProgress(msg); };
  const results = { purge: null, nodes: [], relationships: [], serverLinks: null };

  if (purge) {
    progress('Removing the previous import from this source…');
    results.purge = await purgeImport({ origin: graph.origin, labels: graph.purgeLabels, where: graph.purgeWhere || null }, database);
  }

  // reference data first so relationships resolve, then inventory
  const groups = new Map();
  for (const n of graph.nodes) {
    const key = `${n.label}|${n.mergeKey}|${n.mode}`;
    if (!groups.has(key)) groups.set(key, { label: n.label, mergeKey: n.mergeKey, mode: n.mode, rows: [] });
    groups.get(key).rows.push({ p: n.props, a: n.alwaysProps || null });
  }
  const ordered = Array.from(groups.values()).sort((a, b) => (a.mode === 'create' ? 0 : 1) - (b.mode === 'create' ? 0 : 1) || a.label.localeCompare(b.label));
  for (const g of ordered) {
    const summary = { label: g.label, mode: g.mode, total: g.rows.length, created: 0, replaced: 0, ignored: 0, failed: [] };
    const labels = g.label.split(':');
    const onCreateOnly = g.mode === 'create' || onExisting !== 'replace';
    let done = 0;
    for (const batch of chunk(g.rows, BATCH)) {
      progress(`Nodes ${g.label}: ${done} / ${g.rows.length}`);
      try {
        const existing = new Set(await findExistingKeys(
          { label: labels[0], key: g.mergeKey, values: batch.map((r) => r.p[g.mergeKey]) }, database
        ));
        await mergeImportNodes({ labels, mergeKey: g.mergeKey, rows: batch, onCreateOnly }, database);
        for (const r of batch) {
          if (!existing.has(r.p[g.mergeKey])) summary.created += 1;
          else if (onCreateOnly) summary.ignored += 1;
          else summary.replaced += 1;
        }
      } catch (err) {
        summary.failed.push({ rows: batch.length, message: err.message });
      }
      done += batch.length;
    }
    results.nodes.push(summary);
  }

  const relGroups = new Map();
  for (const r of graph.rels) {
    const key = `${r.fromLabel}|${r.toLabel}|${r.type}`;
    if (!relGroups.has(key)) relGroups.set(key, { fromLabel: r.fromLabel, toLabel: r.toLabel, type: r.type, rows: [] });
    relGroups.get(key).rows.push({ s: r.s, t: r.t, p: r.props });
  }
  for (const g of relGroups.values()) {
    const summary = { type: g.type, fromLabel: g.fromLabel, toLabel: g.toLabel, total: g.rows.length, created: 0, failed: [] };
    let done = 0;
    for (const batch of chunk(g.rows, BATCH)) {
      progress(`Relationships ${g.type}: ${done} / ${g.rows.length}`);
      try {
        summary.created += await mergeImportRelationships({
          fromLabel: g.fromLabel.split(':')[0], toLabel: g.toLabel.split(':')[0], type: g.type, rows: batch, origin: graph.origin
        }, database);
      } catch (err) {
        summary.failed.push({ rows: batch.length, message: err.message });
      }
      done += batch.length;
    }
    results.relationships.push(summary);
  }

  if (graph.serverLinks && graph.serverLinks.length > 0) {
    progress('Linking addresses to existing servers…');
    results.serverLinks = { candidates: graph.serverLinks.length, linked: 0, failed: [] };
    for (const batch of chunk(graph.serverLinks, BATCH)) {
      try {
        results.serverLinks.linked += await linkImportedIpsToServers({ rows: batch, origin: graph.origin, sourceFile: graph.sourceFile }, database);
      } catch (err) {
        results.serverLinks.failed.push({ rows: batch.length, message: err.message });
      }
    }
  }
  return results;
}
