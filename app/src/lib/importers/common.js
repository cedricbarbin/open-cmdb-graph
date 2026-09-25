// Shared plumbing for the in-browser ports of the tools/*2cypher importers
// (rvtools.js, efficientip.js, proxmox.js, ua.js). Same algorithm as the
// Python CLIs in tools/: same ids, same labels, same "refresh vs. create
// only if missing" split - but instead of emitting Cypher text, an
// importer fills a GraphBuilder whose toGraph() output index.js loads with
// parameterized UNWIND batches (see loadImportGraph).

// ---------------------------------------------------------------- strings
export function slug(s) {
  const out = String(s ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().replace(/-{2,}/g, '-');
  return out || 'x';
}

export function clean(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) s = s.slice(1, -1).trim();
  if (s === '' || ['#N/A', '#REF!', '#VALUE!', '#NAME?', '#DIV/0!', 'N/A', 'NULL', 'NONE', '-'].includes(s.toUpperCase())) return null;
  return s;
}

export function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const f = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(f) ? Math.round(f) : null;
}

export function toFloat(v, digits = 2) {
  if (v === null || v === undefined || v === '') return null;
  const f = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(f) ? Number(f.toFixed(digits)) : null;
}

export function toBool(v) {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(s)) return true;
  if (['false', 'no', '0', 'off'].includes(s)) return false;
  return null;
}

export function mibToGb(v) {
  const i = toInt(v);
  return i === null ? null : Number((i / 1024).toFixed(1));
}

export function bytesToGb(v) {
  const i = toInt(v);
  return i === null ? null : Number((i / 1024 ** 3).toFixed(1));
}

/** 'Primary IP Address' -> 'primaryipaddress', '# CPU' -> 'numcpu', and an
 * RVTools tab prefix ('vInfoVMName' -> 'vmname') is stripped when asked. */
const TAB_PREFIXES = ['vinfo', 'vhost', 'vcluster', 'vdatastore', 'vnetwork', 'vcpu', 'vmemory', 'vdisk', 'vpartition',
  'vsnapshot', 'vtools', 'vsource', 'vrp', 'vnic', 'vswitch', 'vport', 'dvswitch', 'dvport', 'vhba', 'vmultipath',
  'vhealth', 'vlicense', 'vfilelist', 'vmetadata'];

export function normHeader(h, { stripTabPrefix = false } = {}) {
  let n = String(h ?? '').toLowerCase().replace(/#/g, 'num').replace(/[^a-z0-9]+/g, '');
  if (stripTabPrefix) {
    for (const p of TAB_PREFIXES) {
      if (n.startsWith(p) && n.length > p.length) { n = n.slice(p.length); break; }
    }
  }
  return n;
}

// ---------------------------------------------------------------- dates
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

/** Excel serial, ISO-ish or RVTools 'yyyy/mm/dd hh:mm:ss' text -> Date (UTC), or null.
 * vSphere's 1970-01-01 "unknown" is dropped. */
export function toDateTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const f = parseFloat(s);
    if (f > 60 && f < 2958466) {
      const ms = Math.round((EXCEL_EPOCH_MS + f * 86400000) / 1000) * 1000;
      const d = new Date(ms);
      return d.getUTCFullYear() > 1970 ? d : null;
    }
    return null;
  }
  let m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
    return d.getUTCFullYear() > 1970 ? d : null;
  }
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    // ambiguous dd/mm vs mm/dd: assume dd/mm unless the first number can only be a month
    const a = +m[1]; const b = +m[2];
    const [day, month] = a > 12 ? [a, b] : (b > 12 ? [b, a] : [a, b]);
    const d = new Date(Date.UTC(+m[3], month - 1, day, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
    return d.getUTCFullYear() > 1970 ? d : null;
  }
  return null;
}

export function epochToDateTime(v) {
  const i = toInt(v);
  return i ? new Date(i * 1000) : null;
}

// ---------------------------------------------------------------- CSV / JSON readers
/** RFC4180-ish parser with a configurable delimiter (the app's csv.js is
 * comma-only; SOLIDserver and RVTools exports are frequently ';'). */
export function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

export function sniffDelimiter(text) {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') || '';
  let best = ','; let bestCount = -1;
  for (const d of [',', ';', '\t', '|']) {
    let count = 0; let inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === d) count += 1;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/** CSV text -> array of row objects (header -> non-empty cell). */
export function parseCsvObjects(text) {
  const rows = parseDelimitedRows(text, sniffDelimiter(text));
  let header = null;
  const out = [];
  for (const rec of rows) {
    if (header === null) {
      if (!rec.some((x) => x.trim() !== '')) continue;
      header = rec.map((h) => h.trim());
      continue;
    }
    const obj = {};
    rec.forEach((v, i) => { if (i < header.length && v !== '') obj[header[i]] = v; });
    out.push(obj);
  }
  return out;
}

/** File -> text, tolerating UTF-16 and Windows-1252 exports. */
export async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
    return new TextDecoder('utf-16').decode(buf);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** JSON text -> list of objects (unwraps {"data": [...]} API envelopes). */
export function jsonObjects(text) {
  let data = JSON.parse(text);
  if (data && !Array.isArray(data) && typeof data === 'object') {
    for (const key of ['data', 'result', 'results', 'items', 'rows']) {
      if (Array.isArray(data[key]) || (data[key] && typeof data[key] === 'object')) { data = data[key]; break; }
    }
    if (!Array.isArray(data)) data = [data];
  }
  return Array.isArray(data) ? data.filter((d) => d && typeof d === 'object' && !Array.isArray(d)) : [];
}

/** Rows exposed through canonical column keys (aliases matched on the
 * normalized header) - the "Tab" of the Python tools. */
export class Tab {
  constructor(kind, name, rows, columns, { stripTabPrefix = false } = {}) {
    this.kind = kind;
    this.name = name;
    this.rows = rows;
    const seen = new Set();
    this.headers = [];
    for (const r of rows) for (const h of Object.keys(r)) if (!seen.has(h)) { seen.add(h); this.headers.push(h); }
    const byNorm = new Map();
    for (const h of this.headers) {
      const n = normHeader(h, { stripTabPrefix });
      if (!byNorm.has(n)) byNorm.set(n, h);
    }
    this.col = {};
    for (const [key, aliases] of Object.entries(columns)) {
      for (const a of aliases) {
        if (byNorm.has(a)) { this.col[key] = byNorm.get(a); break; }
      }
    }
  }

  get(row, key) {
    const h = this.col[key];
    return h ? clean(row[h]) : null;
  }

  raw(row, key) {
    const h = this.col[key];
    return h ? row[h] : undefined;
  }
}

export function headerSet(rows, opts) {
  const s = new Set();
  for (const r of rows) for (const h of Object.keys(r)) s.add(normHeader(h, opts));
  return s;
}

// ---------------------------------------------------------------- environments
export const ENVIRONMENTS = [
  ['production', 'env-production'],
  ['pre-production', 'env-preproduction'],
  ['qualification', 'env-qualification'],
  ['development', 'env-development'],
  ['other', 'env-other']
];
export const ENVIRONMENT_IDS = Object.fromEntries(ENVIRONMENTS);

export const DEFAULT_ENV_MAP = {
  P: 'production', PROD: 'production', PRD: 'production', PRODUCTION: 'production', X: 'production',
  XAVERIF: 'production', EXPLOITATION: 'production',
  PP: 'pre-production', PREPROD: 'pre-production', PREPRODUCTION: 'pre-production', STAGING: 'pre-production',
  STG: 'pre-production', STAGE: 'pre-production', PRE: 'pre-production',
  Q: 'qualification', QUAL: 'qualification', QUALIFICATION: 'qualification', QA: 'qualification', UAT: 'qualification',
  R: 'qualification', RECETTE: 'qualification', T: 'qualification', TEST: 'qualification', TST: 'qualification',
  INT: 'qualification', INTEGRATION: 'qualification',
  D: 'development', DEV: 'development', DEVELOPMENT: 'development', DEVELOPPEMENT: 'development',
  S: 'other', SANDBOX: 'other', LAB: 'other', O: 'other', OTHER: 'other'
};

export function envKey(raw) {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "X=production,S=other" (the CLI --env-map syntax) -> overrides object; throws on an unknown environment. */
export function parseEnvMap(text) {
  const out = {};
  for (const pair of String(text || '').split(/[,\n]/)) {
    if (!pair.includes('=')) continue;
    const [k, v] = pair.split('=', 2).map((x) => x.trim());
    const env = v.toLowerCase();
    if (!ENVIRONMENT_IDS[env]) throw new Error(`Environment map: "${v}" is not one of ${ENVIRONMENTS.map((e) => e[0]).join(', ')}`);
    out[envKey(k)] = env;
  }
  return out;
}

// ---------------------------------------------------------------- IP helpers (ipaddress-module subset)
function parseIPv4(s) {
  const m = String(s).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return BigInt(((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]);
}

function parseIPv6(s) {
  let str = String(s).trim().toLowerCase();
  if (str.includes('%')) str = str.split('%')[0];
  if (!/^[0-9a-f:.]+$/.test(str) || !str.includes(':')) return null;
  // embedded IPv4 tail
  const v4tail = str.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4tail) {
    const v4 = parseIPv4(v4tail[2]);
    if (v4 === null) return null;
    str = `${v4tail[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else groups = head;
  if (groups.length !== 8 || groups.some((g) => g === '' || g.length > 4)) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g, 16));
  return n;
}

export function parseIp(s) {
  const raw = clean(s);
  if (!raw) return null;
  const v4 = parseIPv4(raw);
  if (v4 !== null) return { version: 4, value: v4, text: raw };
  const v6 = parseIPv6(raw);
  if (v6 !== null) return { version: 6, value: v6, text: formatIPv6(v6) };
  return null;
}

function formatIPv4(n) {
  return [24, 16, 8, 0].map((sh) => Number((n >> BigInt(sh)) & 255n)).join('.');
}

function formatIPv6(n) {
  const groups = [];
  for (let i = 7; i >= 0; i -= 1) groups.push(Number((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  // compress the longest run of zero groups (RFC 5952)
  let bestStart = -1; let bestLen = 0; let curStart = -1; let curLen = 0;
  groups.forEach((g, i) => {
    if (g === '0') {
      if (curStart < 0) { curStart = i; curLen = 0; }
      curLen += 1;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else curStart = -1;
  });
  if (bestLen < 2) return groups.join(':');
  const left = groups.slice(0, bestStart).join(':');
  const right = groups.slice(bestStart + bestLen).join(':');
  return `${left}::${right}`;
}

export function formatIp(ip) {
  return ip.version === 4 ? formatIPv4(ip.value) : formatIPv6(ip.value);
}

/** Network object: { version, network (BigInt), prefix, cidr, numAddresses (BigInt) }. Host bits are masked off (strict=False). */
export function makeNetwork(ip, prefix) {
  const bits = ip.version === 4 ? 32 : 128;
  if (prefix === null || prefix === undefined || prefix < 0 || prefix > bits) return null;
  const hostBits = BigInt(bits - prefix);
  const network = (ip.value >> hostBits) << hostBits;
  const numAddresses = 1n << hostBits;
  const base = { version: ip.version, value: network };
  return { version: ip.version, network, prefix, cidr: `${formatIp(base)}/${prefix}`, numAddresses };
}

export function ipInNetwork(ip, net) {
  if (ip.version !== net.version) return false;
  const hostBits = BigInt((net.version === 4 ? 32 : 128) - net.prefix);
  return (ip.value >> hostBits) << hostBits === net.network;
}

export function networkContains(outer, inner) {
  return outer.version === inner.version && outer.prefix < inner.prefix
    && ipInNetwork({ version: inner.version, value: inner.network }, outer);
}

/** '24' / '/24' / '255.255.255.0' / a SOLIDserver subnet_size ('256') -> prefix length, or null. */
export function prefixLength(netmask, version = 4) {
  const s0 = clean(netmask);
  if (s0 === null) return null;
  const s = s0.replace(/^\//, '');
  const maxLen = version === 4 ? 32 : 128;
  if (s.includes('.') || s.includes(':')) {
    const mask = parseIp(s);
    if (!mask) return null;
    const bits = mask.version === 4 ? 32 : 128;
    let n = mask.value; let ones = 0;
    // count leading ones and require contiguity
    for (let i = bits - 1; i >= 0; i -= 1) {
      if ((n >> BigInt(i)) & 1n) ones += 1; else break;
    }
    const expected = ((1n << BigInt(ones)) - 1n) << BigInt(bits - ones);
    return n === expected ? ones : null;
  }
  const n = toInt(s);
  if (n === null) return null;
  if (n >= 0 && n <= maxLen) return n;
  if (n > maxLen) {
    const big = BigInt(n);
    if ((big & (big - 1n)) === 0n) {
      let log = 0; let x = big;
      while (x > 1n) { x >>= 1n; log += 1; }
      return maxLen - log;
    }
  }
  return null;
}

export function toNetwork(address, netmask) {
  const a = clean(address);
  if (!a) return null;
  if (a.includes('/')) {
    const [addr, pl] = a.split('/');
    const ip = parseIp(addr);
    return ip ? makeNetwork(ip, toInt(pl)) : null;
  }
  const ip = parseIp(a);
  if (!ip) return null;
  return makeNetwork(ip, prefixLength(netmask, ip.version));
}

export function ipKind(ip) {
  if (ip.version === 4) {
    const v = ip.value;
    const inRange = (a, b) => v >= parseIPv4(a) && v <= parseIPv4(b);
    const isPrivate = inRange('10.0.0.0', '10.255.255.255') || inRange('172.16.0.0', '172.31.255.255')
      || inRange('192.168.0.0', '192.168.255.255') || inRange('169.254.0.0', '169.254.255.255')
      || inRange('127.0.0.0', '127.255.255.255') || inRange('100.64.0.0', '100.127.255.255') || v === 0n;
    return isPrivate ? 'private' : 'public';
  }
  const top = Number(ip.value >> 120n);
  if ((top & 0xfe) === 0xfc || ip.value === 1n) return 'private'; // fc00::/7, ::1
  if (Number(ip.value >> 118n) === 0x3fa) return 'private'; // fe80::/10
  return 'public';
}

// ---------------------------------------------------------------- misc
/** 'virtio=MAC,bridge=vmbr0,tag=20' -> { virtio: MAC, bridge, tag, _positional: [...] } */
export function parseKv(s) {
  const out = {};
  for (const part0 of String(s ?? '').split(',')) {
    const part = part0.trim();
    if (!part) continue;
    if (part.includes('=')) {
      const i = part.indexOf('=');
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    } else (out._positional = out._positional || []).push(part);
  }
  return out;
}

export function shortHost(h) {
  return String(h).split('.')[0].toLowerCase();
}

// ---------------------------------------------------------------- graph builder
export class GraphBuilder {
  constructor({ origin, sourceFile, strict = false, enrichmentLabels = [], enrichmentRels = [], purgeLabels = [] }) {
    this.origin = origin;
    this.sourceFile = sourceFile;
    this.strict = strict;
    this.enrichmentLabels = new Set(enrichmentLabels);
    this.enrichmentRels = new Set(enrichmentRels);
    this.purgeLabels = purgeLabels;
    this.importedAt = new Date();
    this.nodes = new Map(); // id -> { label, mergeKey, mode, props }
    this.rels = new Map(); // "s|t|type" -> { s, t, type, props }
    this.labelOf = new Map();
    this.stats = {};
    this.warnings = [];
    this.serverLinks = null; // efficientip --link-servers rows
  }

  count(key, n = 1) { this.stats[key] = (this.stats[key] || 0) + n; }

  /** mode 'refresh': SET n += props on every run (inventory); 'create': ON CREATE only (reference data). */
  addNode(label, id, props, { mode = 'refresh', mergeKey = 'id' } = {}) {
    if (this.strict && this.enrichmentLabels.has(label.split(':')[0])) return null;
    const cleanProps = { id };
    for (const [k, v] of Object.entries(props || {})) if (v !== null && v !== undefined && v !== '') cleanProps[k] = v;
    const existing = this.nodes.get(id);
    if (existing) Object.assign(existing.props, cleanProps);
    else {
      this.nodes.set(id, { label, mergeKey, mode, props: cleanProps });
      this.labelOf.set(id, label);
    }
    return id;
  }

  hasNode(id) { return this.nodes.has(id); }

  nodeProps(id) { return this.nodes.get(id)?.props; }

  addRel(s, t, type, props) {
    if (this.strict && this.enrichmentRels.has(type)) return;
    if (!s || !t || s === t || !this.nodes.has(s) || !this.nodes.has(t)) return;
    const key = `${s}|${t}|${type}`;
    const cleanProps = {};
    for (const [k, v] of Object.entries(props || {})) if (v !== null && v !== undefined) cleanProps[k] = v;
    const existing = this.rels.get(key);
    if (existing) Object.assign(existing.props, cleanProps);
    else this.rels.set(key, { s, t, type, props: cleanProps });
  }

  /** Provenance on every node, then the plain-data graph the loader and the preview consume. */
  toGraph() {
    for (const n of this.nodes.values()) {
      if (n.special) continue;
      if (n.props.origin === undefined) n.props.origin = this.origin;
      if (n.props.importedAt === undefined) n.props.importedAt = this.importedAt;
      if (n.props.sourceFile === undefined) n.props.sourceFile = this.sourceFile;
    }
    const nodes = Array.from(this.nodes.values());
    const rels = Array.from(this.rels.values()).map((r) => ({
      ...r, fromLabel: this.labelOf.get(r.s), toLabel: this.labelOf.get(r.t)
    }));
    const nodeCounts = {};
    for (const n of nodes) nodeCounts[n.label] = (nodeCounts[n.label] || 0) + 1;
    const relCounts = {};
    for (const r of rels) relCounts[r.type] = (relCounts[r.type] || 0) + 1;
    return {
      origin: this.origin,
      sourceFile: this.sourceFile,
      nodes,
      rels,
      serverLinks: this.serverLinks,
      purgeLabels: this.strict && this.purgeLabels ? this.purgeLabels.filter((l) => !this.enrichmentLabels.has(l)) : this.purgeLabels,
      enrichmentLabels: this.strict ? [] : Array.from(this.enrichmentLabels),
      summary: { nodes: nodeCounts, relationships: relCounts, input: this.stats, warnings: this.warnings }
    };
  }
}
