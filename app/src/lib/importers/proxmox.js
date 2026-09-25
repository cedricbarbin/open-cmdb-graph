// Browser port of tools/proxmox2cypher/proxmox2cypher.py - same mapping,
// same ids, same options (see that tool's README).
import {
  GraphBuilder, bytesToGb, envKey, jsonObjects, parseKv, readTextFile, slug, toBool, toFloat, toInt,
  DEFAULT_ENV_MAP, ENVIRONMENT_IDS, parseEnvMap, parseIp, makeNetwork, ipKind, formatIp
} from './common.js';

const ORIGIN = 'proxmox';
const ENRICHMENT_LABELS = ['Cluster', 'Datastore'];
const PURGE_LABELS = ['Server', 'NetworkInterface', 'IPAddress', 'Cluster', 'Datastore'];
const GIB = 1024 ** 3;
const OSTYPE_NAMES = {
  l24: 'Linux 2.4', l26: 'Linux', solaris: 'Solaris', other: 'Other', wxp: 'Windows XP', w2k: 'Windows 2000',
  w2k3: 'Windows Server 2003', w2k8: 'Windows Server 2008', wvista: 'Windows Vista', win7: 'Windows 7',
  win8: 'Windows 8 / Server 2012', win10: 'Windows 10 / Server 2016-2019', win11: 'Windows 11 / Server 2022'
};
const PVE_ENV_MAP = Object.fromEntries(Object.entries(DEFAULT_ENV_MAP).filter(([k]) => !['XAVERIF', 'EXPLOITATION', 'S', 'O', 'R', 'T'].includes(k)));

export const PROXMOX_OPTIONS = [
  { key: 'cluster', label: 'Cluster name', type: 'text', placeholder: 'when no /cluster/status object is among the files' },
  { key: 'datacenter', label: 'Datacenter (Location) for the nodes', type: 'text', placeholder: 'optional' },
  { key: 'envMap', label: 'Environment map', type: 'text', placeholder: 'prod=production,lab=other (optional overrides)' },
  { key: 'appTagPrefix', label: 'Application tag prefix', type: 'text', default: 'app:' },
  { key: 'poolAsApplication', label: 'Treat resource pools as applications', type: 'checkbox', default: false },
  { key: 'stoppedStatus', label: 'Status for stopped guests / offline nodes', type: 'select', options: ['maintenance', 'active', 'decommissioned'], default: 'maintenance' },
  { key: 'skipTemplates', label: 'Skip templates', type: 'checkbox', default: false },
  { key: 'skipStopped', label: 'Skip guests that are not running', type: 'checkbox', default: false }
];

function splitTags(v) {
  return String(v ?? '').split(/[;,]/).map((t) => t.trim()).filter(Boolean);
}

function sizeToGb(s) {
  if (s === null || s === undefined) return null;
  const m = String(s).match(/^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)\s*$/i);
  if (!m) return null;
  const n = parseFloat(m[1]); const unit = m[2].toUpperCase();
  const factor = { '': 1 / GIB, K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024 }[unit];
  return Number((n * factor).toFixed(1));
}

export function classifyProxmox(obj) {
  const t = String(obj.type || '').toLowerCase();
  if (['qemu', 'lxc', 'vm'].includes(t)) return 'vm';
  if (t === 'node') return 'node';
  if (t === 'storage') return 'storage';
  if (t === 'pool') return 'pool';
  if (t === 'cluster') return 'cluster';
  if (['sdn', 'openvz'].includes(t)) return null;
  if ('vmid' in obj && ('status' in obj || 'name' in obj) && !('digest' in obj)) return 'vm';
  if ('digest' in obj || Object.keys(obj).some((k) => /^(net|scsi|virtio|ide|sata|ipconfig|rootfs|mp)\d*$/.test(k)) || 'ostype' in obj) return 'config';
  if ('node' in obj && 'storage' in obj && ('total' in obj || 'avail' in obj)) return 'storage';
  if ('node' in obj && !('vmid' in obj) && ('maxcpu' in obj || 'uptime' in obj || 'level' in obj)) return 'node';
  if ('poolid' in obj) return 'pool';
  return null;
}

export async function readProxmoxFiles(files) {
  const out = [];
  for (const f of files) {
    if (!f.name.toLowerCase().endsWith('.json')) throw new Error(`${f.name}: expected Proxmox API .json files`);
    out.push({ name: f.name, objects: jsonObjects(await readTextFile(f)) });
  }
  return out;
}

class ProxmoxBuilder extends GraphBuilder {
  constructor(options, sourceFile) {
    super({ origin: ORIGIN, sourceFile, strict: options.strict, enrichmentLabels: ENRICHMENT_LABELS, purgeLabels: PURGE_LABELS });
    this.o = options;
    this.envMap = { ...PVE_ENV_MAP, ...parseEnvMap(options.envMap) };
    this.clusterId = null;
    this.vmByVmid = new Map();
    this.vmNames = new Map();
    this.configs = new Map();
    this.appEnvs = new Map();
    this.storageShared = new Map();
  }

  environment(raw) {
    const canon = this.envMap[envKey(raw)];
    if (!canon) return [null, null];
    const id = ENVIRONMENT_IDS[canon];
    this.addNode('Environment', id, { name: canon, description: canon[0].toUpperCase() + canon.slice(1) }, { mode: 'create', mergeKey: 'name' });
    return [canon, id];
  }

  location() {
    const dc = (this.o.datacenter || '').trim();
    if (!dc) return null;
    return this.addNode('Location:Datacenter', `loc-dc-${slug(dc)}`, { name: dc, type: 'Datacenter', provider: 'Proxmox VE' }, { mode: 'create' });
  }

  cluster(name, props) {
    if (!name) return null;
    this.clusterId = this.addNode('Cluster', `cluster-${slug(name)}`, { name, type: 'Proxmox VE cluster', ...(props || {}) });
    return this.clusterId;
  }

  application(name) {
    if (!name) return null;
    return this.addNode('Application', `app-${slug(name)}`, { name, criticality: this.o.defaultCriticality || 'medium' }, { mode: 'create' });
  }

  node(name, props) {
    if (!name) return null;
    const id = `srv-phy-${slug(name)}`;
    const base = { hostname: name, os: 'Proxmox VE', status: 'active', hypervisor: 'Proxmox VE', serverType: 'hypervisor' };
    this.addNode('Server:Physical', id, { ...(this.hasNode(id) ? {} : base), ...(props || {}) });
    if (this.clusterId) {
      this.addRel(id, this.clusterId, 'IN_CLUSTER');
      const p = this.nodeProps(id);
      if (p.cluster === undefined) p.cluster = this.nodeProps(this.clusterId).name;
    }
    const loc = this.location();
    if (loc) this.addRel(id, loc, 'LOCATED_IN');
    return id;
  }

  datastore(storage, node, props) {
    if (!storage) return null;
    const shared = this.storageShared.get(storage);
    const id = shared || shared === undefined || !node ? `ds-${slug(storage)}` : `ds-${slug(node)}-${slug(storage)}`;
    return this.addNode('Datastore', id, { name: storage, ...(props || {}) });
  }

  loadCluster(obj) {
    this.cluster(obj.name, { quorate: 'quorate' in obj ? Boolean(toInt(obj.quorate)) : null, nodeCount: toInt(obj.nodes), version: toInt(obj.version) });
    this.count('cluster');
  }

  loadNode(obj) {
    const status = String(obj.status || '').toLowerCase();
    this.node(obj.node || obj.name, {
      status: ['online', '', 'unknown'].includes(status) ? 'active' : (this.o.stoppedStatus || 'maintenance'),
      nodeStatus: status || null, cpuCores: toInt(obj.maxcpu), ramGB: bytesToGb(obj.maxmem), diskGB: bytesToGb(obj.maxdisk),
      ramUsedGB: bytesToGb(obj.mem), diskUsedGB: bytesToGb(obj.disk),
      cpuUsagePct: obj.cpu !== undefined && obj.cpu !== null ? toFloat(Number(obj.cpu) * 100, 1) : null,
      uptimeSeconds: toInt(obj.uptime), subscriptionLevel: obj.level || null, ipAddress: obj.ip,
      nodeId: String(obj.id || '').startsWith('node/') ? obj.id : null
    });
    this.count('nodes');
  }

  loadStorage(obj) {
    const storage = obj.storage;
    if (obj.shared !== undefined && obj.shared !== null) this.storageShared.set(storage, Boolean(toInt(obj.shared)));
    const node = obj.node;
    const dsid = this.datastore(storage, node, {
      type: obj.plugintype || (obj.type !== 'storage' ? obj.type : null), content: obj.content,
      shared: obj.shared !== undefined && obj.shared !== null ? Boolean(toInt(obj.shared)) : null,
      capacityGB: bytesToGb(obj.maxdisk ?? obj.total), inUseGB: bytesToGb(obj.disk ?? obj.used), freeGB: bytesToGb(obj.avail),
      status: obj.status, enabled: 'enabled' in obj ? Boolean(toInt(obj.enabled)) : null
    });
    if (dsid && node) this.addRel(this.node(node), dsid, 'MOUNTS');
    this.count('storages');
  }

  loadPool(obj) {
    const pool = obj.poolid || obj.pool;
    for (const m of obj.members || []) {
      if (m && typeof m === 'object' && m.vmid !== undefined) {
        const vid = this.vmByVmid.get(toInt(m.vmid));
        if (vid) { this.nodeProps(vid).pool = pool; this.poolApp(vid, pool); }
      }
    }
    this.count('pools');
  }

  poolApp(vid, pool) {
    if (this.o.poolAsApplication && pool) {
      const aid = this.application(pool);
      this.addRel(aid, vid, 'DEPLOYED_ON');
      const env = this.nodeProps(vid).environment;
      if (env) { if (!this.appEnvs.has(aid)) this.appEnvs.set(aid, new Set()); this.appEnvs.get(aid).add(env); }
    }
  }

  loadConfig(obj, filename) {
    let vmid = toInt(obj.vmid);
    if (vmid === null) {
      const m = filename.match(/(\d+)/);
      vmid = m ? Number(m[1]) : null;
    }
    if (vmid === null) { this.warnings.push(`${filename}: config object without a vmid (put the vmid in the file name, e.g. config-100.json)`); return; }
    this.configs.set(vmid, [obj, obj.node]);
    this.count('configs');
  }

  loadVm(obj) {
    const vmid = toInt(obj.vmid);
    const name = obj.name || (vmid !== null ? `vm-${vmid}` : null);
    if (!name) return;
    const vmType = String(obj.type || ('rootfs' in obj ? 'lxc' : 'qemu')).toLowerCase();
    const status = String(obj.status || '').toLowerCase();
    const isTemplate = Boolean(toInt(obj.template));
    if (isTemplate && this.o.skipTemplates) { this.count('templates_skipped'); return; }
    if (status !== 'running' && this.o.skipStopped) { this.count('stopped_skipped'); return; }
    let id = `vm-${slug(name)}`;
    this.vmNames.set(id, (this.vmNames.get(id) || 0) + 1);
    if (this.vmNames.get(id) > 1 || (this.hasNode(id) && this.nodeProps(id).vmid !== vmid)) id = `vm-${slug(name)}-${vmid}`;
    const tags = splitTags(obj.tags);
    let envName = null; let envId = null; let appName = null;
    const prefix = this.o.appTagPrefix === undefined ? 'app:' : this.o.appTagPrefix;
    for (const t of tags) {
      if (prefix && t.toLowerCase().startsWith(prefix.toLowerCase())) appName = t.slice(prefix.length) || null;
      else if (envName === null) [envName, envId] = this.environment(t);
    }
    const cpus = toInt(obj.maxcpu ?? obj.cpus);
    this.addNode('Server:Virtual', id, {
      hostname: name, name, vmid, vmType, status: status === 'running' && !isTemplate ? 'active' : (this.o.stoppedStatus || 'maintenance'),
      powerState: status || null, template: isTemplate, hypervisor: 'Proxmox VE', environment: envName, cpuCores: cpus, vCpu: cpus,
      ramGB: bytesToGb(obj.maxmem), diskGB: bytesToGb(obj.maxdisk), ramUsedGB: bytesToGb(obj.mem), diskUsedGB: bytesToGb(obj.disk),
      cpuUsagePct: obj.cpu !== undefined && obj.cpu !== null ? toFloat(Number(obj.cpu) * 100, 1) : null,
      uptimeSeconds: toInt(obj.uptime), node: obj.node, pool: obj.pool, haState: obj.hastate, lock: obj.lock, tags: tags.length ? tags : null,
      resourceId: String(obj.id || '').includes('/') ? obj.id : null
    });
    if (vmid !== null) this.vmByVmid.set(vmid, id);
    if (envId) this.addRel(id, envId, 'IN_ENVIRONMENT');
    if (obj.node) this.addRel(id, this.node(obj.node), 'HOSTED_ON');
    if (this.clusterId) this.addRel(id, this.clusterId, 'IN_CLUSTER');
    if (appName) {
      const aid = this.application(appName);
      this.addRel(aid, id, 'DEPLOYED_ON');
      if (envName) { if (!this.appEnvs.has(aid)) this.appEnvs.set(aid, new Set()); this.appEnvs.get(aid).add(envName); }
    }
    this.poolApp(id, obj.pool);
    this.count('vms');
  }

  applyConfigs() {
    for (const [vmid, [cfg, nodeHint]] of this.configs) {
      let id = this.vmByVmid.get(vmid);
      if (!id) {
        this.loadVm({ vmid, name: cfg.name || cfg.hostname, node: nodeHint, type: 'rootfs' in cfg ? 'lxc' : 'qemu', status: 'unknown', template: cfg.template, tags: cfg.tags });
        id = this.vmByVmid.get(vmid);
        if (!id) continue;
      }
      const p = this.nodeProps(id);
      const cores = toInt(cfg.cores); const sockets = toInt(cfg.sockets) || 1;
      const ostype = cfg.ostype;
      const upd = {
        cpuCores: cores ? cores * sockets : p.cpuCores, vCpu: cores ? cores * sockets : p.vCpu, cpuSockets: cores ? sockets : null,
        ramGB: cfg.memory ? Number((toInt(cfg.memory) / 1024).toFixed(1)) : p.ramGB,
        os: ostype ? (OSTYPE_NAMES[String(ostype).toLowerCase()] || ostype) : p.os, osType: ostype, description: cfg.description,
        bootOrder: cfg.boot, bios: cfg.bios, machine: cfg.machine, onBoot: 'onboot' in cfg ? Boolean(toInt(cfg.onboot)) : null,
        qemuAgent: cfg.agent, hostnameConfigured: cfg.hostname, vmGenId: cfg.vmgenid, smbios: cfg.smbios1
      };
      for (const [k, v] of Object.entries(upd)) if (v !== null && v !== undefined) p[k] = v;
      if (!p.template && toInt(cfg.template)) p.template = true;
      if (cfg.tags && !p.tags) p.tags = splitTags(cfg.tags);
      if (cfg.name && String(p.hostname || '').startsWith('vm-') && p.hostname !== cfg.name) p.hostname = cfg.name;

      const perDs = new Map();
      for (const [k, v] of Object.entries(cfg)) {
        if (/^(scsi|virtio|ide|sata|efidisk|tpmstate|rootfs|mp|unused)\d*$/.test(k) && typeof v === 'string') {
          const kv = parseKv(v);
          const spec = (kv._positional || [null])[0] || kv.file;
          if (!spec || spec === 'none' || spec === 'cdrom' || v.includes('media=cdrom')) continue;
          const storage = spec.includes(':') ? spec.split(':')[0] : null;
          if (!storage) continue;
          const dsid = this.datastore(storage, p.node);
          if (!dsid) continue;
          const entry = perDs.get(dsid) || { disks: [], sizeGB: 0 };
          entry.disks.push(k);
          entry.sizeGB = Number((entry.sizeGB + (sizeToGb(kv.size) || 0)).toFixed(1));
          perDs.set(dsid, entry);
        }
      }
      for (const [dsid, entry] of perDs) this.addRel(id, dsid, 'USES_DATASTORE', { disks: entry.disks, sizeGB: entry.sizeGB || null });

      const ipsByIndex = new Map();
      for (const [k, v] of Object.entries(cfg)) {
        const m = k.match(/^ipconfig(\d+)$/);
        if (m && typeof v === 'string') ipsByIndex.set(Number(m[1]), parseKv(v));
      }
      for (const [k, v] of Object.entries(cfg)) {
        const m = k.match(/^net(\d+)$/);
        if (!m || typeof v !== 'string') continue;
        const idx = Number(m[1]);
        const kv = parseKv(v);
        let model = null; let mac = null;
        for (const mk of ['virtio', 'e1000', 'e1000e', 'rtl8139', 'vmxnet3', 'hwaddr']) {
          if (mk in kv) { model = mk === 'hwaddr' ? 'veth' : mk; mac = kv[mk]; break; }
        }
        if (model === null && kv.model) { model = kv.model; mac = kv.macaddr; }
        const nicId = `nic-${id.slice(3)}-net${idx}`;
        this.addNode('NetworkInterface', nicId, {
          name: kv.name || `net${idx}`, type: 'data', mac: mac ? mac.toLowerCase() : null, model, bridge: kv.bridge, vlanTag: toInt(kv.tag),
          firewall: 'firewall' in kv ? Boolean(toInt(kv.firewall)) : null, linkDown: 'link_down' in kv ? Boolean(toInt(kv.link_down)) : null,
          rateMbps: toFloat(kv.rate)
        });
        this.addRel(id, nicId, 'HAS_INTERFACE');
        const tag = toInt(kv.tag);
        if (tag) {
          const vid = this.addNode('VLAN', `vlan-${tag}`, { name: `VLAN ${tag}`, vlanId: tag }, { mode: 'create' });
          this.addRel(nicId, vid, 'IN_VLAN');
        }
        const ipc = ipsByIndex.get(idx) || {};
        for (const key of ['ip', 'ip6']) {
          const special = ['dhcp', 'auto', 'manual'];
          const val = ipc[key] || (kv[key] && !special.includes(kv[key]) ? kv[key] : null) || (special.includes(kv[key]) ? kv[key] : null);
          if (!val) continue;
          if (special.includes(val)) { if (val !== 'manual') this.nodeProps(nicId).allocation = 'dhcp'; continue; }
          const [addr, pl] = val.split('/');
          const ip = parseIp(addr);
          if (!ip) { this.warnings.push(`vm ${vmid}: invalid ipconfig "${val}"`); continue; }
          const net = pl !== undefined ? makeNetwork(ip, toInt(pl)) : null;
          const address = formatIp(ip);
          const ipId = `ip-${slug(address)}`;
          this.addNode('IPAddress', ipId, {
            address, version: `v${ip.version}`, type: ipKind(ip), allocation: 'static', cidr: net ? net.cidr : null,
            gateway: ip.version === 4 ? ipc.gw : ipc.gw6
          }, { mergeKey: 'address' });
          this.addRel(nicId, ipId, 'HAS_IP');
          if (p.ipAddress === undefined) p.ipAddress = address;
        }
      }
      this.count('configs_applied');
    }
  }

  finish() {
    for (const [aid, envs] of this.appEnvs) {
      for (const e of envs) this.addRel(aid, ENVIRONMENT_IDS[e], 'IN_ENVIRONMENT');
      if (envs.size === 1) this.nodeProps(aid).environment = Array.from(envs)[0];
    }
  }
}

/** files: File[] (Proxmox API json files) -> import graph. `nodeOf` maps a file name to the node its guests live on. */
export async function buildProxmoxGraph(files, options = {}, nodeOf = {}) {
  const read = await readProxmoxFiles(files);
  const buckets = { cluster: [], node: [], storage: [], vm: [], config: [], pool: [], ignored: [] };
  for (const f of read) {
    for (const obj of f.objects) {
      if (nodeOf[f.name] && !('node' in obj)) obj.node = nodeOf[f.name];
      const kind = classifyProxmox(obj);
      (buckets[kind] || buckets.ignored).push([obj, f.name]);
    }
  }
  if (!buckets.vm.length && !buckets.config.length && !buckets.node.length) {
    throw new Error('No guest, config or node objects found (expected pvesh --output-format json output: /cluster/resources, /nodes/<n>/qemu, .../config …)');
  }
  const b = new ProxmoxBuilder(options, files.map((f) => f.name).join(', '));
  for (const [obj] of buckets.cluster) b.loadCluster(obj);
  if (!b.clusterId && options.cluster) b.cluster(options.cluster.trim());
  for (const [obj] of buckets.node) b.loadNode(obj);
  for (const [obj] of buckets.storage) b.loadStorage(obj);
  for (const [obj] of buckets.vm.sort((x, y) => (toInt(x[0].vmid) || 0) - (toInt(y[0].vmid) || 0))) b.loadVm(obj);
  for (const [obj, name] of buckets.config) b.loadConfig(obj, name);
  b.applyConfigs();
  for (const [obj] of buckets.pool) b.loadPool(obj);
  b.finish();
  b.stats.ignored_objects = buckets.ignored.length;
  return b.toGraph();
}
