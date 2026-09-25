#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
efficientip2cypher — turn EfficientIP SOLIDserver IPAM exports (networks,
addresses, VLANs — as CSV from the GUI "Export" or JSON from the REST API)
into Cypher that loads them into the Open CMDB Graph Neo4j model (README
section 1 / ontology/cmdb.yaml).

Mapping summary (model labels/relationships are reused 1:1; anything marked
"enrichment" is an extra label or relationship type that lives next to them
and is dropped by --strict):

  SOLIDserver                              -> Neo4j
  ------------------------------------------------------------------------------
  network / subnet row                     -> (:Subnet {cidr, name, gateway, description, status, space, location})
                                              MERGE by cidr (unique constraint), refreshed on every run
  Space                                    -> (:IPSpace) enrichment, (Subnet)-[:IN_SPACE]->(IPSpace); also Subnet.space
  Location / Site                          -> (:Location:Datacenter) MERGE by id, ON CREATE only
                                              (Subnet)-[:LOCATED_IN]->(Location)   (enrichment use of LOCATED_IN)
  VLAN / VLAN ID (network or VLAN export)  -> (:VLAN {vlanId, name}) (Subnet)-[:IN_VLAN]->(VLAN)
  network nested in a larger network       -> (child:Subnet)-[:PART_OF]->(parent:Subnet) enrichment (block -> subnet)
  address row                              -> (:IPAddress {address, version, type, allocation, hostname, mac, device, ...})
                                              MERGE by address (unique constraint), (IPAddress)-[:IN_SUBNET]->(Subnet)
                                              free addresses are skipped unless --include-free
  address with a name / device, --link-servers
                                           -> MATCH existing (:Server) by hostname or ipAddress (never created),
                                              MERGE (Server)-[:HAS_INTERFACE]->(:NetworkInterface)-[:HAS_IP]->(IPAddress)

Every generated node (except a pre-existing Location that is reused) carries
origin:'efficientip', importedAt and sourceFile; --purge removes the IPAM part
of a previous import (subnets, VLANs, IP spaces, IP addresses and the
interfaces this tool created) before reloading.

No third-party dependency is needed to generate Cypher. --load needs the
`neo4j` Python driver.
"""
from __future__ import annotations

import argparse
import csv
import io
import ipaddress
import json
import math
import os
import re
import sys
from collections import Counter, OrderedDict, defaultdict
from datetime import datetime, timezone

ORIGIN = "efficientip"
ENRICHMENT_LABELS = {"IPSpace"}
ENRICHMENT_RELS = {"IN_SPACE", "PART_OF"}
FREE_STATUSES = {"free", "libre", "available", "unassigned", ""}

# canonical key -> normalized header names (GUI export labels and REST API field names alike)
NETWORK_COLUMNS = {
    "space": ["space", "spacename", "sitename", "siteid", "ipspace", "vrf"],
    "network": ["network", "networkaddress", "startaddress", "starthostaddr", "subnet", "subnetaddress",
                "subnetstartaddress", "start"],
    "netmask": ["netmask", "prefix", "prefixlength", "prefixlen", "mask", "cidr", "subnetsize", "size"],
    "end": ["endaddress", "endhostaddr", "end"],
    "status": ["status", "state", "networkstatus", "subnetstatus"],
    "name": ["name", "networkname", "subnetname"],
    "description": ["description", "comment", "subnetdescription", "networkdescription"],
    "gateway": ["gateway", "gatewayaddress", "subnetgateway", "gw"],
    "location": ["location", "site", "building", "datacenter", "dc"],
    "vlan_id": ["vlanid", "vlmvlanvlanid", "vlannumber", "vlantag"],
    "vlan_name": ["vlan", "vlanname", "vlmvlanname"],
    "vlan_domain": ["vlandomain", "vlmdomainname"],
    "terminal": ["isterminal", "terminal", "subnetisterminal"],
    "parent": ["parentnetwork", "parentsubnetname", "parent"],
    "class": ["class", "subnetclassname", "networkclass"],
    "id": ["subnetid", "networkid", "id"],
}
ADDRESS_COLUMNS = {
    "space": ["space", "spacename", "sitename", "ipspace", "vrf"],
    "address": ["address", "ipaddress", "ip", "hostaddr", "hostaddress"],
    "network": ["network", "networkaddress", "subnet", "starthostaddr", "subnetstartaddress"],
    "netmask": ["netmask", "prefix", "prefixlength", "mask", "subnetsize", "size"],
    "subnet_name": ["subnetname", "networkname"],
    "name": ["name", "hostname", "fqdn", "shortname", "ipname"],
    "mac": ["macaddress", "mac", "macaddr"],
    "status": ["status", "state", "type", "iptype"],
    "device": ["device", "devicename", "hostdevname"],
    "interface": ["interface", "port", "portname", "hostifacename", "ifname"],
    "description": ["description", "comment", "ipdescription"],
    "domain": ["domain", "dnsdomain", "domainname"],
    "alias": ["alias", "aliases", "ipalias"],
    "class": ["class", "ipclassname"],
    "id": ["ipid", "id"],
}
VLAN_COLUMNS = {
    "vlan_id": ["vlanid", "vlmvlanvlanid", "vlannumber", "vlantag", "id", "number"],
    "vlan_name": ["name", "vlan", "vlanname", "vlmvlanname"],
    "vlan_domain": ["domain", "vlandomain", "vlmdomainname"],
    "description": ["description", "comment"],
}
TAB_COLUMNS = {"networks": NETWORK_COLUMNS, "addresses": ADDRESS_COLUMNS, "vlans": VLAN_COLUMNS}


# ----------------------------------------------------------------------------- helpers
def slug(s) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(s)).strip("-").lower()
    return re.sub(r"-{2,}", "-", s) or "x"


def norm_header(h) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(h or "").lower().replace("#", "num"))


def cy_str(s) -> str:
    s = str(s).replace("\\", "\\\\").replace("'", "\\'").replace("\r", "").replace("\n", "\\n").replace("\t", "\\t")
    return f"'{s}'"


class CypherExpr:
    """Raw Cypher expression (e.g. datetime('...'))."""
    def __init__(self, text: str):
        self.text = text


def cy_val(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(cy_val(x) for x in v) + "]"
    if isinstance(v, dict):
        return cy_map(v)
    if isinstance(v, CypherExpr):
        return v.text
    if isinstance(v, datetime):
        return f"datetime({cy_str(v.strftime('%Y-%m-%dT%H:%M:%S') + ('Z' if v.tzinfo else ''))})"
    return cy_str(v)


def cy_key(k: str) -> str:
    return k if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k) else "`" + k.replace("`", "``") + "`"


def cy_map(d: dict) -> str:
    items = [(k, v) for k, v in d.items() if v is not None and v != [] and v != ""]
    return "{" + ", ".join(f"{cy_key(k)}: {cy_val(v)}" for k, v in items) + "}"


def chunks(seq, n):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def clean(v):
    if v is None:
        return None
    s = str(v).strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in "\"'":
        s = s[1:-1].strip()
    return None if s == "" or s.upper() in ("#N/A", "N/A", "NULL", "NONE", "-") else s


def to_int(v):
    try:
        return int(float(str(v).replace(",", ".")))
    except (TypeError, ValueError):
        return None


def prefix_length(netmask, version=4):
    """'24' / '/24' / '255.255.255.0' / a SOLIDserver subnet_size ('256') -> prefix length, or None."""
    s = clean(netmask)
    if s is None:
        return None
    s = s.lstrip("/")
    if "." in s or ":" in s:
        try:
            return ipaddress.ip_network(f"0.0.0.0/{s}" if "." in s else f"::/{s}", strict=False).prefixlen
        except ValueError:
            return None
    n = to_int(s)
    if n is None:
        return None
    max_len = 32 if version == 4 else 128
    if 0 <= n <= max_len:
        return n
    if n > max_len and (n & (n - 1)) == 0:          # power of two: it is an address count
        return max_len - int(math.log2(n))
    return None


def to_network(address, netmask):
    a = clean(address)
    if a is None:
        return None
    if "/" in a:
        try:
            return ipaddress.ip_network(a, strict=False)
        except ValueError:
            return None
    try:
        ip = ipaddress.ip_address(a)
    except ValueError:
        return None
    plen = prefix_length(netmask, ip.version)
    if plen is None:
        return None
    try:
        return ipaddress.ip_network(f"{a}/{plen}", strict=False)
    except ValueError:
        return None


def ip_kind(ip):
    return "private" if (ip.is_private or ip.is_link_local or ip.is_loopback) else "public"


# ----------------------------------------------------------------------------- readers
def read_csv_file(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    for enc in ("utf-8-sig", "utf-16", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows, header = [], None
    for rec in csv.reader(io.StringIO(text), dialect):
        if header is None:
            if not any(x.strip() for x in rec):
                continue
            header = [h.strip() for h in rec]
            continue
        rows.append({header[i]: v for i, v in enumerate(rec) if i < len(header) and v != ""})
    return rows


def read_json_file(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict):
        for key in ("data", "result", "results", "items", "rows"):
            if isinstance(data.get(key), list):
                data = data[key]
                break
        else:
            data = [data]
    return [{k: v for k, v in r.items()} for r in data if isinstance(r, dict)]


def read_inputs(paths):
    files = OrderedDict()
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if name.lower().endswith((".csv", ".json")):
                    files[os.path.join(p, name)] = None
        else:
            files[p] = None
    for f in files:
        files[f] = read_json_file(f) if f.lower().endswith(".json") else read_csv_file(f)
    return files


class Tab:
    def __init__(self, kind, name, rows):
        self.kind, self.name, self.rows = kind, name, rows
        self.headers = list(OrderedDict.fromkeys(h for r in rows for h in r))
        by_norm = {}
        for h in self.headers:
            by_norm.setdefault(norm_header(h), h)
        self.col = {}
        for key, aliases in TAB_COLUMNS[kind].items():
            for a in aliases:
                if a in by_norm:
                    self.col[key] = by_norm[a]
                    break

    def get(self, row, key):
        h = self.col.get(key)
        return clean(row.get(h)) if h else None


def detect_kind(rows):
    headers = {norm_header(h) for r in rows for h in r}
    if headers & set(ADDRESS_COLUMNS["address"]):
        return "addresses"
    if headers & set(NETWORK_COLUMNS["network"]):
        return "networks"
    if headers & {"vlanid", "vlmvlanvlanid", "vlannumber", "vlantag", "vlmvlanname"}:
        return "vlans"
    return None


# ----------------------------------------------------------------------------- graph builder
class GraphBuilder:
    def __init__(self, args, source_file):
        self.args = args
        self.strict = args.strict
        self.batch = args.batch_size
        self.source_file = source_file
        self.imported_at = datetime.now(timezone.utc).replace(microsecond=0)
        self.nodes: "OrderedDict[str, dict]" = OrderedDict()
        self.rels: "OrderedDict[tuple, dict]" = OrderedDict()
        self.label_of: dict[str, str] = {}
        self.stats = Counter()
        self.warnings: list[str] = []
        self.subnets: dict[str, tuple] = {}          # subnet id -> (ip_network, space)
        self.server_links: list[dict] = []           # rows for the --link-servers statement

    def add_node(self, label, nid, props, mode="refresh", merge_key="id"):
        if self.strict and label.split(":")[0] in ENRICHMENT_LABELS:
            return None
        props = {"id": nid, **{k: v for k, v in props.items() if v is not None and v != ""}}
        if nid in self.nodes:
            self.nodes[nid]["props"].update(props)
        else:
            self.nodes[nid] = {"label": label, "merge_key": merge_key, "props": props, "mode": mode}
            self.label_of[nid] = label
        return nid

    def add_rel(self, s, t, rtype, props=None):
        if self.strict and rtype in ENRICHMENT_RELS:
            return
        if not s or not t or s == t or s not in self.nodes or t not in self.nodes:
            return
        key = (s, t, rtype)
        if key in self.rels:
            if props:
                self.rels[key].update({k: v for k, v in props.items() if v is not None})
        else:
            self.rels[key] = {k: v for k, v in (props or {}).items() if v is not None}

    # --- reference / enrichment nodes
    def location(self, raw):
        if raw is None or self.args.no_locations:
            return None
        nid = f"loc-dc-{slug(raw)}"
        return self.add_node("Location:Datacenter", nid, {"name": str(raw), "type": "Datacenter"}, mode="create")

    def space(self, raw):
        if raw is None:
            return None
        return self.add_node("IPSpace", f"ipspace-{slug(raw)}", {"name": str(raw)})

    def vlan(self, vlan_id, name=None, domain=None, description=None):
        vid = to_int(vlan_id)
        if vid is None and name is None:
            return None
        if vid is None:
            m = re.search(r"\d+", name)
            vid = int(m.group(0)) if m else None
            if vid is None:
                return None
        nid = f"vlan-{slug(domain)}-{vid}" if domain and self.args.vlan_domains else f"vlan-{vid}"
        if nid in self.nodes and not name:
            name = self.nodes[nid]["props"].get("name")
        return self.add_node("VLAN", nid, {"name": name or f"VLAN {vid}", "vlanId": vid, "description": description,
                                           "vlanDomain": domain})

    # --- networks
    def load_networks(self, tab: Tab):
        wanted_space = self.args.space.lower() if self.args.space else None
        for row in tab.rows:
            space = tab.get(row, "space")
            if wanted_space and (space or "").lower() != wanted_space:
                self.stats["networks_other_space"] += 1
                continue
            net = to_network(tab.get(row, "network"), tab.get(row, "netmask"))
            if net is None:
                end = tab.get(row, "end")
                start = tab.get(row, "network")
                if start and end:
                    try:
                        nets = list(ipaddress.summarize_address_range(ipaddress.ip_address(start), ipaddress.ip_address(end)))
                        net = nets[0] if len(nets) == 1 else None
                    except ValueError:
                        net = None
            if net is None:
                self.warnings.append(f"{tab.name}: cannot read network from {tab.get(row, 'network')!r}/{tab.get(row, 'netmask')!r}")
                continue
            cidr = str(net)
            nid = f"subnet-{slug(cidr)}"
            if nid in self.nodes and self.subnets.get(nid, (None, None))[1] != space:
                self.warnings.append(f"{cidr} exists in spaces {self.subnets[nid][1]!r} and {space!r}: Subnet.cidr is unique, "
                                     f"keeping the first (use --space to pick one)")
                continue
            status = (tab.get(row, "status") or "").lower() or None
            name = tab.get(row, "name") or cidr
            terminal = tab.get(row, "terminal")
            props = {
                "name": name, "cidr": cidr, "gateway": tab.get(row, "gateway"), "description": tab.get(row, "description"),
                "status": status, "space": space, "location": tab.get(row, "location"),
                "version": f"v{net.version}", "prefixLength": net.prefixlen,
                "addressCount": net.num_addresses if net.num_addresses < 2 ** 63 else None,   # Neo4j integers are 64-bit
                "networkClass": tab.get(row, "class"), "sourceId": tab.get(row, "id"),
                "terminal": (terminal.lower() in ("1", "true", "yes")) if terminal is not None else None,
                "parentNetwork": tab.get(row, "parent"),
            }
            self.add_node("Subnet", nid, props, merge_key="cidr")
            self.subnets[nid] = (net, space)
            sid = self.space(space)
            if sid:
                self.add_rel(nid, sid, "IN_SPACE")
            loc = self.location(tab.get(row, "location"))
            if loc:
                self.add_rel(nid, loc, "LOCATED_IN")
            vid = self.vlan(tab.get(row, "vlan_id"), tab.get(row, "vlan_name"), tab.get(row, "vlan_domain"))
            if vid:
                self.add_rel(nid, vid, "IN_VLAN")
            self.stats["networks"] += 1

    # --- vlans
    def load_vlans(self, tab: Tab):
        for row in tab.rows:
            if self.vlan(tab.get(row, "vlan_id"), tab.get(row, "vlan_name"), tab.get(row, "vlan_domain"),
                         tab.get(row, "description")):
                self.stats["vlans"] += 1

    # --- addresses
    def find_subnet(self, ip, space=None, hint=None):
        """Longest-prefix match among loaded subnets (same space first)."""
        if hint is not None and hint in self.subnets:
            return hint
        best, best_len = None, -1
        for nid, (net, sp) in self.subnets.items():
            if net.version == ip.version and ip in net and net.prefixlen > best_len and (space is None or sp in (None, space)):
                best, best_len = nid, net.prefixlen
        return best

    def load_addresses(self, tab: Tab):
        wanted_space = self.args.space.lower() if self.args.space else None
        for row in tab.rows:
            space = tab.get(row, "space")
            if wanted_space and (space or "").lower() != wanted_space:
                self.stats["addresses_other_space"] += 1
                continue
            raw = tab.get(row, "address")
            try:
                ip = ipaddress.ip_address(raw.split("/")[0]) if raw else None
            except ValueError:
                ip = None
            if ip is None:
                self.warnings.append(f"{tab.name}: invalid address {raw!r}")
                continue
            status = (tab.get(row, "status") or "").lower()
            name, device = tab.get(row, "name"), tab.get(row, "device")
            if status in FREE_STATUSES and not (name or device or tab.get(row, "mac")) and not self.args.include_free:
                self.stats["addresses_free_skipped"] += 1
                continue
            hint_net = to_network(tab.get(row, "network"), tab.get(row, "netmask"))
            hint = f"subnet-{slug(str(hint_net))}" if hint_net else None
            if hint and hint not in self.subnets:
                # the address export names a network the network export did not contain: create a bare Subnet for it
                self.add_node("Subnet", hint, {"name": tab.get(row, "subnet_name") or str(hint_net), "cidr": str(hint_net),
                                               "space": space, "version": f"v{hint_net.version}",
                                               "prefixLength": hint_net.prefixlen}, merge_key="cidr")
                self.subnets[hint] = (hint_net, space)
                sid = self.space(space)
                if sid:
                    self.add_rel(hint, sid, "IN_SPACE")
            subnet_id = self.find_subnet(ip, space, hint)
            mac = tab.get(row, "mac")
            domain = tab.get(row, "domain")
            hostname = name
            if hostname and domain and "." not in hostname:
                hostname = f"{hostname}.{domain}"
            ip_id = f"ip-{slug(str(ip))}"
            props = {
                "address": str(ip), "version": f"v{ip.version}", "type": ip_kind(ip),
                "allocation": "dhcp" if "dhcp" in status else "static",
                "status": status or None, "hostname": hostname, "mac": mac.lower() if mac else None,
                "device": device, "interface": tab.get(row, "interface"), "description": tab.get(row, "description"),
                "alias": tab.get(row, "alias"), "space": space, "ipClass": tab.get(row, "class"), "sourceId": tab.get(row, "id"),
            }
            self.add_node("IPAddress", ip_id, props, merge_key="address")
            if subnet_id:
                self.add_rel(ip_id, subnet_id, "IN_SUBNET")
            else:
                self.stats["addresses_without_subnet"] += 1
            if self.args.link_servers and (name or device):
                names = {n.split(".")[0].lower() for n in (name, device) if n}
                self.server_links.append({"ip": ip_id, "address": str(ip), "names": sorted(names),
                                          "nic": tab.get(row, "interface") or "eth0", "mac": mac.lower() if mac else None})
            self.stats["addresses"] += 1

    # --- second pass
    def finish(self):
        # nesting: every subnet points to the smallest larger subnet that contains it (block -> subnet hierarchy)
        items = sorted(self.subnets.items(), key=lambda kv: kv[1][0].prefixlen)
        for nid, (net, space) in items:
            parent, plen = None, -1
            for pid, (pnet, pspace) in items:
                if pid != nid and pnet.version == net.version and pnet.prefixlen < net.prefixlen and pnet.prefixlen > plen \
                        and pspace == space and net.subnet_of(pnet):
                    parent, plen = pid, pnet.prefixlen
            if parent:
                self.add_rel(nid, parent, "PART_OF")
        for n in self.nodes.values():
            n["props"].setdefault("origin", ORIGIN)
            n["props"].setdefault("importedAt", self.imported_at)
            n["props"].setdefault("sourceFile", self.source_file)

    # --- output
    def statements(self, purge=False, schema=False):
        out = []
        if schema and not self.strict:
            out.append("// ---- schema for enrichment labels (model labels are covered by cypher/01_constraints_and_indexes.cypher)")
            for label in sorted(ENRICHMENT_LABELS):
                out.append(f"CREATE CONSTRAINT {label.lower()}_id_unique IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE;")
            out.append("CREATE INDEX ipaddress_origin_idx IF NOT EXISTS FOR (n:IPAddress) ON (n.origin);")
        if purge:
            labels = ["Subnet", "VLAN", "IPAddress", "NetworkInterface"] + ([] if self.strict else sorted(ENRICHMENT_LABELS))
            out.append("// ---- remove the IPAM part of a previous efficientip import (locations and servers are kept)")
            out.append("MATCH (n) WHERE n.origin = 'efficientip' AND (" + " OR ".join(f"n:{l}" for l in labels) + ")\n"
                       "DETACH DELETE n;")
            out.append("MATCH ()-[r]->() WHERE r.origin = 'efficientip' DELETE r;")

        by_label = defaultdict(list)
        for nid, n in self.nodes.items():
            by_label[(n["label"], n["merge_key"], n["mode"])].append(n["props"])
        for (label, key, mode), rows in sorted(by_label.items(), key=lambda kv: (kv[0][2] != "create", kv[0][0])):
            out.append(f"// ---- {label} ({len(rows)}, {'created only if missing' if mode == 'create' else 'refreshed'})")
            for batch in chunks(rows, self.batch):
                body = ",\n  ".join(cy_map(r) for r in batch)
                if mode == "create":
                    out.append(f"UNWIND [\n  {body}\n] AS row\nMERGE (n:{label} {{{key}: row.{key}}})\nON CREATE SET n += row;")
                elif key == "id":
                    out.append(f"UNWIND [\n  {body}\n] AS row\nMERGE (n:{label} {{id: row.id}})\nSET n += row;")
                else:
                    out.append(f"UNWIND [\n  {body}\n] AS row\nMERGE (n:{label} {{{key}: row.{key}}})\n"
                               f"ON CREATE SET n.id = row.id\nSET n += row;")

        by_rel = defaultdict(list)
        for (s, t, rtype), props in self.rels.items():
            by_rel[(self.label_of[s], self.label_of[t], rtype)].append({"s": s, "t": t, "p": props})
        for (ls, lt, rtype), rows in by_rel.items():
            out.append(f"// ---- ({ls})-[:{rtype}]->({lt}) ({len(rows)})")
            for batch in chunks(rows, self.batch):
                body = ",\n  ".join(cy_map({"s": r["s"], "t": r["t"], "p": r["p"] or None}) for r in batch)
                out.append(f"UNWIND [\n  {body}\n] AS row\n"
                           f"MATCH (s:{ls.split(':')[0]} {{id: row.s}}), (t:{lt.split(':')[0]} {{id: row.t}})\n"
                           f"MERGE (s)-[r:{rtype}]->(t)\n"
                           f"SET r += coalesce(row.p, {{}}), r.origin = {cy_str(ORIGIN)};")

        if self.server_links:
            out.append(f"// ---- link IP addresses to existing Servers by hostname / ipAddress ({len(self.server_links)} candidates; "
                       f"servers are matched, never created)")
            for batch in chunks(self.server_links, self.batch):
                body = ",\n  ".join(cy_map(r) for r in batch)
                out.append(
                    f"UNWIND [\n  {body}\n] AS row\n"
                    f"MATCH (ip:IPAddress {{id: row.ip}})\n"
                    f"MATCH (s:Server)\n"
                    f"WHERE s.ipAddress = row.address OR toLower(split(coalesce(s.hostname, ''), '.')[0]) IN row.names\n"
                    f"MERGE (nic:NetworkInterface {{id: 'nic-' + s.id + '-' + row.nic}})\n"
                    f"ON CREATE SET nic.name = row.nic, nic.type = 'data', nic.origin = {cy_str(ORIGIN)}, "
                    f"nic.importedAt = {cy_val(self.imported_at)}, nic.sourceFile = {cy_str(self.source_file)}\n"
                    f"SET nic.mac = coalesce(row.mac, nic.mac)\n"
                    f"MERGE (s)-[r1:HAS_INTERFACE]->(nic) SET r1.origin = {cy_str(ORIGIN)}\n"
                    f"MERGE (nic)-[r2:HAS_IP]->(ip) SET r2.origin = {cy_str(ORIGIN)};")
        return out

    def summary(self):
        return {"nodes": dict(Counter(n["label"] for n in self.nodes.values())),
                "relationships": dict(Counter(r for (_, _, r) in self.rels)),
                "serverLinkCandidates": len(self.server_links),
                "input": dict(self.stats), "warnings": self.warnings}


# ----------------------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(prog="efficientip2cypher", description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="Examples:\n"
                                        "  efficientip2cypher.py networks.csv addresses.csv -o ipam.cypher --schema --purge\n"
                                        "  efficientip2cypher.py ./solidserver_exports --space 'headquarter C' --link-servers -o ipam.cypher\n"
                                        "  efficientip2cypher.py networks.csv --load --password secret --schema --purge")
    ap.add_argument("inputs", nargs="+", help="SOLIDserver CSV/JSON exports (networks, addresses, VLANs) or a directory of them")
    ap.add_argument("--kind", action="append", default=[], metavar="FILE=KIND",
                    help="force a file to be read as networks, addresses or vlans (repeatable; default: detected from its columns)")
    ap.add_argument("--space", help="only import this IP space (SOLIDserver 'Space' / API site_name)")
    ap.add_argument("--include-free", action="store_true", help="also import free/unassigned addresses")
    ap.add_argument("--link-servers", action="store_true",
                    help="append a statement linking imported addresses to existing Server nodes (by hostname or ipAddress) through a NetworkInterface")
    ap.add_argument("--vlan-domains", action="store_true", help="key VLAN ids by VLAN domain too (vlan-<domain>-<id>) when the export has one")
    ap.add_argument("--no-locations", action="store_true", help="do not create Location:Datacenter nodes from the Location/Site column")
    ap.add_argument("--strict", action="store_true", help="emit only model labels/relationships (drop IPSpace, IN_SPACE, PART_OF)")
    ap.add_argument("--schema", action="store_true", help="prepend constraints for the enrichment labels")
    ap.add_argument("--purge", action="store_true", help="prepend statements deleting the IPAM part of a previous efficientip import")
    ap.add_argument("--batch-size", type=int, default=500, help="rows per UNWIND statement (default: 500)")
    ap.add_argument("-o", "--output", help="write Cypher to this file (default: stdout)")
    ap.add_argument("--summary", action="store_true", help="print a JSON summary of generated nodes/relationships to stderr")
    ap.add_argument("--load", action="store_true", help="also execute the statements against Neo4j (needs the neo4j driver)")
    ap.add_argument("--uri", default=os.environ.get("NEO4J_URI", "neo4j://localhost:7687"))
    ap.add_argument("--user", default=os.environ.get("NEO4J_USER", "neo4j"))
    ap.add_argument("--password", default=os.environ.get("NEO4J_PASSWORD"))
    ap.add_argument("--database", default=os.environ.get("NEO4J_DATABASE", "neo4j"))
    args = ap.parse_args(argv)

    for p in args.inputs:
        if not os.path.exists(p):
            ap.error(f"input not found: {p}")
    forced = {}
    for item in args.kind:
        if "=" not in item:
            ap.error("--kind expects FILE=KIND")
        f, k = item.rsplit("=", 1)
        if k not in TAB_COLUMNS:
            ap.error(f"--kind: unknown kind {k!r} (expected one of {', '.join(TAB_COLUMNS)})")
        forced[os.path.normcase(os.path.abspath(f))] = k
        forced[os.path.basename(f)] = k

    files = read_inputs(args.inputs)
    tabs = []
    for path, rows in files.items():
        kind = forced.get(os.path.normcase(os.path.abspath(path))) or forced.get(os.path.basename(path)) or detect_kind(rows)
        if not kind:
            sys.stderr.write(f"skipping {path}: no network / address / VLAN columns recognised (use --kind)\n")
            continue
        tabs.append(Tab(kind, os.path.basename(path), rows))
    if not tabs:
        ap.error("nothing to import")

    b = GraphBuilder(args, ", ".join(t.name for t in tabs))
    for t in tabs:
        if t.kind == "vlans":
            b.load_vlans(t)
    for t in tabs:
        if t.kind == "networks":
            b.load_networks(t)
    for t in tabs:
        if t.kind == "addresses":
            b.load_addresses(t)
    b.finish()
    b.stats["files"] = {t.name: t.kind for t in tabs}

    stmts = b.statements(purge=args.purge, schema=args.schema)
    header = (f"// Generated by efficientip2cypher from {', '.join(os.path.abspath(p) for p in args.inputs)}\n"
              f"// Files: {', '.join(f'{t.name} -> {t.kind}' for t in tabs)}\n"
              f"// Idempotent (MERGE on cidr / address / id); rerun with --purge to drop entries that disappeared from the export.\n")
    text = header + "\n\n".join(stmts) + "\n"
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)

    if args.summary or args.output:
        sys.stderr.write(json.dumps(b.summary(), indent=2, ensure_ascii=False, default=str) + "\n")

    if args.load:
        try:
            from neo4j import GraphDatabase
        except ImportError:
            sys.exit("--load needs the neo4j Python driver: pip install neo4j")
        if not args.password:
            sys.exit("--load needs --password (or NEO4J_PASSWORD)")
        with GraphDatabase.driver(args.uri, auth=(args.user, args.password)) as driver:
            driver.verify_connectivity()
            with driver.session(database=args.database) as session:
                n = 0
                for stmt in stmts:
                    for single in [s.strip() for s in stmt.split(";\n") if s.strip()]:
                        body = "\n".join(l for l in single.splitlines() if not l.strip().startswith("//")).strip().rstrip(";")
                        if body:
                            session.run(body).consume()
                            n += 1
                sys.stderr.write(f"loaded {n} statements into {args.database} at {args.uri}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
