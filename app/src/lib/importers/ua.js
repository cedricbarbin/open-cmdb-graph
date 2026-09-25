// Browser port of tools/ua2cypher/ua2cypher.py - loads the two JSON graphs
// the understand-anything plugin writes (.ua/knowledge-graph.json and
// .ua/domain-graph.json). Same mapping, same ids, same options (see that
// tool's README).
import { GraphBuilder, readTextFile, slug } from './common.js';

const ORIGIN = 'understand-anything';
const FILE_LEVEL_TYPES = new Set(['file', 'document', 'service', 'pipeline', 'schema', 'resource']);
const ENRICHMENT_LABELS = ['DataStructure', 'Module', 'Concept', 'CodeLayer', 'TourStep', 'FlowStep'];
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']);
const COMPLEXITY_MAP = { simple: 'low', moderate: 'medium', complex: 'high', low: 'low', medium: 'medium', high: 'high' };
const CONFIG_FORMATS = { '.yaml': 'yaml', '.yml': 'yaml', '.json': 'json', '.xml': 'xml', '.ini': 'ini', '.properties': 'properties', '.env': 'env', '.toml': 'toml', '.cfg': 'ini' };
const UI_LANGUAGES = new Set(['html', 'jsx', 'tsx', 'vue', 'svelte', 'dspf', 'displayfile', 'xaml', 'razor']);
const UI_TAGS = new Set(['ui', 'form', 'component', 'view', 'screen', 'page', 'display-file', 'dspf', 'template']);

export const UA_OPTIONS = [
  { key: 'appId', label: 'Application id', type: 'text', placeholder: 'app-<project slug> (an existing node is reused)' },
  { key: 'appName', label: 'Application name', type: 'text', placeholder: 'from the project when created' },
  { key: 'repoId', label: 'Repository id', type: 'text', placeholder: 'repo-<project slug>' },
  { key: 'repoUrl', label: 'Repository URL', type: 'text', placeholder: 'optional' },
  { key: 'branch', label: 'Default branch', type: 'text', default: 'main' },
  { key: 'confidence', label: 'Algorithm confidence', type: 'text', default: '0.8' }
];

function ext(path) {
  const m = String(path || '').match(/(\.[^./\\]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function basename(path) {
  return String(path || '').split(/[\\/]/).pop();
}

function lineRange(node) {
  const lr = node.lineRange;
  if (Array.isArray(lr) && lr.length === 2) {
    const a = Number(lr[0]); const b = Number(lr[1]);
    return Number.isFinite(a) && Number.isFinite(b) ? [Math.trunc(a), Math.trunc(b)] : null;
  }
  return null;
}

function overlaps(a, b) {
  return a && b && a[0] <= b[1] && b[0] <= a[1];
}

export function classifyUaFile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const nodes = Array.isArray(data.nodes) ? data.nodes : null;
  if (!nodes) return null;
  const types = new Set(nodes.map((n) => n && n.type));
  if (types.has('domain') || types.has('flow') || types.has('step')) return 'domain';
  if (data.project || data.layers || data.tour || Array.from(types).some((t) => FILE_LEVEL_TYPES.has(t) || ['function', 'class', 'config', 'table', 'endpoint'].includes(t))) return 'knowledge';
  return null;
}

class UaBuilder extends GraphBuilder {
  constructor(o, sourceFile) {
    super({ origin: ORIGIN, sourceFile, strict: o.strict, enrichmentLabels: ENRICHMENT_LABELS, purgeLabels: null });
    this.o = o;
    this.appId = o.appId;
    this.key = slug(o.appId.replace(/^app-/, ''));
    this.repoId = o.repoId;
    this.confidence = Number.isFinite(parseFloat(o.confidence)) ? parseFloat(o.confidence) : 0.8;
    this.uaIndex = new Map();
    this.extractedAt = null;
  }

  add(label, id, props, uaId, mergeKey = 'id') {
    if (this.strict && this.enrichmentLabels.has(label)) return null;
    const base = { appId: this.appId };
    if (uaId) { base.uaId = uaId; this.uaIndex.set(uaId, id); }
    if (this.extractedAt) base.extractedAt = this.extractedAt;
    return this.addNode(label, id, { ...base, ...(props || {}) }, { mergeKey });
  }

  loadKnowledge(kg) {
    const project = kg.project || {};
    const analyzedAt = project.analyzedAt ? new Date(project.analyzedAt) : null;
    this.extractedAt = analyzedAt && !Number.isNaN(analyzedAt.getTime()) ? analyzedAt : new Date();
    const name = this.o.appName || project.name || this.appId;
    this.project = {
      name, description: project.description, languages: project.languages || [], frameworks: project.frameworks || [],
      commit: project.gitCommitHash, analyzedAt: project.analyzedAt, graphVersion: kg.version
    };
    // Application (never overwrite hand-maintained properties; ua* provenance always refreshed) and Repository
    this.addNode('Application', this.appId, { name, description: project.description }, { mode: 'create' });
    const app = this.nodes.get(this.appId);
    app.special = true; // no origin: the Application is not removed by a purge
    app.alwaysProps = {
      uaProject: name, uaLanguages: this.project.languages, uaFrameworks: this.project.frameworks, uaCommit: this.project.commit || null,
      uaAnalyzedAt: this.project.analyzedAt || null, uaGraphVersion: this.project.graphVersion || null
    };
    this.addNode('Repository', this.repoId, {
      name, description: project.description, vcsType: 'git', url: this.o.repoUrl || null, defaultBranch: this.o.branch || 'main', appId: this.appId
    }, { mode: 'create' });
    this.addRel(this.appId, this.repoId, 'SOURCE_REPOSITORY');

    const layerOfFile = {};
    for (const layer of kg.layers || []) for (const nid of layer.nodeIds || []) layerOfFile[nid] = layer.name;
    const nodes = kg.nodes || [];
    for (const n of nodes) {
      const t = n.type;
      if (FILE_LEVEL_TYPES.has(t)) this.addSourceFile(n, layerOfFile[n.id]);
      else if (t === 'config') this.settingFile(n);
      else if (t === 'table') this.data(n);
      else if (t === 'endpoint') this.endpointFromKg(n);
      else if (t === 'module' || t === 'concept') {
        this.add(t[0].toUpperCase() + t.slice(1), `${t}-${this.key}-${slug(n.name)}`, { name: n.name, description: n.summary, tags: n.tags }, n.id);
      }
    }
    for (const n of nodes) {
      if (n.type === 'function') this.algorithm(n);
      else if (n.type === 'class') this.dataStructure(n);
    }
    for (const n of nodes) {
      if ((n.type === 'function' || n.type === 'class') && n.filePath) {
        const sid = this.uaIndex.get(n.id);
        const fid = this.uaIndex.get(this.fileUaId(n.filePath));
        if (sid && fid) this.addRel(sid, fid, 'DEFINED_IN');
      }
    }
    for (const e of kg.edges || []) this.kgEdge(e);
    for (const layer of kg.layers || []) {
      const lid = this.add('CodeLayer', `layer-${this.key}-${slug(layer.name || layer.id)}`, { name: layer.name, description: layer.description }, layer.id);
      if (!lid) continue;
      this.addRel(this.appId, lid, 'HAS_LAYER');
      for (const nid of layer.nodeIds || []) this.addRel(this.uaIndex.get(nid), lid, 'IN_LAYER');
    }
    for (const step of kg.tour || []) {
      const order = step.order;
      const tid = this.add('TourStep', `tour-${this.key}-${order}`, { name: step.title, order, description: step.description, languageLesson: step.languageLesson });
      if (!tid) continue;
      this.addRel(this.appId, tid, 'HAS_TOUR_STEP', { order });
      for (const nid of step.nodeIds || []) this.addRel(tid, this.uaIndex.get(nid), 'INSPECTS');
    }
    this.stats.kg_nodes = nodes.length;
    this.stats.kg_edges = (kg.edges || []).length;
  }

  fileUaId(path) {
    for (const prefix of ['file', 'config', 'document', 'service', 'pipeline', 'schema', 'resource']) {
      const cand = `${prefix}:${path}`;
      if (this.uaIndex.has(cand)) return cand;
    }
    return null;
  }

  fileId(path) { return `src-${this.key}-${slug(path)}`; }

  addSourceFile(n, layerName) {
    const path = n.filePath || n.name;
    const fid = this.add('SourceFile', this.fileId(path), {
      path, name: n.name, language: n.language, description: n.summary, fileCategory: n.fileCategory || n.type,
      tags: n.tags, complexity: n.complexity, notes: n.languageNotes
    }, n.id);
    this.addRel(this.repoId, fid, 'CONTAINS_FILE');
    const tags = new Set((n.tags || []).map((t) => String(t).toLowerCase()));
    const lang = String(n.language || '').toLowerCase();
    if (n.fileCategory === 'markup' || UI_LANGUAGES.has(lang) || Array.from(tags).some((t) => UI_TAGS.has(t))) {
      const formId = this.add('Form', `form-${this.key}-${slug(path)}`, { name: n.name, description: n.summary, module: layerName, path });
      this.addRel(this.appId, formId, 'HAS_FORM');
      this.addRel(formId, fid, 'DEFINED_IN');
    }
    return fid;
  }

  settingFile(n) {
    const path = n.filePath || n.name;
    const cid = this.add('SettingFile', `cfg-${this.key}-${slug(path)}`, {
      name: n.name || basename(path), path, format: CONFIG_FORMATS[ext(path)], description: n.summary, tags: n.tags
    }, n.id);
    this.addRel(this.appId, cid, 'HAS_SETTING_FILE');
    this.addRel(this.repoId, cid, 'CONTAINS_FILE');
    return cid;
  }

  data(n) {
    return this.add('Data', `data-${this.key}-${slug(n.filePath || '')}-${slug(n.name)}`, {
      name: n.name, description: n.summary, type: 'database', path: n.filePath, tags: n.tags
    }, n.id);
  }

  endpointFromKg(n) {
    const name = n.name || '';
    let method = null; let path = null;
    const m = name.match(/^\s*([A-Z]+)\s+(\S+)/);
    if (m && HTTP_METHODS.has(m[1])) { method = m[1]; path = m[2]; }
    const eid = this.add('Endpoint', `ep-${this.key}-${slug(n.filePath || '')}-${slug(name)}`, {
      name, description: n.summary, method, path, protocol: method ? 'REST' : null, tags: n.tags
    }, n.id);
    this.addRel(this.appId, eid, 'HAS_ENDPOINT');
    return eid;
  }

  algorithm(n) {
    const lr = lineRange(n);
    const aid = this.add('Algorithm', `algo-${this.key}-${slug(n.filePath || '')}-${slug(n.name)}`, {
      name: n.name, description: n.summary, complexity: COMPLEXITY_MAP[String(n.complexity || '').toLowerCase()],
      generatedBy: 'ai-generated', confidence: this.confidence, path: n.filePath, lineStart: lr ? lr[0] : null,
      lineEnd: lr ? lr[1] : null, tags: n.tags, notes: n.languageNotes
    }, n.id);
    this.addRel(this.appId, aid, 'HAS_ALGORITHM');
    return aid;
  }

  dataStructure(n) {
    const lr = lineRange(n);
    return this.add('DataStructure', `ds-${this.key}-${slug(n.filePath || '')}-${slug(n.name)}`, {
      name: n.name, description: n.summary, complexity: n.complexity, path: n.filePath, lineStart: lr ? lr[0] : null,
      lineEnd: lr ? lr[1] : null, tags: n.tags, notes: n.languageNotes
    }, n.id);
  }

  kgEdge(e) {
    const s = this.uaIndex.get(e.source); const t = this.uaIndex.get(e.target); const et = String(e.type || '');
    if (!s || !t) return;
    const props = { weight: e.weight, direction: e.direction, uaType: et };
    const ls = this.labelOf.get(s); const lt = this.labelOf.get(t);
    if (et === 'contains') {
      if (['SourceFile', 'SettingFile'].includes(ls) && ['Algorithm', 'DataStructure', 'Endpoint', 'Form'].includes(lt)) this.addRel(t, s, 'DEFINED_IN');
      else this.addRel(s, t, 'CONTAINS', props);
    } else if (et === 'imports') this.addRel(s, t, 'IMPORTS', props);
    else if (et === 'calls') this.addRel(s, t, 'CALLS', props);
    else if (et === 'reads_from' && lt === 'Data') { this.addRel(s, t, 'READS_FROM', props); this.addRel(this.appId, t, 'CONSUMES_DATA'); }
    else if (et === 'writes_to' && lt === 'Data') { this.addRel(s, t, 'WRITES_TO', props); this.addRel(this.appId, t, 'OWNS_DATA'); }
    else if (et === 'related') this.addRel(s, t, 'RELATED_TO', props);
    else this.addRel(s, t, et.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'RELATED_TO', props);
  }

  loadDomain(dg) {
    if (!this.extractedAt) {
      const at = (dg.project || {}).analyzedAt;
      this.extractedAt = at ? new Date(at) : null;
    }
    const nodes = dg.nodes || [];
    const edges = dg.edges || [];
    const domainOfFlow = {};
    for (const e of edges) if (e.type === 'contains_flow') domainOfFlow[e.target] = e.source;
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const algos = Array.from(this.nodes.values()).filter((n) => n.label === 'Algorithm');

    for (const n of nodes) {
      if (n.type !== 'domain') continue;
      const meta = n.domainMeta || {};
      const did = this.add('BusinessDomain', `bd-${this.key}-${slug(n.name)}`, {
        name: n.name, description: n.summary, tags: n.tags, complexity: n.complexity, entities: meta.entities,
        businessRules: meta.businessRules, crossDomainInteractions: meta.crossDomainInteractions
      }, n.id, 'name');
      this.addRel(this.appId, did, 'IN_BUSINESS_DOMAIN');
    }
    for (const n of nodes) {
      if (n.type !== 'flow') continue;
      const meta = n.domainMeta || {};
      const dom = byId[domainOfFlow[n.id]] || {};
      const fid = this.add('Function', `func-${this.key}-${slug(n.name)}`, {
        name: n.name, description: n.summary, category: dom.name, tags: n.tags, complexity: n.complexity,
        entryPoint: meta.entryPoint, entryType: meta.entryType
      }, n.id);
      this.addRel(this.appId, fid, 'HAS_FUNCTION');
      if (dom.id) this.addRel(fid, this.uaIndex.get(dom.id), 'IN_BUSINESS_DOMAIN');
      if (meta.entryPoint) {
        const entryType = String(meta.entryType || '').toLowerCase();
        const prog = (String(meta.entryPoint).match(/[A-Za-z][A-Za-z0-9_./-]{2,}/g) || [])
          .find((tok) => !['CALL', 'CALLP', 'CALLB', 'EXSR', 'POST', 'GET', 'PUT', 'PATCH', 'DELETE'].includes(tok.toUpperCase())) || null;
        const eid = this.add('Endpoint', `ep-${this.key}-${slug(n.name)}`, {
          name: meta.entryPoint, description: `Entry point of business function '${n.name}'`,
          protocol: entryType === 'http' ? 'REST' : null, entryType: entryType || null, path: prog
        });
        this.addRel(this.appId, eid, 'HAS_ENDPOINT');
        this.addRel(fid, eid, 'REALIZED_BY');
      }
    }
    const stepOrder = {};
    const stepEdges = edges.filter((e) => e.type === 'flow_step').sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : (a.weight || 0) - (b.weight || 0)));
    for (const e of stepEdges) {
      stepOrder[e.source] = (stepOrder[e.source] || 0) + 1;
      const flow = byId[e.source]; const step = byId[e.target];
      if (!flow || !step) continue;
      const fid = this.uaIndex.get(flow.id);
      const lr = lineRange(step);
      const sid = this.add('FlowStep', `step-${this.key}-${slug(flow.name)}-${slug(step.name)}`, {
        name: step.name, description: step.summary, order: stepOrder[e.source], weight: e.weight, path: step.filePath,
        lineStart: lr ? lr[0] : null, lineEnd: lr ? lr[1] : null, tags: step.tags, complexity: step.complexity
      }, step.id);
      if (sid) this.addRel(fid, sid, 'HAS_STEP', { order: stepOrder[e.source], weight: e.weight });
      const path = step.filePath;
      if (path) {
        const fileId = this.fileId(path);
        if (this.hasNode(fileId)) {
          this.addRel(fid, fileId, 'DEFINED_IN');
          if (sid) this.addRel(sid, fileId, 'DEFINED_IN');
        } else this.warnings.push(`step '${step.name}' references unknown file '${path}'`);
        for (const a of algos) {
          const ap = a.props;
          if (ap.path === path && lr && ap.lineStart !== undefined && overlaps(lr, [ap.lineStart, ap.lineEnd])) {
            this.addRel(fid, ap.id, 'REALIZED_BY');
            if (sid) this.addRel(sid, ap.id, 'IMPLEMENTED_BY');
          }
        }
      }
    }
    for (const e of edges) {
      if (e.type === 'cross_domain') this.addRel(this.uaIndex.get(e.source), this.uaIndex.get(e.target), 'DEPENDS_ON', { description: e.description, weight: e.weight });
    }
    this.stats.dg_nodes = nodes.length;
    this.stats.dg_edges = edges.length;
  }
}

export async function readUaFiles(files) {
  const out = { knowledge: null, domain: null };
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith('.json')) throw new Error(`${f.name}: expected knowledge-graph.json / domain-graph.json`);
    const data = JSON.parse(await readTextFile(f));
    const lower = f.name.toLowerCase();
    const kind = lower.includes('domain') ? 'domain' : lower.includes('knowledge') ? 'knowledge' : classifyUaFile(data);
    if (kind === 'knowledge') out.knowledge = data;
    else if (kind === 'domain') out.domain = data;
  }
  return out;
}

export async function buildUaGraph(files, options = {}) {
  const { knowledge, domain } = await readUaFiles(files);
  if (!knowledge) throw new Error('knowledge-graph.json not found among the selected files (run /understand first)');
  const projectName = (knowledge.project || {}).name || 'project';
  const o = {
    ...options,
    appId: (options.appId || '').trim() || `app-${slug(projectName)}`,
    repoId: (options.repoId || '').trim() || `repo-${slug(projectName)}`
  };
  const b = new UaBuilder(o, files.map((f) => f.name).join(', '));
  b.loadKnowledge(knowledge);
  if (domain) b.loadDomain(domain);
  const graph = b.toGraph();
  graph.purgeWhere = { appId: o.appId }; // a purge removes this application's previous import only (the Application node is kept)
  return graph;
}
