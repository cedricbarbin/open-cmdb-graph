// Browser port of tools/rvtools2cypher/rvtools2cypher.py - same mapping,
// same ids, same options (see that tool's README for the full table).
import {
  GraphBuilder, Tab, clean, envKey, headerSet, mibToGb, parseCsvObjects, readTextFile, shortHost, slug, toBool,
  toDateTime, toInt, DEFAULT_ENV_MAP, ENVIRONMENT_IDS, parseEnvMap, parseIp, ipKind
} from './common.js';
import { readXlsx } from './xlsx.js';

const ORIGIN = 'rvtools';
const ENRICHMENT_LABELS = ['Cluster', 'Datastore'];
const PURGE_LABELS = ['Server', 'NetworkInterface', 'IPAddress', 'Cluster', 'Datastore'];

const VINFO_COLUMNS = {
  vm: ['vm', 'vmname', 'name'], powerstate: ['powerstate'], template: ['template'], srm: ['srmplaceholder'],
  config_status: ['configstatus'], dns_name: ['dnsname', 'guesthostname', 'hostname'], connection_state: ['connectionstate'],
  guest_state: ['gueststate'], heartbeat: ['heartbeat'], boot_time: ['poweron', 'boottime'],
  create_date: ['creationdate', 'createdate'], change_version: ['changeversion'], cpus: ['cpus'], memory: ['memory'],
  nics: ['nics'], disks: ['disks'], disk_capacity: ['totaldiskcapacitymib', 'totaldiskcapacity'],
  primary_ip: ['primaryipaddress'], resource_pool: ['resourcepool'], folder: ['folder'], vapp: ['vapp'],
  provisioned: ['provisionedmib', 'provisioned'], in_use: ['inusemib', 'inuse'], firmware: ['firmware'],
  hw_version: ['hwversion', 'version'], path: ['path'], annotation: ['annotation'], datacenter: ['datacenter'],
  cluster: ['cluster'], host: ['host'], os_config: ['osaccordingtotheconfigurationfile', 'os'],
  os_tools: ['osaccordingtothevmwaretools', 'ostools'], vm_id: ['vmid'], vm_uuid: ['vmuuid', 'uuid'],
  vcenter: ['visdkserver'], ha_restart_priority: ['harestartpriority'], latency_sensitivity: ['latencysensitivity']
};
const VHOST_COLUMNS = {
  host: ['host', 'name', 'hostname'], datacenter: ['datacenter'], cluster: ['cluster'], config_status: ['configstatus'],
  cpu_model: ['cpumodel'], num_cpu: ['numcpu', 'cpu'], cores_per_cpu: ['corespercpu'], num_cores: ['numcores', 'cores'],
  memory: ['nummemory', 'memory', 'memorymib'], num_vms: ['numvms', 'vms'], esx_version: ['esxversion'],
  boot_time: ['boottime'], domain: ['domain'], vendor: ['vendor'], model: ['model'], serial: ['serialnumber'],
  service_tag: ['servicetag'], bios_version: ['biosversion'], uuid: ['uuid'], object_id: ['objectid'], vcenter: ['visdkserver']
};
const VCLUSTER_COLUMNS = {
  name: ['name', 'cluster', 'clustername'], config_status: ['configstatus'], overall_status: ['overallstatus'],
  num_hosts: ['numhosts', 'hosts'], total_cpu: ['totalcpu'], num_cores: ['numcpucores'], total_memory: ['totalmemory'],
  ha_enabled: ['haenabled'], drs_enabled: ['drsenabled'], vcenter: ['visdkserver']
};
const VDATASTORE_COLUMNS = {
  name: ['name', 'datastore', 'datastorename'], config_status: ['configstatus'], type: ['type'], num_vms: ['numvms', 'vms'],
  num_hosts: ['numhosts'], capacity: ['capacitymib', 'capacity'], provisioned: ['provisionedmib', 'provisioned'],
  in_use: ['inusemib', 'inuse'], free: ['freemib', 'free'], hosts: ['hosts'], url: ['url'], vcenter: ['visdkserver']
};
const VNETWORK_COLUMNS = {
  vm: ['vm', 'vmname'], adapter: ['adapter'], network: ['network'], switch: ['switch'], connected: ['connected'],
  mac: ['macaddress', 'mac'], mac_type: ['mactype'], type: ['type'], ipv4: ['ipv4address'], ipv6: ['ipv6address']
};
const TAB_COLUMNS = { vInfo: VINFO_COLUMNS, vHost: VHOST_COLUMNS, vCluster: VCLUSTER_COLUMNS, vDatastore: VDATASTORE_COLUMNS, vNetwork: VNETWORK_COLUMNS };
// checked in this order because vNetwork/vCPU/vMemory also carry VM + Powerstate + Host columns
const TAB_SIGNATURES = [
  ['vNetwork', ['vm', 'adapter', 'mac']],
  ['vHost', ['host', 'esx_version', 'vendor']],
  ['vCluster', ['name', 'ha_enabled', 'drs_enabled']],
  ['vDatastore', ['name', 'capacity', 'free']],
  ['vInfo', ['vm', 'powerstate', ['disk_capacity', 'primary_ip', 'folder', 'path']]]
];

export const RVTOOLS_OPTIONS = [
  { key: 'appColumn', label: 'Application column', type: 'text', placeholder: 'auto: ApplicationName tag' },
  { key: 'domainColumn', label: 'Business domain column', type: 'text', placeholder: 'auto: ApplicationDomain tag' },
  { key: 'envColumn', label: 'Environment column', type: 'text', placeholder: 'auto: Environment tag' },
  { key: 'siteColumn', label: 'Site / datacenter column', type: 'text', placeholder: 'auto: SITE tag, then Datacenter' },
  { key: 'envMap', label: 'Environment map', type: 'text', placeholder: 'X=production,S=other (optional overrides)' },
  { key: 'provider', label: 'Location provider', type: 'text', default: 'VMware vSphere' },
  { key: 'poweredOffStatus', label: 'Status for powered-off VMs', type: 'select', options: ['maintenance', 'active', 'decommissioned'], default: 'maintenance' },
  { key: 'skipTemplates', label: 'Skip templates', type: 'checkbox', default: false },
  { key: 'skipPoweredOff', label: 'Skip powered-off VMs', type: 'checkbox', default: false },
  { key: 'noVmLocation', label: 'Do not link VMs to their site (LOCATED_IN)', type: 'checkbox', default: false },
  { key: 'noTags', label: 'Do not copy vInfo_tags_* columns onto VMs', type: 'checkbox', default: false }
];

function tagName(h) {
  const m = String(h ?? '').match(/^\s*(?:v\w+?)?_?tags?[_ ]+(.+)$/i);
  return m ? m[1].trim() : null;
}

function detectTabs(sheets) {
  const tabs = [];
  for (const [name, rows] of Object.entries(sheets)) {
    if (!rows || rows.length === 0) continue;
    const headers = headerSet(rows, { stripTabPrefix: true });
    let kind = null;
    for (const [k, sig] of TAB_SIGNATURES) {
      const cols = TAB_COLUMNS[k];
      const has = (c) => cols[c].some((a) => headers.has(a));
      if (sig.every((alt) => (Array.isArray(alt) ? alt.some(has) : has(alt)))) { kind = k; break; }
    }
    if (kind) tabs.push(new Tab(kind, name, rows, TAB_COLUMNS[kind], { stripTabPrefix: true }));
  }
  return tabs;
}

function pickTabs(tabs) {
  const kinds = {};
  for (const t of tabs) {
    const n = t.name.toLowerCase().replace(/[^a-z]/g, '').replace('rvtoolstab', '');
    if (!kinds[t.kind] || n === t.kind.toLowerCase()) kinds[t.kind] = t;
  }
  return kinds;
}

/** Is this file set an RVTools export? (used by the Import page's auto-detection) */
export function looksLikeRvtools(sheets) {
  return detectTabs(sheets).length > 0;
}

export async function readRvtoolsFiles(files) {
  const sheets = {};
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) Object.assign(sheets, await readXlsx(f));
    else if (lower.endsWith('.csv')) sheets[f.name.replace(/\.csv$/i, '')] = parseCsvObjects(await readTextFile(f));
    else throw new Error(`${f.name}: expected an RVTools .xlsx export or RVTools_tab*.csv files`);
  }
  return sheets;
}

class RvtoolsBuilder extends GraphBuilder {
  constructor(options, sourceFile) {
    super({ origin: ORIGIN, sourceFile, strict: options.strict, enrichmentLabels: ENRICHMENT_LABELS, purgeLabels: PURGE_LABELS });
    this.o = options;
    this.envMap = { ...DEFAULT_ENV_MAP, ...parseEnvMap(options.envMap) };
    this.userEnvKeys = new Set(Object.keys(parseEnvMap(options.envMap)));
    this.vmIds = new Map();
    this.hostIds = new Map();
    this.hostSites = new Map(); // host id -> Map(site -> votes)
    this.appEnvs = new Map();
    this.dsHosts = new Map();
  }

  environment(raw) {
    if (raw === null || raw === undefined) return [null, null];
    let canon = this.envMap[envKey(raw)];
    if (!canon) { this.count(`unmapped_environment:${raw}`); canon = 'other'; }
    const id = ENVIRONMENT_IDS[canon];
    this.addNode('Environment', id, { name: canon, description: canon[0].toUpperCase() + canon.slice(1) }, { mode: 'create', mergeKey: 'name' });
    return [canon, id];
  }

  location(raw) {
    if (!raw) return null;
    const id = `loc-dc-${slug(raw)}`;
    this.addNode('Location:Datacenter', id, { name: String(raw), type: 'Datacenter', provider: this.o.provider || 'VMware vSphere' }, { mode: 'create' });
    return id;
  }

  domain(raw) {
    if (!raw) return null;
    const id = `bd-${slug(raw)}`;
    this.addNode('BusinessDomain', id, { name: String(raw) }, { mode: 'create', mergeKey: 'name' });
    return id;
  }

  application(raw, domainRaw) {
    if (!raw) return null;
    const id = `app-${slug(raw)}`;
    this.addNode('Application', id, { name: String(raw), businessService: domainRaw, criticality: this.o.defaultCriticality || 'medium' }, { mode: 'create' });
    const did = this.domain(domainRaw);
    if (did) this.addRel(id, did, 'IN_BUSINESS_DOMAIN');
    return id;
  }

  cluster(raw, props) {
    if (!raw) return null;
    return this.addNode('Cluster', `cluster-${slug(raw)}`, { name: String(raw), type: 'vSphere cluster', ...(props || {}) });
  }

  datastore(raw, props) {
    if (!raw) return null;
    return this.addNode('Datastore', `ds-${slug(raw)}`, { name: String(raw), ...(props || {}) });
  }

  host(raw, props, site, cluster) {
    if (!raw) return null;
    const key = shortHost(raw);
    let id = this.hostIds.get(key);
    if (!id) { id = `srv-phy-${slug(raw)}`; this.hostIds.set(key, id); }
    const base = { hostname: String(raw).toLowerCase(), os: 'VMware ESXi', status: 'active', hypervisor: 'VMware ESXi', serverType: 'hypervisor' };
    this.addNode('Server:Physical', id, { ...base, ...(props || {}) });
    if (site) {
      if (!this.hostSites.has(id)) this.hostSites.set(id, new Map());
      const votes = this.hostSites.get(id);
      votes.set(site, (votes.get(site) || 0) + 1);
    }
    if (cluster) {
      const cid = this.cluster(cluster);
      this.nodeProps(id).cluster = String(cluster);
      this.addRel(id, cid, 'IN_CLUSTER');
    }
    return id;
  }

  pickColumn(tab, option, candidates) {
    if (option) {
      const h = tab.headers.find((x) => x.trim().toLowerCase() === option.trim().toLowerCase());
      if (!h) this.warnings.push(`column "${option}" not found in sheet "${tab.name}"`);
      return h || null;
    }
    for (const h of tab.headers) {
      const t = tagName(h) || h;
      if (candidates.has(t.toLowerCase().replace(/[^a-z0-9]/g, ''))) return h;
    }
    return null;
  }

  loadVinfo(tab) {
    const o = this.o;
    const appCol = this.pickColumn(tab, o.appColumn, new Set(['applicationname', 'application', 'app', 'appname']));
    const domCol = this.pickColumn(tab, o.domainColumn, new Set(['applicationdomain', 'domain', 'businessdomain']));
    const envCol = this.pickColumn(tab, o.envColumn, new Set(['environment', 'env', 'environnement']));
    let siteCol = this.pickColumn(tab, o.siteColumn, new Set(['site', 'location', 'datacenter', 'dc']));
    if (!siteCol && tab.col.datacenter) siteCol = tab.col.datacenter;
    const consumed = new Set([appCol, domCol, envCol, siteCol].filter(Boolean));
    const tagCols = [];
    if (!o.noTags) {
      for (const h of tab.headers) {
        if (consumed.has(h)) continue;
        const t = tagName(h);
        if (t) tagCols.push([h, t.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '')]);
      }
    }
    // French "X = eXploitation (production), P = Pré-production" convention: only when both codes coexist
    if (envCol && !this.userEnvKeys.has('P')) {
      const codes = new Set(tab.rows.map((r) => envKey(clean(r[envCol]) || '')));
      if (codes.has('X') && codes.has('P')) { this.envMap.P = 'pre-production'; this.envMap.PAVERIF = 'pre-production'; }
    }
    this.stats.vInfo_columns = { application: appCol, domain: domCol, environment: envCol, site: siteCol, tags: tagCols.map((t) => t[0]) };

    const seenIds = new Map();
    for (const row of tab.rows) {
      const name = tab.get(row, 'vm');
      if (!name) { this.count('vInfo_rows_skipped_no_name'); continue; }
      const isTemplate = toBool(tab.get(row, 'template')) === true;
      if (isTemplate && o.skipTemplates) { this.count('vInfo_templates_skipped'); continue; }
      const power = tab.get(row, 'powerstate') || '';
      if (power.toLowerCase() === 'poweredoff' && o.skipPoweredOff) { this.count('vInfo_powered_off_skipped'); continue; }
      let id = `vm-${slug(name)}`;
      if (seenIds.has(id) && seenIds.get(id) !== name) {
        id = `${id}-${slug(tab.get(row, 'vm_id') || tab.get(row, 'vm_uuid') || String(seenIds.size))}`;
      } else if (seenIds.has(id)) this.warnings.push(`duplicate VM name "${name}": rows merged into ${id}`);
      seenIds.set(id, name);
      this.vmIds.set(name, id);

      const envRaw = envCol ? clean(row[envCol]) : null;
      const [envName, envId] = this.environment(envRaw);
      const siteRaw = siteCol ? clean(row[siteCol]) : null;
      const dcRaw = tab.get(row, 'datacenter');
      const hostRaw = tab.get(row, 'host');
      const clusterRaw = tab.get(row, 'cluster');
      const osTools = tab.get(row, 'os_tools'); const osCfg = tab.get(row, 'os_config');
      const status = power.toLowerCase() === 'poweredon' && !isTemplate ? 'active' : (o.poweredOffStatus || 'maintenance');
      const cpus = toInt(tab.get(row, 'cpus'));
      const props = {
        hostname: tab.get(row, 'dns_name') || name, name, ipAddress: tab.get(row, 'primary_ip'),
        os: osTools || osCfg, osConfigured: osTools && osCfg !== osTools ? osCfg : null, status,
        environment: envName, environmentCode: envRaw && envRaw.toLowerCase() !== envName ? envRaw : null,
        cpuCores: cpus, vCpu: cpus, ramGB: mibToGb(tab.get(row, 'memory')), diskGB: mibToGb(tab.get(row, 'disk_capacity')),
        provisionedGB: mibToGb(tab.get(row, 'provisioned')), inUseGB: mibToGb(tab.get(row, 'in_use')),
        hypervisor: 'VMware ESXi', powerState: power || null, guestState: tab.get(row, 'guest_state'),
        connectionState: tab.get(row, 'connection_state'), configStatus: tab.get(row, 'config_status'),
        heartbeat: tab.get(row, 'heartbeat'), template: isTemplate, srmPlaceholder: toBool(tab.get(row, 'srm')),
        firmware: tab.get(row, 'firmware'), hwVersion: tab.get(row, 'hw_version'), vmPath: tab.get(row, 'path'),
        folder: tab.get(row, 'folder'), resourcePool: tab.get(row, 'resource_pool'), vApp: tab.get(row, 'vapp'),
        site: siteRaw, datacenter: dcRaw, cluster: clusterRaw, esxHost: hostRaw ? hostRaw.toLowerCase() : null,
        vmId: tab.get(row, 'vm_id'), vmUuid: tab.get(row, 'vm_uuid'), vCenter: tab.get(row, 'vcenter'),
        haRestartPriority: tab.get(row, 'ha_restart_priority'), latencySensitivity: tab.get(row, 'latency_sensitivity'),
        description: tab.get(row, 'annotation'), createdAt: toDateTime(tab.raw(row, 'create_date')),
        bootTime: toDateTime(tab.raw(row, 'boot_time')), changedAt: toDateTime(tab.raw(row, 'change_version'))
      };
      for (const [h, tname] of tagCols) {
        const v = clean(row[h]);
        if (v !== null) props[`tag_${tname}`] = v;
      }
      this.addNode('Server:Virtual', id, props);

      if (envId) this.addRel(id, envId, 'IN_ENVIRONMENT');
      const locRaw = siteRaw || dcRaw;
      const locId = this.location(locRaw);
      if (locId && !o.noVmLocation) this.addRel(id, locId, 'LOCATED_IN');
      const hid = this.host(hostRaw, null, locRaw, clusterRaw);
      if (hid) this.addRel(id, hid, 'HOSTED_ON');
      const cid = this.cluster(clusterRaw);
      if (cid) this.addRel(id, cid, 'IN_CLUSTER');
      const m = (tab.get(row, 'path') || '').match(/^\[([^\]]+)\]/);
      if (m) {
        const dsid = this.datastore(m[1]);
        if (dsid) this.addRel(id, dsid, 'USES_DATASTORE');
      }
      const appRaw = appCol ? clean(row[appCol]) : null;
      const domRaw = domCol ? clean(row[domCol]) : null;
      const aid = this.application(appRaw, domRaw);
      if (aid) {
        this.addRel(aid, id, 'DEPLOYED_ON');
        if (envName) { if (!this.appEnvs.has(aid)) this.appEnvs.set(aid, new Set()); this.appEnvs.get(aid).add(envName); }
      } else if (domRaw) this.domain(domRaw);
      this.count('vInfo_rows');
    }
  }

  loadVhost(tab) {
    for (const row of tab.rows) {
      const name = tab.get(row, 'host');
      if (!name) continue;
      let cores = toInt(tab.get(row, 'num_cores'));
      if (cores === null) {
        const n = toInt(tab.get(row, 'num_cpu')); const cpc = toInt(tab.get(row, 'cores_per_cpu'));
        cores = n && cpc ? n * cpc : null;
      }
      const esx = tab.get(row, 'esx_version');
      const props = {
        osVersion: esx ? esx.replace(/^VMware ESXi\s*/i, '') : null, cpuCores: cores, cpuSockets: toInt(tab.get(row, 'num_cpu')),
        cpuModel: tab.get(row, 'cpu_model'), ramGB: mibToGb(tab.get(row, 'memory')), vendor: tab.get(row, 'vendor'),
        model: tab.get(row, 'model'), serialNumber: tab.get(row, 'serial') || tab.get(row, 'service_tag'),
        serviceTag: tab.get(row, 'service_tag'), biosVersion: tab.get(row, 'bios_version'), domain: tab.get(row, 'domain'),
        uuid: tab.get(row, 'uuid'), objectId: tab.get(row, 'object_id'), vCenter: tab.get(row, 'vcenter'),
        configStatus: tab.get(row, 'config_status'), vmCount: toInt(tab.get(row, 'num_vms')),
        bootTime: toDateTime(tab.raw(row, 'boot_time')), datacenter: tab.get(row, 'datacenter')
      };
      const dc = tab.get(row, 'datacenter');
      const hid = this.host(name, props, null, tab.get(row, 'cluster'));
      if (dc) {
        this.addRel(hid, this.location(dc), 'LOCATED_IN');
        this.hostSites.set(hid, new Map()); // authoritative: no majority vote needed
      }
      this.count('vHost_rows');
    }
  }

  loadVcluster(tab) {
    for (const row of tab.rows) {
      const name = tab.get(row, 'name');
      if (!name) continue;
      this.cluster(name, {
        configStatus: tab.get(row, 'config_status'), overallStatus: tab.get(row, 'overall_status'),
        hostCount: toInt(tab.get(row, 'num_hosts')), totalCpuMHz: toInt(tab.get(row, 'total_cpu')),
        cpuCores: toInt(tab.get(row, 'num_cores')), ramGB: mibToGb(tab.get(row, 'total_memory')),
        haEnabled: toBool(tab.get(row, 'ha_enabled')), drsEnabled: toBool(tab.get(row, 'drs_enabled')), vCenter: tab.get(row, 'vcenter')
      });
      this.count('vCluster_rows');
    }
  }

  loadVdatastore(tab) {
    for (const row of tab.rows) {
      const name = tab.get(row, 'name');
      if (!name) continue;
      const dsid = this.datastore(name, {
        type: tab.get(row, 'type'), configStatus: tab.get(row, 'config_status'), capacityGB: mibToGb(tab.get(row, 'capacity')),
        provisionedGB: mibToGb(tab.get(row, 'provisioned')), inUseGB: mibToGb(tab.get(row, 'in_use')),
        freeGB: mibToGb(tab.get(row, 'free')), vmCount: toInt(tab.get(row, 'num_vms')), url: tab.get(row, 'url'), vCenter: tab.get(row, 'vcenter')
      });
      const hosts = tab.get(row, 'hosts');
      if (dsid && hosts) this.dsHosts.set(dsid, hosts);
      this.count('vDatastore_rows');
    }
  }

  loadVnetwork(tab) {
    for (const row of tab.rows) {
      const vm = tab.get(row, 'vm');
      const vid = vm ? this.vmIds.get(vm) : null;
      if (!vid) { this.count('vNetwork_rows_unknown_vm'); continue; }
      const adapter = tab.get(row, 'adapter') || 'nic';
      const mac = tab.get(row, 'mac');
      const nicId = `nic-${vid.slice(3)}-${slug(adapter)}`;
      this.addNode('NetworkInterface', nicId, {
        name: adapter, type: 'data', mac: mac ? mac.toLowerCase() : null, macType: tab.get(row, 'mac_type'),
        adapterType: tab.get(row, 'type'), network: tab.get(row, 'network'), switch: tab.get(row, 'switch'),
        connected: toBool(tab.get(row, 'connected'))
      });
      this.addRel(vid, nicId, 'HAS_INTERFACE');
      for (const key of ['ipv4', 'ipv6']) {
        for (const addr of (tab.get(row, key) || '').split(/[,\s;]+/)) {
          if (!addr.trim()) continue;
          const ip = parseIp(addr.trim());
          if (!ip) { this.warnings.push(`vNetwork: invalid IP "${addr}" on ${vm}`); continue; }
          const ipId = `ip-${slug(ip.text)}`;
          this.addNode('IPAddress', ipId, { address: ip.text, version: `v${ip.version}`, type: ipKind(ip) }, { mergeKey: 'address' });
          this.addRel(nicId, ipId, 'HAS_IP');
        }
      }
      this.count('vNetwork_rows');
    }
  }

  finish() {
    for (const [hid, votes] of this.hostSites) {
      if (votes.size === 0) continue;
      const site = Array.from(votes.entries()).sort((a, b) => b[1] - a[1])[0][0];
      this.addRel(hid, this.location(site), 'LOCATED_IN');
      const p = this.nodeProps(hid);
      if (p.datacenter === undefined) p.datacenter = site;
    }
    for (const [dsid, hosts] of this.dsHosts) {
      for (const h of hosts.split(/[,;/|\s]+/)) {
        const hid = h ? this.hostIds.get(shortHost(h)) : null;
        if (hid) this.addRel(hid, dsid, 'MOUNTS');
      }
    }
    for (const [aid, envs] of this.appEnvs) {
      for (const e of envs) this.addRel(aid, ENVIRONMENT_IDS[e], 'IN_ENVIRONMENT');
      if (envs.size === 1) this.nodeProps(aid).environment = Array.from(envs)[0];
    }
    this.stats.environment_map = Object.fromEntries(Object.entries(this.envMap).filter(([k]) => k.length <= 2 || k.endsWith('AVERIF')));
  }
}

/** files: File[] (one .xlsx, or RVTools_tab*.csv files) -> import graph */
export async function buildRvtoolsGraph(files, options = {}) {
  const sheets = await readRvtoolsFiles(files);
  const tabs = detectTabs(sheets);
  const kinds = pickTabs(tabs);
  if (!kinds.vInfo) {
    const seen = Object.entries(sheets).map(([n, r]) => `"${n}" (${r.length} rows)`).join(', ');
    throw new Error(`No vInfo sheet found (a sheet with VM / Powerstate / Host columns); sheets seen: ${seen || 'none'}`);
  }
  const b = new RvtoolsBuilder(options, files.map((f) => f.name).join(', '));
  if (kinds.vCluster) b.loadVcluster(kinds.vCluster);
  if (kinds.vDatastore) b.loadVdatastore(kinds.vDatastore);
  if (kinds.vHost) b.loadVhost(kinds.vHost);
  b.loadVinfo(kinds.vInfo);
  if (kinds.vNetwork) b.loadVnetwork(kinds.vNetwork);
  b.finish();
  b.stats.sheets = Object.fromEntries(tabs.map((t) => [t.name, t.kind]));
  return b.toGraph();
}
