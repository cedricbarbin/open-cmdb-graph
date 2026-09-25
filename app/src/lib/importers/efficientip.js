// Browser port of tools/efficientip2cypher/efficientip2cypher.py - same
// mapping, same ids, same options (see that tool's README).
import {
  GraphBuilder, Tab, clean, headerSet, jsonObjects, parseCsvObjects, readTextFile, slug, toInt,
  parseIp, toNetwork, makeNetwork, ipInNetwork, networkContains, ipKind, formatIp
} from './common.js';

const ORIGIN = 'efficientip';
const ENRICHMENT_LABELS = ['IPSpace'];
const ENRICHMENT_RELS = ['IN_SPACE', 'PART_OF'];
const PURGE_LABELS = ['Subnet', 'VLAN', 'IPAddress', 'NetworkInterface', 'IPSpace'];
const FREE_STATUSES = new Set(['free', 'libre', 'available', 'unassigned', '']);

const NETWORK_COLUMNS = {
  space: ['space', 'spacename', 'sitename', 'siteid', 'ipspace', 'vrf'],
  network: ['network', 'networkaddress', 'startaddress', 'starthostaddr', 'subnet', 'subnetaddress', 'subnetstartaddress', 'start'],
  netmask: ['netmask', 'prefix', 'prefixlength', 'prefixlen', 'mask', 'cidr', 'subnetsize', 'size'],
  end: ['endaddress', 'endhostaddr', 'end'], status: ['status', 'state', 'networkstatus', 'subnetstatus'],
  name: ['name', 'networkname', 'subnetname'], description: ['description', 'comment', 'subnetdescription', 'networkdescription'],
  gateway: ['gateway', 'gatewayaddress', 'subnetgateway', 'gw'], location: ['location', 'site', 'building', 'datacenter', 'dc'],
  vlan_id: ['vlanid', 'vlmvlanvlanid', 'vlannumber', 'vlantag'], vlan_name: ['vlan', 'vlanname', 'vlmvlanname'],
  vlan_domain: ['vlandomain', 'vlmdomainname'], terminal: ['isterminal', 'terminal', 'subnetisterminal'],
  parent: ['parentnetwork', 'parentsubnetname', 'parent'], class: ['class', 'subnetclassname', 'networkclass'],
  id: ['subnetid', 'networkid', 'id']
};
const ADDRESS_COLUMNS = {
  space: ['space', 'spacename', 'sitename', 'ipspace', 'vrf'], address: ['address', 'ipaddress', 'ip', 'hostaddr', 'hostaddress'],
  network: ['network', 'networkaddress', 'subnet', 'starthostaddr', 'subnetstartaddress'],
  netmask: ['netmask', 'prefix', 'prefixlength', 'mask', 'subnetsize', 'size'], subnet_name: ['subnetname', 'networkname'],
  name: ['name', 'hostname', 'fqdn', 'shortname', 'ipname'], mac: ['macaddress', 'mac', 'macaddr'],
  status: ['status', 'state', 'type', 'iptype'], device: ['device', 'devicename', 'hostdevname'],
  interface: ['interface', 'port', 'portname', 'hostifacename', 'ifname'], description: ['description', 'comment', 'ipdescription'],
  domain: ['domain', 'dnsdomain', 'domainname'], alias: ['alias', 'aliases', 'ipalias'], class: ['class', 'ipclassname'], id: ['ipid', 'id']
};
const VLAN_COLUMNS = {
  vlan_id: ['vlanid', 'vlmvlanvlanid', 'vlannumber', 'vlantag', 'id', 'number'], vlan_name: ['name', 'vlan', 'vlanname', 'vlmvlanname'],
  vlan_domain: ['domain', 'vlandomain', 'vlmdomainname'], description: ['description', 'comment']
};
const TAB_COLUMNS = { networks: NETWORK_COLUMNS, addresses: ADDRESS_COLUMNS, vlans: VLAN_COLUMNS };

export const EFFICIENTIP_OPTIONS = [
  { key: 'space', label: 'Only this IP space', type: 'text', placeholder: 'all spaces' },
  { key: 'includeFree', label: 'Include free/unassigned addresses', type: 'checkbox', default: false },
  { key: 'linkServers', label: 'Link addresses to existing servers (by hostname / IP)', type: 'checkbox', default: false },
  { key: 'vlanDomains', label: 'Key VLANs by domain too (vlan-<domain>-<id>)', type: 'checkbox', default: false },
  { key: 'noLocations', label: 'Do not create Datacenter nodes from Location/Site', type: 'checkbox', default: false }
];

export function detectEfficientipKind(rows) {
  const headers = headerSet(rows);
  if (ADDRESS_COLUMNS.address.some((a) => headers.has(a))) return 'addresses';
  if (NETWORK_COLUMNS.network.some((a) => headers.has(a))) return 'networks';
  if (['vlanid', 'vlmvlanvlanid', 'vlannumber', 'vlantag', 'vlmvlanname'].some((a) => headers.has(a))) return 'vlans';
  return null;
}

export async function readEfficientipFiles(files) {
  const out = [];
  for (const f of files) {
    const text = await readTextFile(f);
    const rows = f.name.toLowerCase().endsWith('.json') ? jsonObjects(text) : parseCsvObjects(text);
    out.push({ name: f.name, rows, kind: detectEfficientipKind(rows) });
  }
  return out;
}

class EfficientipBuilder extends GraphBuilder {
  constructor(options, sourceFile) {
    super({ origin: ORIGIN, sourceFile, strict: options.strict, enrichmentLabels: ENRICHMENT_LABELS, enrichmentRels: ENRICHMENT_RELS, purgeLabels: PURGE_LABELS });
    this.o = options;
    this.subnets = new Map(); // id -> { net, space }
    this.serverLinks = [];
  }

  location(raw) {
    if (!raw || this.o.noLocations) return null;
    return this.addNode('Location:Datacenter', `loc-dc-${slug(raw)}`, { name: String(raw), type: 'Datacenter' }, { mode: 'create' });
  }

  space(raw) {
    if (!raw) return null;
    return this.addNode('IPSpace', `ipspace-${slug(raw)}`, { name: String(raw) });
  }

  vlan(vlanId, name, domain, description) {
    let vid = toInt(vlanId);
    if (vid === null && !name) return null;
    if (vid === null) {
      const m = String(name).match(/\d+/);
      vid = m ? Number(m[0]) : null;
      if (vid === null) return null;
    }
    const id = domain && this.o.vlanDomains ? `vlan-${slug(domain)}-${vid}` : `vlan-${vid}`;
    if (this.hasNode(id) && !name) name = this.nodeProps(id).name;
    return this.addNode('VLAN', id, { name: name || `VLAN ${vid}`, vlanId: vid, description, vlanDomain: domain });
  }

  wantedSpace() { return this.o.space ? this.o.space.trim().toLowerCase() : null; }

  loadNetworks(tab) {
    const wanted = this.wantedSpace();
    for (const row of tab.rows) {
      const space = tab.get(row, 'space');
      if (wanted && (space || '').toLowerCase() !== wanted) { this.count('networks_other_space'); continue; }
      let net = toNetwork(tab.get(row, 'network'), tab.get(row, 'netmask'));
      if (!net) {
        const start = parseIp(tab.get(row, 'network')); const end = parseIp(tab.get(row, 'end'));
        if (start && end && start.version === end.version) {
          const size = end.value - start.value + 1n;
          if ((size & (size - 1n)) === 0n) {
            let log = 0; let x = size;
            while (x > 1n) { x >>= 1n; log += 1; }
            const candidate = makeNetwork(start, (start.version === 4 ? 32 : 128) - log);
            if (candidate && candidate.network === start.value) net = candidate;
          }
        }
      }
      if (!net) { this.warnings.push(`${tab.name}: cannot read network from "${tab.get(row, 'network')}"/"${tab.get(row, 'netmask')}"`); continue; }
      const id = `subnet-${slug(net.cidr)}`;
      if (this.hasNode(id) && this.subnets.get(id)?.space !== space) {
        this.warnings.push(`${net.cidr} exists in spaces "${this.subnets.get(id)?.space}" and "${space}": Subnet.cidr is unique, keeping the first (use the space filter to pick one)`);
        continue;
      }
      const status = (tab.get(row, 'status') || '').toLowerCase() || null;
      const terminal = tab.get(row, 'terminal');
      this.addNode('Subnet', id, {
        name: tab.get(row, 'name') || net.cidr, cidr: net.cidr, gateway: tab.get(row, 'gateway'), description: tab.get(row, 'description'),
        status, space, location: tab.get(row, 'location'), version: `v${net.version}`, prefixLength: net.prefix,
        addressCount: net.numAddresses < 2n ** 63n ? Number(net.numAddresses) : null, networkClass: tab.get(row, 'class'),
        sourceId: tab.get(row, 'id'), terminal: terminal !== null ? ['1', 'true', 'yes'].includes(terminal.toLowerCase()) : null,
        parentNetwork: tab.get(row, 'parent')
      }, { mergeKey: 'cidr' });
      this.subnets.set(id, { net, space });
      const sid = this.space(space);
      if (sid) this.addRel(id, sid, 'IN_SPACE');
      const loc = this.location(tab.get(row, 'location'));
      if (loc) this.addRel(id, loc, 'LOCATED_IN');
      const vid = this.vlan(tab.get(row, 'vlan_id'), tab.get(row, 'vlan_name'), tab.get(row, 'vlan_domain'));
      if (vid) this.addRel(id, vid, 'IN_VLAN');
      this.count('networks');
    }
  }

  loadVlans(tab) {
    for (const row of tab.rows) {
      if (this.vlan(tab.get(row, 'vlan_id'), tab.get(row, 'vlan_name'), tab.get(row, 'vlan_domain'), tab.get(row, 'description'))) this.count('vlans');
    }
  }

  findSubnet(ip, space, hint) {
    if (hint && this.subnets.has(hint)) return hint;
    let best = null; let bestLen = -1;
    for (const [id, { net, space: sp }] of this.subnets) {
      if (ipInNetwork(ip, net) && net.prefix > bestLen && (space === null || sp === null || sp === space)) { best = id; bestLen = net.prefix; }
    }
    return best;
  }

  loadAddresses(tab) {
    const wanted = this.wantedSpace();
    for (const row of tab.rows) {
      const space = tab.get(row, 'space');
      if (wanted && (space || '').toLowerCase() !== wanted) { this.count('addresses_other_space'); continue; }
      const raw = tab.get(row, 'address');
      const ip = raw ? parseIp(raw.split('/')[0]) : null;
      if (!ip) { this.warnings.push(`${tab.name}: invalid address "${raw}"`); continue; }
      const status = (tab.get(row, 'status') || '').toLowerCase();
      const name = tab.get(row, 'name'); const device = tab.get(row, 'device');
      if (FREE_STATUSES.has(status) && !(name || device || tab.get(row, 'mac')) && !this.o.includeFree) { this.count('addresses_free_skipped'); continue; }
      const hintNet = toNetwork(tab.get(row, 'network'), tab.get(row, 'netmask'));
      const hint = hintNet ? `subnet-${slug(hintNet.cidr)}` : null;
      if (hint && !this.subnets.has(hint)) {
        this.addNode('Subnet', hint, {
          name: tab.get(row, 'subnet_name') || hintNet.cidr, cidr: hintNet.cidr, space, version: `v${hintNet.version}`, prefixLength: hintNet.prefix
        }, { mergeKey: 'cidr' });
        this.subnets.set(hint, { net: hintNet, space });
        const sid = this.space(space);
        if (sid) this.addRel(hint, sid, 'IN_SPACE');
      }
      const subnetId = this.findSubnet(ip, space, hint);
      const mac = tab.get(row, 'mac');
      const domain = tab.get(row, 'domain');
      let hostname = name;
      if (hostname && domain && !hostname.includes('.')) hostname = `${hostname}.${domain}`;
      const address = formatIp(ip);
      const ipId = `ip-${slug(address)}`;
      this.addNode('IPAddress', ipId, {
        address, version: `v${ip.version}`, type: ipKind(ip), allocation: status.includes('dhcp') ? 'dhcp' : 'static',
        status: status || null, hostname, mac: mac ? mac.toLowerCase() : null, device, interface: tab.get(row, 'interface'),
        description: tab.get(row, 'description'), alias: tab.get(row, 'alias'), space, ipClass: tab.get(row, 'class'), sourceId: tab.get(row, 'id')
      }, { mergeKey: 'address' });
      if (subnetId) this.addRel(ipId, subnetId, 'IN_SUBNET'); else this.count('addresses_without_subnet');
      if (this.o.linkServers && (name || device)) {
        const names = Array.from(new Set([name, device].filter(Boolean).map((n) => n.split('.')[0].toLowerCase()))).sort();
        this.serverLinks.push({ ip: ipId, address, names, nic: tab.get(row, 'interface') || 'eth0', mac: mac ? mac.toLowerCase() : null });
      }
      this.count('addresses');
    }
  }

  finish() {
    const items = Array.from(this.subnets.entries()).sort((a, b) => a[1].net.prefix - b[1].net.prefix);
    for (const [id, { net, space }] of items) {
      let parent = null; let plen = -1;
      for (const [pid, { net: pnet, space: pspace }] of items) {
        if (pid !== id && pnet.prefix > plen && pspace === space && networkContains(pnet, net)) { parent = pid; plen = pnet.prefix; }
      }
      if (parent) this.addRel(id, parent, 'PART_OF');
    }
    if (this.serverLinks.length === 0) this.serverLinks = null;
  }
}

/** files: File[] (csv/json exports) -> import graph. `kinds` may force a file's kind by name. */
export async function buildEfficientipGraph(files, options = {}, kinds = {}) {
  const read = await readEfficientipFiles(files);
  const tabs = [];
  for (const f of read) {
    const kind = kinds[f.name] || f.kind;
    if (!kind) continue;
    tabs.push(new Tab(kind, f.name, f.rows, TAB_COLUMNS[kind]));
  }
  if (tabs.length === 0) throw new Error('No network / address / VLAN columns recognised in the selected files');
  const b = new EfficientipBuilder(options, files.map((f) => f.name).join(', '));
  for (const t of tabs) if (t.kind === 'vlans') b.loadVlans(t);
  for (const t of tabs) if (t.kind === 'networks') b.loadNetworks(t);
  for (const t of tabs) if (t.kind === 'addresses') b.loadAddresses(t);
  b.finish();
  b.stats.files = Object.fromEntries(tabs.map((t) => [t.name, t.kind]));
  const skipped = read.filter((f) => !(kinds[f.name] || f.kind)).map((f) => f.name);
  if (skipped.length) b.warnings.push(`skipped (no recognised columns): ${skipped.join(', ')}`);
  return b.toGraph();
}
