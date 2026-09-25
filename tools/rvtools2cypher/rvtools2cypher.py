#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
rvtools2cypher — turn an RVTools export (VMware vSphere inventory, .xlsx or
the per-tab .csv files) into Cypher that loads it into the Open CMDB Graph
Neo4j model (README section 1 / ontology/cmdb.yaml).

Mapping summary (model labels/relationships are reused 1:1; anything marked
"enrichment" is an extra label or relationship type that lives next to them
and is dropped by --strict):

  RVTools                                  -> Neo4j
  ------------------------------------------------------------------------------
  vInfo row (one per VM / template)        -> (:Server:Virtual) MERGE by id, refreshed on every run
                                              status: poweredOn -> active, poweredOff/template -> maintenance
                                              (--powered-off-status), template:true on templates
  vInfo Host                               -> (:Server:Physical) (VM)-[:HOSTED_ON]->(host)
  vHost row (when the tab is present)      -> the same (:Server:Physical) with vendor/model/serial/CPU/RAM/ESXi version
  vInfo/vHost Datacenter, or a site tag    -> (:Location:Datacenter) MERGE by id, ON CREATE only
                                              (host)-[:LOCATED_IN]->, (VM)-[:LOCATED_IN]-> when the VM carries its own value
  vInfo/vHost Cluster (or vCluster tab)    -> (:Cluster) enrichment, (host)-[:IN_CLUSTER]->, (VM)-[:IN_CLUSTER]->
  vDatastore row, or the "[ds] .../x.vmx"  -> (:Datastore) enrichment, (VM)-[:USES_DATASTORE]->, (host)-[:MOUNTS]-> (vDatastore Hosts)
    prefix of the VM path
  vNetwork row (when the tab is present)   -> (:NetworkInterface) (VM)-[:HAS_INTERFACE]->, (:IPAddress) -[:HAS_IP]->
  application tag / custom attribute       -> (:Application) MERGE by id, ON CREATE only; (app)-[:DEPLOYED_ON]->(VM)
  application-domain tag                   -> (:BusinessDomain) MERGE by name; (app)-[:IN_BUSINESS_DOMAIN]->
  environment tag                          -> Server.environment + (VM)-[:IN_ENVIRONMENT]->(:Environment) (one of the 5
                                              canonical environments, see --env-map); (app)-[:IN_ENVIRONMENT]-> for each
                                              environment its VMs run in
  every other vInfo_tags_* / custom column -> tag_<name> property on the VM (--tag-columns / --no-tags)

Every generated node (except a pre-existing Application / BusinessDomain /
Environment / Location that is reused) carries origin:'rvtools',
importedAt:<datetime> and sourceFile:<file name>; --purge removes the
inventory part of a previous import (servers, interfaces, IPs, clusters,
datastores and their relationships) before reloading, and keeps the reference
nodes (applications, domains, environments, locations).

No third-party dependency is needed to generate Cypher (the .xlsx is read
with the standard library). --load needs the `neo4j` Python driver.
"""
from __future__ import annotations

import argparse
import csv
import io
import ipaddress
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, OrderedDict, defaultdict
from datetime import datetime, timedelta, timezone

ORIGIN = "rvtools"
ENRICHMENT_LABELS = {"Cluster", "Datastore"}
ENVIRONMENTS = OrderedDict([
    ("production", "env-production"),
    ("pre-production", "env-preproduction"),
    ("qualification", "env-qualification"),
    ("development", "env-development"),
    ("other", "env-other"),
])
# raw tag value (upper-cased, spaces/underscores stripped) -> canonical environment
DEFAULT_ENV_MAP = {
    "P": "production", "PROD": "production", "PRD": "production", "PRODUCTION": "production",
    "X": "production", "XAVERIF": "production", "EXPLOITATION": "production",
    "PP": "pre-production", "PREPROD": "pre-production", "PREPRODUCTION": "pre-production",
    "STAGING": "pre-production", "STG": "pre-production", "PRE": "pre-production",
    "Q": "qualification", "QUAL": "qualification", "QUALIFICATION": "qualification", "QA": "qualification",
    "UAT": "qualification", "R": "qualification", "RECETTE": "qualification", "T": "qualification",
    "TEST": "qualification", "TST": "qualification", "INT": "qualification", "INTEGRATION": "qualification",
    "D": "development", "DEV": "development", "DEVELOPMENT": "development", "DEVELOPPEMENT": "development",
    "S": "other", "SANDBOX": "other", "LAB": "other", "O": "other", "OTHER": "other",
}
EXCEL_EPOCH = datetime(1899, 12, 30)
DATE_NUMFMT_IDS = set(range(14, 23)) | set(range(45, 48))

# --- column aliases: canonical key -> normalized header names (see norm_header)
# Both RVTools' "pretty" headers (VM, Powerstate, Primary IP Address ...) and its
# internal names as exported by older versions / the "vInfo..." prefixed layout
# (vInfoVMName, vInfoPowerstate ...) are covered.
VINFO_COLUMNS = {
    "vm": ["vm", "vmname", "name"],
    "powerstate": ["powerstate"],
    "template": ["template"],
    "srm": ["srmplaceholder"],
    "config_status": ["configstatus"],
    "dns_name": ["dnsname", "guesthostname", "hostname"],
    "connection_state": ["connectionstate"],
    "guest_state": ["gueststate"],
    "heartbeat": ["heartbeat"],
    "boot_time": ["poweron", "boottime"],
    "create_date": ["creationdate", "createdate"],
    "change_version": ["changeversion"],
    "cpus": ["cpus"],
    "memory": ["memory"],
    "nics": ["nics"],
    "disks": ["disks"],
    "disk_capacity": ["totaldiskcapacitymib", "totaldiskcapacity"],
    "primary_ip": ["primaryipaddress"],
    "resource_pool": ["resourcepool"],
    "folder": ["folder"],
    "vapp": ["vapp"],
    "provisioned": ["provisionedmib", "provisioned"],
    "in_use": ["inusemib", "inuse"],
    "firmware": ["firmware"],
    "hw_version": ["hwversion", "version"],
    "path": ["path"],
    "annotation": ["annotation"],
    "datacenter": ["datacenter"],
    "cluster": ["cluster"],
    "host": ["host"],
    "os_config": ["osaccordingtotheconfigurationfile", "os"],
    "os_tools": ["osaccordingtothevmwaretools", "ostools"],
    "vm_id": ["vmid"],
    "vm_uuid": ["vmuuid", "uuid"],
    "vcenter": ["visdkserver"],
    "ha_restart_priority": ["harestartpriority"],
    "latency_sensitivity": ["latencysensitivity"],
}
VHOST_COLUMNS = {
    "host": ["host", "name", "hostname"],
    "datacenter": ["datacenter"],
    "cluster": ["cluster"],
    "config_status": ["configstatus"],
    "cpu_model": ["cpumodel"],
    "num_cpu": ["numcpu", "cpu"],
    "cores_per_cpu": ["corespercpu"],
    "num_cores": ["numcores", "cores"],
    "memory": ["nummemory", "memory", "memorymib"],
    "num_vms": ["numvms", "vms"],
    "esx_version": ["esxversion"],
    "boot_time": ["boottime"],
    "domain": ["domain"],
    "vendor": ["vendor"],
    "model": ["model"],
    "serial": ["serialnumber"],
    "service_tag": ["servicetag"],
    "bios_version": ["biosversion"],
    "uuid": ["uuid"],
    "object_id": ["objectid"],
    "vcenter": ["visdkserver"],
}
VCLUSTER_COLUMNS = {
    "name": ["name", "cluster", "clustername"],
    "config_status": ["configstatus"],
    "overall_status": ["overallstatus"],
    "num_hosts": ["numhosts", "hosts"],
    "total_cpu": ["totalcpu"],
    "num_cores": ["numcpucores"],
    "total_memory": ["totalmemory"],
    "ha_enabled": ["haenabled"],
    "drs_enabled": ["drsenabled"],
    "vcenter": ["visdkserver"],
}
VDATASTORE_COLUMNS = {
    "name": ["name", "datastore", "datastorename"],
    "config_status": ["configstatus"],
    "type": ["type"],
    "num_vms": ["numvms", "vms"],
    "num_hosts": ["numhosts"],
    "capacity": ["capacitymib", "capacity"],
    "provisioned": ["provisionedmib", "provisioned"],
    "in_use": ["inusemib", "inuse"],
    "free": ["freemib", "free"],
    "hosts": ["hosts"],
    "url": ["url"],
    "vcenter": ["visdkserver"],
}
VNETWORK_COLUMNS = {
    "vm": ["vm", "vmname"],
    "adapter": ["adapter"],
    "network": ["network"],
    "switch": ["switch"],
    "connected": ["connected"],
    "mac": ["macaddress", "mac"],
    "mac_type": ["mactype"],
    "type": ["type"],
    "ipv4": ["ipv4address"],
    "ipv6": ["ipv6address"],
}
TAB_PREFIXES = ("vinfo", "vhost", "vcluster", "vdatastore", "vnetwork", "vcpu", "vmemory", "vdisk", "vpartition",
                "vsnapshot", "vtools", "vsource", "vrp", "vnic", "vswitch", "vport", "dvswitch", "dvport", "vhba",
                "vmultipath", "vhealth", "vlicense", "vfilelist", "vmetadata")
TAB_SIGNATURES = OrderedDict([
    # a sheet is recognised by the presence of these canonical columns (a tuple entry = any of them);
    # checked in this order because vNetwork/vCPU/vMemory also carry VM + Powerstate + Host columns
    ("vNetwork", ("vm", "adapter", "mac")),
    ("vHost", ("host", "esx_version", "vendor")),
    ("vCluster", ("name", "ha_enabled", "drs_enabled")),
    ("vDatastore", ("name", "capacity", "free")),
    ("vInfo", ("vm", "powerstate", ("disk_capacity", "primary_ip", "folder", "path"))),
])
TAB_COLUMNS = {"vInfo": VINFO_COLUMNS, "vHost": VHOST_COLUMNS, "vCluster": VCLUSTER_COLUMNS,
               "vDatastore": VDATASTORE_COLUMNS, "vNetwork": VNETWORK_COLUMNS}


# ----------------------------------------------------------------------------- helpers
def slug(s) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(s)).strip("-").lower()
    return re.sub(r"-{2,}", "-", s) or "x"


def norm_header(h) -> str:
    """'vInfo_tags_SITE' -> 'tags_site' is handled by tag_name(); here 'Primary IP Address' -> 'primaryipaddress',
    'vInfoPrimaryIPAddress' -> 'primaryipaddress', '# CPU' -> 'numcpu'."""
    n = re.sub(r"[^a-z0-9]+", "", str(h or "").lower().replace("#", "num"))
    for p in TAB_PREFIXES:
        if n.startswith(p) and len(n) > len(p):
            n = n[len(p):]
            break
    return n


def tag_name(h):
    """Header of a vSphere tag / custom attribute column -> tag name, or None."""
    m = re.match(r"^\s*(?:v\w+?)?_?tags?[_ ]+(.+)$", str(h or ""), re.I)
    return m.group(1).strip() if m else None


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


def cy_map(d: dict) -> str:
    items = [(k, v) for k, v in d.items() if v is not None and v != [] and v != ""]
    return "{" + ", ".join(f"{cy_key(k)}: {cy_val(v)}" for k, v in items) + "}"


def cy_key(k: str) -> str:
    return k if re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", k) else "`" + k.replace("`", "``") + "`"


def chunks(seq, n):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def to_int(v):
    if v is None or v == "":
        return None
    try:
        f = float(str(v).replace(",", "."))
    except ValueError:
        return None
    return int(round(f))


def to_float(v, digits=2):
    if v is None or v == "":
        return None
    try:
        return round(float(str(v).replace(",", ".")), digits)
    except ValueError:
        return None


def to_bool(v):
    if isinstance(v, bool):
        return v
    s = str(v or "").strip().lower()
    if s in ("true", "yes", "1", "on"):
        return True
    if s in ("false", "no", "0", "off"):
        return False
    return None


def mib_to_gb(v):
    i = to_int(v)
    return round(i / 1024, 1) if i is not None else None


def to_datetime(v):
    """Excel serial number, ISO-ish or RVTools 'yyyy/mm/dd hh:mm:ss' text -> datetime (naive), or None."""
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v
    s = str(v).strip()
    try:
        f = float(s)
        if 60 < f < 2958466:      # Excel serial date range (1900-03-01 .. 9999-12-31)
            dt = (EXCEL_EPOCH + timedelta(days=f, microseconds=500000)).replace(microsecond=0)   # nearest second
            return dt if dt.year > 1970 else None   # 1970-01-01 = vSphere "unknown"
        return None
    except ValueError:
        pass
    for fmt in ("%Y/%m/%d %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%d/%m/%Y %H:%M:%S",
                "%m/%d/%Y %H:%M:%S", "%Y/%m/%d %H:%M", "%Y-%m-%d %H:%M", "%d/%m/%Y %H:%M", "%m/%d/%Y %H:%M",
                "%Y/%m/%d", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            dt = datetime.strptime(s[:19] if "T" in fmt else s, fmt)
            return dt if dt.year > 1970 else None
        except ValueError:
            continue
    return None


def clean(v):
    """Cell -> stripped string or None; Excel error values (#N/A, #REF!) count as empty."""
    if v is None:
        return None
    s = str(v).strip()
    if s == "" or s.upper() in ("#N/A", "#REF!", "#VALUE!", "#NAME?", "#DIV/0!", "N/A", "NULL"):
        return None
    return s


def short_host(h):
    return str(h).split(".")[0].lower()


# ----------------------------------------------------------------------------- xlsx / csv readers (stdlib only)
def _xlsx_col_index(ref):
    letters = re.match(r"[A-Z]+", ref).group(0)
    n = 0
    for ch in letters:
        n = n * 26 + ord(ch) - 64
    return n


def read_xlsx(path):
    """Return OrderedDict sheet name -> list of row dicts (header -> cell value as str / datetime)."""
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
          "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}
    T = "{%s}t" % ns["m"]
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        shared = []
        if "xl/sharedStrings.xml" in names:
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter("{%s}si" % ns["m"]):
                shared.append("".join(t.text or "" for t in si.iter(T)))
        date_styles = set()
        if "xl/styles.xml" in names:
            st = ET.fromstring(z.read("xl/styles.xml"))
            custom = {}
            nf = st.find("m:numFmts", ns)
            if nf is not None:
                for f in nf.findall("m:numFmt", ns):
                    custom[int(f.get("numFmtId"))] = f.get("formatCode") or ""
            xfs = st.find("m:cellXfs", ns)
            if xfs is not None:
                for i, xf in enumerate(xfs.findall("m:xf", ns)):
                    fid = int(xf.get("numFmtId") or 0)
                    if fid in DATE_NUMFMT_IDS:
                        date_styles.add(str(i))
                    elif fid in custom:
                        code = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", custom[fid]).lower()
                        if re.search(r"[ymdh]", code) and "#" not in code and "0" not in code:
                            date_styles.add(str(i))
        wb = ET.fromstring(z.read("xl/workbook.xml"))
        rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
        rel_target = {r.get("Id"): r.get("Target") for r in rels}
        sheets = OrderedDict()
        for s in wb.find("m:sheets", ns):
            target = rel_target.get(s.get("{%s}id" % ns["r"]), "")
            member = target.lstrip("/") if target.startswith("/") else "xl/" + target
            if member not in names:
                continue
            root = ET.fromstring(z.read(member))
            sd = root.find("m:sheetData", ns)
            rows = []
            if sd is None:
                sheets[s.get("name")] = rows
                continue
            header = None
            for row in sd.findall("m:row", ns):
                cells = {}
                for c in row.findall("m:c", ns):
                    ref = c.get("r") or ""
                    idx = _xlsx_col_index(ref) if ref else len(cells) + 1
                    t = c.get("t")
                    val = None
                    if t == "inlineStr":
                        is_el = c.find("m:is", ns)
                        val = "".join(x.text or "" for x in is_el.iter(T)) if is_el is not None else None
                    else:
                        v = c.find("m:v", ns)
                        if v is not None and v.text is not None:
                            if t == "s":
                                val = shared[int(v.text)]
                            elif t == "b":
                                val = "True" if v.text == "1" else "False"
                            elif t in ("str", "e"):
                                val = v.text
                            else:
                                val = v.text
                                if c.get("s") in date_styles:
                                    dt = to_datetime(val)
                                    val = dt if dt else val
                    if val is not None and val != "":
                        cells[idx] = val
                if header is None:
                    if not cells:
                        continue
                    header = {i: str(v).strip() for i, v in cells.items()}
                    continue
                rows.append({header[i]: v for i, v in cells.items() if i in header})
            sheets[s.get("name")] = rows
    return sheets


def read_csv_file(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    for enc in ("utf-8-sig", "utf-16", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.reader(io.StringIO(text), dialect)
    rows, header = [], None
    for rec in reader:
        if header is None:
            if not any(x.strip() for x in rec):
                continue
            header = [h.strip() for h in rec]
            continue
        rows.append({header[i]: v for i, v in enumerate(rec) if i < len(header) and v != ""})
    return rows


def read_inputs(paths):
    """Return OrderedDict sheet/tab name -> rows for one .xlsx, .csv files, or a directory of RVTools_tab*.csv."""
    sheets = OrderedDict()
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if name.lower().endswith(".csv"):
                    sheets[os.path.splitext(name)[0]] = read_csv_file(os.path.join(p, name))
        elif p.lower().endswith((".xlsx", ".xlsm")):
            for name, rows in read_xlsx(p).items():
                sheets[name] = rows
        elif p.lower().endswith(".csv"):
            sheets[os.path.splitext(os.path.basename(p))[0]] = read_csv_file(p)
        else:
            raise SystemExit(f"unsupported input {p!r}: expected .xlsx, .csv or a directory of RVTools csv files")
    return sheets


# ----------------------------------------------------------------------------- tab detection
class Tab:
    """A recognised RVTools tab: rows exposed through canonical column keys plus the raw headers."""
    def __init__(self, kind, sheet_name, rows):
        self.kind = kind
        self.sheet_name = sheet_name
        self.rows = rows
        self.headers = list(OrderedDict.fromkeys(h for r in rows for h in r))
        self.col = {}                                   # canonical key -> header
        by_norm = {}
        for h in self.headers:
            by_norm.setdefault(norm_header(h), h)
        for key, aliases in TAB_COLUMNS[kind].items():
            for a in aliases:
                if a in by_norm:
                    self.col[key] = by_norm[a]
                    break

    def get(self, row, key):
        h = self.col.get(key)
        return clean(row.get(h)) if h else None

    def raw(self, row, key):
        h = self.col.get(key)
        return row.get(h) if h else None


def detect_tabs(sheets, forced=None):
    """sheet name -> Tab. `forced` maps a sheet name to a tab kind (--sheet NAME=vInfo)."""
    tabs = OrderedDict()
    for name, rows in sheets.items():
        if not rows:
            continue
        kind = (forced or {}).get(name)
        if not kind:
            headers = {norm_header(h) for r in rows for h in r}

            def has(c, cols):
                return any(a in headers for a in cols[c])

            for k, sig in TAB_SIGNATURES.items():
                cols = TAB_COLUMNS[k]
                if all((any(has(c, cols) for c in alt) if isinstance(alt, tuple) else has(alt, cols)) for alt in sig):
                    kind = k
                    break
        if kind:
            tabs[name] = Tab(kind, name, rows)
    return tabs


def pick_tabs(tabs):
    """kind -> Tab; when several sheets look alike, prefer the one named after the tab (vInfo, RVTools_tabvInfo...)."""
    kinds = {}
    for name, t in tabs.items():
        n = re.sub(r"[^a-z]", "", name.lower()).replace("rvtoolstab", "")
        if t.kind not in kinds or n == t.kind.lower():
            kinds[t.kind] = t
    return kinds


# ----------------------------------------------------------------------------- graph builder
class GraphBuilder:
    def __init__(self, args, source_file):
        self.args = args
        self.strict = args.strict
        self.batch = args.batch_size
        self.source_file = source_file
        self.imported_at = datetime.now(timezone.utc).replace(microsecond=0)
        self.nodes: "OrderedDict[str, dict]" = OrderedDict()   # id -> {label, merge_key, props, mode}
        self.rels: "OrderedDict[tuple, dict]" = OrderedDict()  # (s, t, type) -> props
        self.label_of: dict[str, str] = {}
        self.stats = Counter()
        self.warnings: list[str] = []
        self.env_map = dict(DEFAULT_ENV_MAP)
        for item in (args.env_map or []):
            for pair in item.split(","):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    v = v.strip().lower()
                    if v not in ENVIRONMENTS:
                        raise SystemExit(f"--env-map: {v!r} is not one of {', '.join(ENVIRONMENTS)}")
                    self.env_map[re.sub(r"[^A-Z0-9]", "", k.strip().upper())] = v
        self.vm_ids: dict[str, str] = {}          # VM name (as in RVTools) -> node id
        self.host_ids: dict[str, str] = {}        # host short name -> node id
        self.host_sites: dict[str, Counter] = defaultdict(Counter)
        self.app_envs: dict[str, set] = defaultdict(set)
        self.ds_hosts: dict[str, str] = {}        # datastore id -> raw Hosts cell

    # --- primitives
    def add_node(self, label, nid, props, mode="refresh", merge_key="id"):
        """mode 'refresh': SET n += props on every run (inventory); 'create': ON CREATE only (reference data)."""
        if self.strict and label.split(":")[0] in ENRICHMENT_LABELS:
            return None
        base = {"id": nid}
        props = {**base, **{k: v for k, v in props.items() if v is not None and v != ""}}
        if nid in self.nodes:
            self.nodes[nid]["props"].update(props)
        else:
            self.nodes[nid] = {"label": label, "merge_key": merge_key, "props": props, "mode": mode}
            self.label_of[nid] = label
        return nid

    def add_rel(self, s, t, rtype, props=None):
        if not s or not t or s == t or s not in self.nodes or t not in self.nodes:
            return
        key = (s, t, rtype)
        if key in self.rels:
            if props:
                self.rels[key].update({k: v for k, v in props.items() if v is not None})
        else:
            self.rels[key] = {k: v for k, v in (props or {}).items() if v is not None}

    # --- reference nodes
    def environment(self, raw):
        """Raw environment tag -> (canonical name, node id); creates the Environment node on first use."""
        if raw is None:
            return None, None
        key = re.sub(r"[^A-Z0-9]", "", str(raw).upper())
        canon = self.env_map.get(key)
        if canon is None:
            self.stats["unmapped_environment:" + str(raw)] += 1
            canon = "other"
        nid = ENVIRONMENTS[canon]
        self.add_node("Environment", nid, {"name": canon, "description": canon.capitalize()}, mode="create",
                      merge_key="name")
        return canon, nid

    def location(self, raw):
        if raw is None:
            return None
        nid = f"loc-dc-{slug(raw)}"
        self.add_node("Location:Datacenter", nid, {"name": str(raw), "type": "Datacenter",
                                                    "provider": self.args.provider}, mode="create")
        return nid

    def domain(self, raw):
        if raw is None:
            return None
        nid = f"bd-{slug(raw)}"
        self.add_node("BusinessDomain", nid, {"name": str(raw)}, mode="create", merge_key="name")
        return nid

    def application(self, raw, domain_raw):
        if raw is None:
            return None
        nid = f"app-{slug(raw)}"
        self.add_node("Application", nid, {"name": str(raw), "businessService": domain_raw,
                                           "criticality": self.args.default_criticality}, mode="create")
        did = self.domain(domain_raw)
        if did:
            self.add_rel(nid, did, "IN_BUSINESS_DOMAIN")
        return nid

    def cluster(self, raw, props=None):
        if raw is None:
            return None
        nid = f"cluster-{slug(raw)}"
        return self.add_node("Cluster", nid, {"name": str(raw), "type": "vSphere cluster", **(props or {})})

    def datastore(self, raw, props=None):
        if raw is None:
            return None
        nid = f"ds-{slug(raw)}"
        return self.add_node("Datastore", nid, {"name": str(raw), **(props or {})})

    def host(self, raw, props=None, site=None, cluster=None):
        if raw is None:
            return None
        key = short_host(raw)
        nid = self.host_ids.get(key)
        if not nid:
            nid = f"srv-phy-{slug(raw)}"
            self.host_ids[key] = nid
        base = {"hostname": str(raw).lower(), "os": "VMware ESXi", "status": "active", "hypervisor": "VMware ESXi",
                "serverType": "hypervisor"}
        self.add_node("Server:Physical", nid, {**base, **(props or {})})
        if site:
            self.host_sites[nid][site] += 1
        if cluster:
            cid = self.cluster(cluster)
            self.nodes[nid]["props"]["cluster"] = str(cluster)
            self.add_rel(nid, cid, "IN_CLUSTER")
        return nid

    # --- column picking for the "business" tags
    def _pick_column(self, tab, option, candidates):
        """Explicit --xxx-column header, else the first tag/custom column whose name matches a candidate."""
        if option:
            for h in tab.headers:
                if h.strip().lower() == option.strip().lower():
                    return h
            self.warnings.append(f"column {option!r} not found in sheet {tab.sheet_name!r}")
            return None
        for h in tab.headers:
            t = tag_name(h) or h
            if re.sub(r"[^a-z0-9]", "", t.lower()) in candidates:
                return h
        return None

    # --- vInfo
    def load_vinfo(self, tab: Tab):
        a = self.args
        app_col = self._pick_column(tab, a.app_column, {"applicationname", "application", "app", "appname"})
        dom_col = self._pick_column(tab, a.domain_column, {"applicationdomain", "domain", "businessdomain"})
        env_col = self._pick_column(tab, a.env_column, {"environment", "env", "environnement"})
        site_col = self._pick_column(tab, a.site_column, {"site", "location", "datacenter", "dc"})
        if not site_col and "datacenter" in tab.col:
            site_col = tab.col["datacenter"]
        consumed = {h for h in (app_col, dom_col, env_col, site_col) if h}
        if env_col and not any(re.sub(r"[^A-Z0-9]", "", k.upper()) == "P" for item in (a.env_map or []) for k in
                               [pair.split("=", 1)[0] for pair in item.split(",") if "=" in pair]):
            codes = {re.sub(r"[^A-Z0-9]", "", str(clean(r.get(env_col)) or "").upper()) for r in tab.rows}
            if "X" in codes and "P" in codes:
                # French "X = eXploitation (production), P = Pré-production" convention: only when both codes coexist
                self.env_map["P"] = "pre-production"
                self.env_map["PAVERIF"] = "pre-production"
        self.stats["environment_map"] = {k: v for k, v in sorted(self.env_map.items()) if len(k) <= 2 or k.endswith("AVERIF")}
        tag_cols = []
        if not a.no_tags:
            wanted = {c.strip().lower() for c in a.tag_columns} if a.tag_columns else None
            for h in tab.headers:
                if h in consumed:
                    continue
                if wanted is not None:
                    if h.strip().lower() in wanted:
                        tag_cols.append((h, re.sub(r"[^A-Za-z0-9]+", "_", h).strip("_")))
                elif tag_name(h):
                    tag_cols.append((h, re.sub(r"[^A-Za-z0-9]+", "_", tag_name(h)).strip("_")))
        self.stats["vInfo_columns"] = {"application": app_col, "domain": dom_col, "environment": env_col,
                                       "site": site_col, "tags": [h for h, _ in tag_cols]}
        seen_ids = {}
        for row in tab.rows:
            name = tab.get(row, "vm")
            if not name:
                self.stats["vInfo_rows_skipped_no_name"] += 1
                continue
            is_template = to_bool(tab.get(row, "template")) is True
            if is_template and a.skip_templates:
                self.stats["vInfo_templates_skipped"] += 1
                continue
            power = tab.get(row, "powerstate") or ""
            if power.lower() == "poweredoff" and a.skip_powered_off:
                self.stats["vInfo_powered_off_skipped"] += 1
                continue
            nid = f"vm-{slug(name)}"
            if nid in seen_ids and seen_ids[nid] != name:
                suffix = slug(tab.get(row, "vm_id") or tab.get(row, "vm_uuid") or str(len(seen_ids)))
                nid = f"{nid}-{suffix}"
            elif nid in seen_ids:
                self.warnings.append(f"duplicate VM name {name!r}: rows merged into {nid}")
            seen_ids[nid] = name
            self.vm_ids[name] = nid

            env_raw = clean(row.get(env_col)) if env_col else None
            env_name, env_id = self.environment(env_raw)
            site_raw = clean(row.get(site_col)) if site_col else None
            dc_raw = tab.get(row, "datacenter")
            host_raw = tab.get(row, "host")
            cluster_raw = tab.get(row, "cluster")
            os_tools, os_cfg = tab.get(row, "os_tools"), tab.get(row, "os_config")
            status = "active" if power.lower() == "poweredon" and not is_template else a.powered_off_status
            cpus = to_int(tab.get(row, "cpus"))
            props = {
                "hostname": (tab.get(row, "dns_name") or name),
                "name": name,
                "ipAddress": tab.get(row, "primary_ip"),
                "os": os_tools or os_cfg,
                "osConfigured": os_cfg if os_tools and os_cfg != os_tools else None,
                "status": status,
                "environment": env_name,
                "environmentCode": env_raw if env_raw and env_raw.lower() != env_name else None,
                "cpuCores": cpus, "vCpu": cpus,
                "ramGB": mib_to_gb(tab.get(row, "memory")),
                "diskGB": mib_to_gb(tab.get(row, "disk_capacity")),
                "provisionedGB": mib_to_gb(tab.get(row, "provisioned")),
                "inUseGB": mib_to_gb(tab.get(row, "in_use")),
                "hypervisor": "VMware ESXi",
                "powerState": power or None,
                "guestState": tab.get(row, "guest_state"),
                "connectionState": tab.get(row, "connection_state"),
                "configStatus": tab.get(row, "config_status"),
                "heartbeat": tab.get(row, "heartbeat"),
                "template": is_template,
                "srmPlaceholder": to_bool(tab.get(row, "srm")),
                "firmware": tab.get(row, "firmware"),
                "hwVersion": tab.get(row, "hw_version"),
                "vmPath": tab.get(row, "path"),
                "folder": tab.get(row, "folder"),
                "resourcePool": tab.get(row, "resource_pool"),
                "vApp": tab.get(row, "vapp"),
                "site": site_raw,
                "datacenter": dc_raw,
                "cluster": cluster_raw,
                "esxHost": host_raw.lower() if host_raw else None,
                "vmId": tab.get(row, "vm_id"),
                "vmUuid": tab.get(row, "vm_uuid"),
                "vCenter": tab.get(row, "vcenter"),
                "haRestartPriority": tab.get(row, "ha_restart_priority"),
                "latencySensitivity": tab.get(row, "latency_sensitivity"),
                "description": tab.get(row, "annotation"),
                "createdAt": to_datetime(tab.raw(row, "create_date")),
                "bootTime": to_datetime(tab.raw(row, "boot_time")),
                "changedAt": to_datetime(tab.raw(row, "change_version")),
            }
            for h, tname in tag_cols:
                v = clean(row.get(h))
                if v is not None:
                    props["tag_" + tname] = v
            self.add_node("Server:Virtual", nid, props)

            if env_id:
                self.add_rel(nid, env_id, "IN_ENVIRONMENT")
            loc_raw = site_raw or dc_raw
            loc_id = self.location(loc_raw)
            if loc_id and not a.no_vm_location:
                self.add_rel(nid, loc_id, "LOCATED_IN")
            hid = self.host(host_raw, site=loc_raw, cluster=cluster_raw)
            if hid:
                self.add_rel(nid, hid, "HOSTED_ON")
            cid = self.cluster(cluster_raw)
            if cid:
                self.add_rel(nid, cid, "IN_CLUSTER")
            path = tab.get(row, "path")
            m = re.match(r"^\[([^\]]+)\]", path or "")
            if m:
                dsid = self.datastore(m.group(1))
                if dsid:
                    self.add_rel(nid, dsid, "USES_DATASTORE")
            app_raw = clean(row.get(app_col)) if app_col else None
            dom_raw = clean(row.get(dom_col)) if dom_col else None
            aid = self.application(app_raw, dom_raw)
            if aid:
                self.add_rel(aid, nid, "DEPLOYED_ON")
                if env_name:
                    self.app_envs[aid].add(env_name)
            elif dom_raw:
                self.domain(dom_raw)   # keep the taxonomy even when the VM has no application tag
            self.stats["vInfo_rows"] += 1

    # --- vHost
    def load_vhost(self, tab: Tab):
        for row in tab.rows:
            name = tab.get(row, "host")
            if not name:
                continue
            cores = to_int(tab.get(row, "num_cores"))
            if cores is None:
                n, cpc = to_int(tab.get(row, "num_cpu")), to_int(tab.get(row, "cores_per_cpu"))
                cores = n * cpc if n and cpc else None
            esx = tab.get(row, "esx_version")
            props = {
                "osVersion": re.sub(r"^VMware ESXi\s*", "", esx, flags=re.I) if esx else None,
                "cpuCores": cores, "cpuSockets": to_int(tab.get(row, "num_cpu")), "cpuModel": tab.get(row, "cpu_model"),
                "ramGB": mib_to_gb(tab.get(row, "memory")),
                "vendor": tab.get(row, "vendor"), "model": tab.get(row, "model"),
                "serialNumber": tab.get(row, "serial") or tab.get(row, "service_tag"),
                "serviceTag": tab.get(row, "service_tag"), "biosVersion": tab.get(row, "bios_version"),
                "domain": tab.get(row, "domain"), "uuid": tab.get(row, "uuid"), "objectId": tab.get(row, "object_id"),
                "vCenter": tab.get(row, "vcenter"), "configStatus": tab.get(row, "config_status"),
                "vmCount": to_int(tab.get(row, "num_vms")), "bootTime": to_datetime(tab.raw(row, "boot_time")),
                "datacenter": tab.get(row, "datacenter"),
            }
            dc = tab.get(row, "datacenter")
            hid = self.host(name, props, cluster=tab.get(row, "cluster"))
            if dc:
                loc_id = self.location(dc)
                self.add_rel(hid, loc_id, "LOCATED_IN")
                self.host_sites[hid] = Counter()            # authoritative: no majority vote needed
            self.stats["vHost_rows"] += 1

    # --- vCluster
    def load_vcluster(self, tab: Tab):
        for row in tab.rows:
            name = tab.get(row, "name")
            if not name:
                continue
            self.cluster(name, {
                "configStatus": tab.get(row, "config_status"), "overallStatus": tab.get(row, "overall_status"),
                "hostCount": to_int(tab.get(row, "num_hosts")), "totalCpuMHz": to_int(tab.get(row, "total_cpu")),
                "cpuCores": to_int(tab.get(row, "num_cores")), "ramGB": mib_to_gb(tab.get(row, "total_memory")),
                "haEnabled": to_bool(tab.get(row, "ha_enabled")), "drsEnabled": to_bool(tab.get(row, "drs_enabled")),
                "vCenter": tab.get(row, "vcenter"),
            })
            self.stats["vCluster_rows"] += 1

    # --- vDatastore
    def load_vdatastore(self, tab: Tab):
        for row in tab.rows:
            name = tab.get(row, "name")
            if not name:
                continue
            dsid = self.datastore(name, {
                "type": tab.get(row, "type"), "configStatus": tab.get(row, "config_status"),
                "capacityGB": mib_to_gb(tab.get(row, "capacity")), "provisionedGB": mib_to_gb(tab.get(row, "provisioned")),
                "inUseGB": mib_to_gb(tab.get(row, "in_use")), "freeGB": mib_to_gb(tab.get(row, "free")),
                "vmCount": to_int(tab.get(row, "num_vms")), "url": tab.get(row, "url"), "vCenter": tab.get(row, "vcenter"),
            })
            hosts = tab.get(row, "hosts")
            if dsid and hosts:
                self.ds_hosts[dsid] = hosts
            self.stats["vDatastore_rows"] += 1

    # --- vNetwork
    def load_vnetwork(self, tab: Tab):
        for row in tab.rows:
            vm = tab.get(row, "vm")
            vid = self.vm_ids.get(vm) if vm else None
            if not vid:
                self.stats["vNetwork_rows_unknown_vm"] += 1
                continue
            adapter = tab.get(row, "adapter") or "nic"
            mac = tab.get(row, "mac")
            nic_id = f"nic-{vid[3:]}-{slug(adapter)}"
            self.add_node("NetworkInterface", nic_id, {
                "name": adapter, "type": "data", "mac": mac.lower() if mac else None, "macType": tab.get(row, "mac_type"),
                "adapterType": tab.get(row, "type"), "network": tab.get(row, "network"), "switch": tab.get(row, "switch"),
                "connected": to_bool(tab.get(row, "connected")),
            })
            self.add_rel(vid, nic_id, "HAS_INTERFACE")
            for key in ("ipv4", "ipv6"):
                for addr in re.split(r"[,\s;]+", tab.get(row, key) or ""):
                    addr = addr.strip()
                    if not addr:
                        continue
                    try:
                        ip = ipaddress.ip_address(addr)
                    except ValueError:
                        self.warnings.append(f"vNetwork: invalid IP {addr!r} on {vm}")
                        continue
                    ip_id = f"ip-{slug(addr)}"
                    self.add_node("IPAddress", ip_id, {
                        "address": addr, "version": f"v{ip.version}",
                        "type": "private" if ip.is_private else "public",
                    })
                    self.add_rel(nic_id, ip_id, "HAS_IP")
            self.stats["vNetwork_rows"] += 1

    # --- second pass
    def finish(self):
        # hosts without an authoritative datacenter: majority vote of their VMs' site
        for hid, votes in self.host_sites.items():
            if votes:
                site = votes.most_common(1)[0][0]
                loc_id = self.location(site)
                self.add_rel(hid, loc_id, "LOCATED_IN")
                self.nodes[hid]["props"].setdefault("datacenter", site)
        # datastore -> hosts (vDatastore "Hosts" column is a "/"- or ","-separated list of host names)
        for dsid, hosts in self.ds_hosts.items():
            for h in re.split(r"[,;/|\s]+", hosts):
                hid = self.host_ids.get(short_host(h)) if h else None
                if hid:
                    self.add_rel(hid, dsid, "MOUNTS")
        # applications: IN_ENVIRONMENT for each environment their VMs run in, flat property when unambiguous
        for aid, envs in self.app_envs.items():
            for e in envs:
                self.add_rel(aid, ENVIRONMENTS[e], "IN_ENVIRONMENT")
            if len(envs) == 1:
                self.nodes[aid]["props"]["environment"] = next(iter(envs))
        # provenance
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
            out.append("CREATE INDEX server_origin_idx IF NOT EXISTS FOR (n:Server) ON (n.origin);")
        if purge:
            labels = ["Server", "NetworkInterface", "IPAddress"] + ([] if self.strict else sorted(ENRICHMENT_LABELS))
            out.append("// ---- remove the inventory part of a previous rvtools import (applications, domains, environments and locations are kept)")
            out.append("MATCH (n) WHERE n.origin = 'rvtools' AND (" + " OR ".join(f"n:{l}" for l in labels) + ")\n"
                       "DETACH DELETE n;")
            out.append("MATCH ()-[r]->() WHERE r.origin = 'rvtools' DELETE r;")

        by_label = defaultdict(list)
        for nid, n in self.nodes.items():
            by_label[(n["label"], n["merge_key"], n["mode"])].append(n["props"])
        # reference data first so relationships resolve, then inventory
        order = sorted(by_label.items(), key=lambda kv: (kv[0][2] != "create", kv[0][0]))
        for (label, key, mode), rows in order:
            out.append(f"// ---- {label} ({len(rows)}, {'created only if missing' if mode == 'create' else 'refreshed'})")
            for batch in chunks(rows, self.batch):
                body = ",\n  ".join(cy_map(r) for r in batch)
                if mode == "create":
                    out.append(f"UNWIND [\n  {body}\n] AS row\nMERGE (n:{label} {{{key}: row.{key}}})\n"
                               f"ON CREATE SET n += row;")
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
                out.append(
                    f"UNWIND [\n  {body}\n] AS row\n"
                    f"MATCH (s:{ls.split(':')[0]} {{id: row.s}}), (t:{lt.split(':')[0]} {{id: row.t}})\n"
                    f"MERGE (s)-[r:{rtype}]->(t)\n"
                    f"SET r += coalesce(row.p, {{}}), r.origin = {cy_str(ORIGIN)};")
        return out

    def summary(self):
        labels = Counter(n["label"] for n in self.nodes.values())
        rels = Counter(rtype for (_, _, rtype) in self.rels)
        return {"nodes": dict(labels), "relationships": dict(rels),
                "input": {k: v for k, v in self.stats.items()}, "warnings": self.warnings}


# ----------------------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(prog="rvtools2cypher", description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="Examples:\n"
                                        "  rvtools2cypher.py RVTools_export.xlsx -o vsphere.cypher --schema --purge\n"
                                        "  rvtools2cypher.py ./rvtools_csv_dir --app-column ApplicationName --env-map X=production,S=other\n"
                                        "  rvtools2cypher.py RVTools_export.xlsx --load --password secret --schema --purge")
    ap.add_argument("inputs", nargs="+", help="RVTools .xlsx export, one or more RVTools_tab*.csv files, or a directory of them")
    ap.add_argument("--sheet", action="append", default=[], metavar="NAME=KIND",
                    help="force a sheet/csv name to be read as vInfo, vHost, vCluster, vDatastore or vNetwork (repeatable)")
    ap.add_argument("--app-column", help="vInfo column holding the application name (default: a tag/custom attribute named ApplicationName/Application)")
    ap.add_argument("--domain-column", help="vInfo column holding the business domain (default: ApplicationDomain/Domain)")
    ap.add_argument("--env-column", help="vInfo column holding the environment (default: Environment/Env)")
    ap.add_argument("--site-column", help="vInfo column holding the site/datacenter (default: SITE/Location tag, then the Datacenter column)")
    ap.add_argument("--env-map", action="append", metavar="CODE=ENV,...",
                    help="map raw environment values to production/pre-production/qualification/development/other "
                         "(repeatable; defaults cover P/X/PROD, PP/PREPROD/STAGING, Q/QA/UAT/TEST, D/DEV, S/SANDBOX)")
    ap.add_argument("--tag-columns", nargs="*", metavar="HEADER",
                    help="extra vInfo columns to keep as tag_<name> properties (default: every vInfo_tags_* column)")
    ap.add_argument("--no-tags", action="store_true", help="do not copy tag columns onto the VM nodes")
    ap.add_argument("--provider", default="VMware vSphere", help="Location.provider for datacenters created by this import")
    ap.add_argument("--default-criticality", default="medium", choices=["low", "medium", "high", "critical"],
                    help="Application.criticality for applications created by this import (default: medium)")
    ap.add_argument("--powered-off-status", default="maintenance", choices=["active", "maintenance", "decommissioned"],
                    help="Server.status for powered-off VMs (default: maintenance)")
    ap.add_argument("--no-vm-location", action="store_true",
                    help="do not link VMs to their site/datacenter with LOCATED_IN (hosts are always linked)")
    ap.add_argument("--skip-templates", action="store_true", help="ignore VM templates")
    ap.add_argument("--skip-powered-off", action="store_true", help="ignore powered-off VMs")
    ap.add_argument("--strict", action="store_true", help="emit only model labels (drop Cluster and Datastore nodes; the names stay as properties)")
    ap.add_argument("--schema", action="store_true", help="prepend constraints for the enrichment labels")
    ap.add_argument("--purge", action="store_true", help="prepend statements deleting the inventory of a previous rvtools import")
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
    for item in args.sheet:
        if "=" not in item:
            ap.error("--sheet expects NAME=KIND")
        name, kind = item.rsplit("=", 1)
        if kind not in TAB_COLUMNS:
            ap.error(f"--sheet: unknown kind {kind!r} (expected one of {', '.join(TAB_COLUMNS)})")
        forced[name] = kind

    sheets = read_inputs(args.inputs)
    tabs = detect_tabs(sheets, forced)
    kinds = pick_tabs(tabs)
    if "vInfo" not in kinds:
        ap.error("no vInfo sheet found (a sheet with VM / Powerstate / Host columns); sheets seen: "
                 + ", ".join(f"{n!r} ({len(r)} rows)" for n, r in sheets.items()) + " — use --sheet NAME=vInfo")

    source_file = ", ".join(os.path.basename(p.rstrip("/\\")) for p in args.inputs)
    b = GraphBuilder(args, source_file)
    if "vCluster" in kinds:
        b.load_vcluster(kinds["vCluster"])
    if "vDatastore" in kinds:
        b.load_vdatastore(kinds["vDatastore"])
    if "vHost" in kinds:
        b.load_vhost(kinds["vHost"])
    b.load_vinfo(kinds["vInfo"])
    if "vNetwork" in kinds:
        b.load_vnetwork(kinds["vNetwork"])
    b.finish()
    b.stats["sheets"] = {name: t.kind for name, t in tabs.items()}

    stmts = b.statements(purge=args.purge, schema=args.schema)
    header = (f"// Generated by rvtools2cypher from {', '.join(os.path.abspath(p) for p in args.inputs)}\n"
              f"// Sheets: {', '.join(f'{n} -> {t.kind}' for n, t in tabs.items())}\n"
              f"// Idempotent (MERGE on id); rerun with --purge to drop servers that disappeared from the export.\n")
    text = header + "\n\n".join(stmts) + "\n"
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)

    summ = b.summary()
    if args.summary or args.output:
        sys.stderr.write(json.dumps(summ, indent=2, ensure_ascii=False, default=str) + "\n")

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
                        if not body:
                            continue
                        session.run(body).consume()
                        n += 1
                sys.stderr.write(f"loaded {n} statements into {args.database} at {args.uri}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
