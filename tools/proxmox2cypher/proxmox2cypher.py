#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
proxmox2cypher — turn Proxmox VE API output (JSON from `pvesh get ... --output-format json`
or the REST API) into Cypher that loads it into the Open CMDB Graph Neo4j model
(README section 1 / ontology/cmdb.yaml).

Inputs are JSON files (or a directory of them); each is a list, or an object
with a "data" list, of API objects. Recognised objects, wherever they come from:

  /cluster/resources (type=vm/node/storage/pool)   the one call that lists everything
  /nodes                                           node list
  /nodes/<node>/qemu, /nodes/<node>/lxc            guest lists per node
  /nodes/<node>/storage                            storage per node
  /nodes/<node>/qemu/<vmid>/config, .../lxc/.../config
                                                   guest configuration (cores, memory, ostype, netN, ipconfigN,
                                                   disks, tags, description); the vmid comes from the object
                                                   or from digits in the file name (config-100.json)
  /cluster/status                                  cluster name + node list

Mapping summary (model labels/relationships are reused 1:1; anything marked
"enrichment" is an extra label or relationship type that lives next to them
and is dropped by --strict):

  Proxmox                                  -> Neo4j
  ------------------------------------------------------------------------------
  qemu / lxc guest                         -> (:Server:Virtual) MERGE by id, refreshed on every run
                                              status: running -> active, stopped/paused/template -> --stopped-status
  node                                     -> (:Server:Physical {os:'Proxmox VE'}) (guest)-[:HOSTED_ON]->(node)
  cluster (/cluster/status, --cluster)     -> (:Cluster) enrichment, (node)-[:IN_CLUSTER]->, (guest)-[:IN_CLUSTER]->
  storage                                  -> (:Datastore) enrichment, (node)-[:MOUNTS]->, (guest)-[:USES_DATASTORE]->
                                              (from the config's disk entries: scsi0: local-lvm:vm-100-disk-0,...)
  pool                                     -> guest.pool property; with --pool-as-application also
                                              (:Application) MERGE by id ON CREATE only, (app)-[:DEPLOYED_ON]->(guest)
  tags                                     -> guest.tags list; a tag matching an environment code (prod, dev, qa...)
                                              sets Server.environment + (guest)-[:IN_ENVIRONMENT]->(:Environment);
                                              a tag starting with --app-tag-prefix names the (:Application)
  config netN                              -> (:NetworkInterface {mac, bridge, model}) (guest)-[:HAS_INTERFACE]->,
                                              tag=<vlan> -> (:VLAN) enrichment link (nic)-[:IN_VLAN]->
  config ipconfigN / agent IPs             -> (:IPAddress) (nic)-[:HAS_IP]->
  --datacenter NAME                        -> (:Location:Datacenter) MERGE by id ON CREATE only, (node)-[:LOCATED_IN]->

Every generated node (except a pre-existing Application / Environment /
Location that is reused) carries origin:'proxmox', importedAt and
sourceFile; --purge removes the inventory part of a previous import before
reloading and keeps the reference nodes.

No third-party dependency is needed to generate Cypher. --load needs the
`neo4j` Python driver.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import sys
from collections import Counter, OrderedDict, defaultdict
from datetime import datetime, timezone

ORIGIN = "proxmox"
ENRICHMENT_LABELS = {"Cluster", "Datastore"}
ENVIRONMENTS = OrderedDict([
    ("production", "env-production"),
    ("pre-production", "env-preproduction"),
    ("qualification", "env-qualification"),
    ("development", "env-development"),
    ("other", "env-other"),
])
DEFAULT_ENV_MAP = {
    "P": "production", "PROD": "production", "PRD": "production", "PRODUCTION": "production", "X": "production",
    "PP": "pre-production", "PREPROD": "pre-production", "PREPRODUCTION": "pre-production", "STAGING": "pre-production",
    "STG": "pre-production", "STAGE": "pre-production", "PRE": "pre-production",
    "Q": "qualification", "QUAL": "qualification", "QUALIFICATION": "qualification", "QA": "qualification",
    "UAT": "qualification", "TEST": "qualification", "TST": "qualification", "INT": "qualification", "RECETTE": "qualification",
    "D": "development", "DEV": "development", "DEVELOPMENT": "development", "DEVELOPPEMENT": "development",
    "SANDBOX": "other", "LAB": "other", "OTHER": "other",
}
OSTYPE_NAMES = {
    "l24": "Linux 2.4", "l26": "Linux", "solaris": "Solaris", "other": "Other",
    "wxp": "Windows XP", "w2k": "Windows 2000", "w2k3": "Windows Server 2003", "w2k8": "Windows Server 2008",
    "wvista": "Windows Vista", "win7": "Windows 7", "win8": "Windows 8 / Server 2012", "win10": "Windows 10 / Server 2016-2019",
    "win11": "Windows 11 / Server 2022",
}
GIB = 1024 ** 3


# ----------------------------------------------------------------------------- helpers
def slug(s) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(s)).strip("-").lower()
    return re.sub(r"-{2,}", "-", s) or "x"


def cy_str(s) -> str:
    s = str(s).replace("\\", "\\\\").replace("'", "\\'").replace("\r", "").replace("\n", "\\n").replace("\t", "\\t")
    return f"'{s}'"


class CypherExpr:
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


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def to_float(v, digits=2):
    try:
        return round(float(v), digits)
    except (TypeError, ValueError):
        return None


def bytes_to_gb(v):
    i = to_int(v)
    return round(i / GIB, 1) if i is not None else None


def size_to_gb(s):
    """Proxmox disk size strings: '32G', '500M', '2T', '34359738368' (bytes)."""
    if s is None:
        return None
    m = re.match(r"^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)\s*$", str(s), re.I)
    if not m:
        return None
    n, unit = float(m.group(1)), m.group(2).upper()
    factor = {"": 1 / GIB, "K": 1 / 1024 ** 2, "M": 1 / 1024, "G": 1, "T": 1024}[unit]
    return round(n * factor, 1)


def parse_kv(s):
    """'virtio=BC:24:11:AA:BB:CC,bridge=vmbr0,tag=20,firewall=1' -> OrderedDict (first key without '=' kept as 'model=value')."""
    out = OrderedDict()
    for i, part in enumerate(str(s or "").split(",")):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
        else:
            out.setdefault("_positional", []).append(part)
    return out


def split_tags(v):
    """Proxmox tags are ';'-separated (',' tolerated); a tag never contains whitespace, so spaces are kept inside a tag."""
    return [t.strip() for t in re.split(r"[;,]", str(v or "")) if t.strip()]


def epoch_to_datetime(v):
    i = to_int(v)
    return datetime.fromtimestamp(i, tz=timezone.utc).replace(microsecond=0) if i else None


# ----------------------------------------------------------------------------- readers
def read_json_objects(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if isinstance(data, dict) and isinstance(data.get("data"), (list, dict)):
        data = data["data"]
    if isinstance(data, dict):
        data = [data]
    return [d for d in data if isinstance(d, dict)]


def read_inputs(paths):
    files = OrderedDict()
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if name.lower().endswith(".json"):
                    files[os.path.join(p, name)] = read_json_objects(os.path.join(p, name))
        elif p.lower().endswith(".json"):
            files[p] = read_json_objects(p)
        else:
            raise SystemExit(f"unsupported input {p!r}: expected .json files or a directory of them")
    return files


def classify(obj, filename):
    """-> 'vm' | 'node' | 'storage' | 'pool' | 'cluster' | 'config' | None"""
    t = str(obj.get("type") or "").lower()
    if t in ("qemu", "lxc", "vm"):
        return "vm"
    if t == "node":
        return "node"
    if t == "storage":
        return "storage"
    if t == "pool":
        return "pool"
    if t == "cluster":
        return "cluster"
    if t in ("sdn", "openvz"):
        return None
    if "vmid" in obj and ("status" in obj or "name" in obj) and "digest" not in obj:
        return "vm"
    if "digest" in obj or any(re.match(r"^(net|scsi|virtio|ide|sata|ipconfig|rootfs|mp)\d*$", k) for k in obj) or "ostype" in obj:
        return "config"
    if "node" in obj and "storage" in obj and ("total" in obj or "avail" in obj):
        return "storage"
    if "node" in obj and "vmid" not in obj and ("maxcpu" in obj or "uptime" in obj or "level" in obj):
        return "node"
    if "poolid" in obj:
        return "pool"
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
        self.env_map = dict(DEFAULT_ENV_MAP)
        for item in (args.env_map or []):
            for pair in item.split(","):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    v = v.strip().lower()
                    if v not in ENVIRONMENTS:
                        raise SystemExit(f"--env-map: {v!r} is not one of {', '.join(ENVIRONMENTS)}")
                    self.env_map[re.sub(r"[^A-Z0-9]", "", k.strip().upper())] = v
        self.cluster_id = None
        self.vm_by_vmid: dict[int, str] = {}
        self.vm_names = Counter()
        self.configs: dict[int, tuple] = {}         # vmid -> (config dict, node hint)
        self.app_envs: dict[str, set] = defaultdict(set)
        self.storage_shared: dict[str, bool] = {}

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
        if not s or not t or s == t or s not in self.nodes or t not in self.nodes:
            return
        key = (s, t, rtype)
        if key in self.rels:
            if props:
                self.rels[key].update({k: v for k, v in props.items() if v is not None})
        else:
            self.rels[key] = {k: v for k, v in (props or {}).items() if v is not None}

    # --- reference / enrichment nodes
    def environment(self, raw):
        key = re.sub(r"[^A-Z0-9]", "", str(raw).upper())
        canon = self.env_map.get(key)
        if canon is None:
            return None, None
        nid = ENVIRONMENTS[canon]
        self.add_node("Environment", nid, {"name": canon, "description": canon.capitalize()}, mode="create", merge_key="name")
        return canon, nid

    def location(self):
        if not self.args.datacenter:
            return None
        return self.add_node("Location:Datacenter", f"loc-dc-{slug(self.args.datacenter)}",
                             {"name": self.args.datacenter, "type": "Datacenter", "provider": "Proxmox VE"}, mode="create")

    def cluster(self, name, props=None):
        if not name:
            return None
        self.cluster_id = self.add_node("Cluster", f"cluster-{slug(name)}", {"name": name, "type": "Proxmox VE cluster",
                                                                             **(props or {})})
        return self.cluster_id

    def application(self, name):
        if not name:
            return None
        return self.add_node("Application", f"app-{slug(name)}", {"name": name, "criticality": self.args.default_criticality},
                             mode="create")

    def node(self, name, props=None):
        if not name:
            return None
        nid = f"srv-phy-{slug(name)}"
        base = {"hostname": name, "os": "Proxmox VE", "status": "active", "hypervisor": "Proxmox VE", "serverType": "hypervisor"}
        self.add_node("Server:Physical", nid, {**(base if nid not in self.nodes else {}), **(props or {})})
        if self.cluster_id:
            self.add_rel(nid, self.cluster_id, "IN_CLUSTER")
            self.nodes[nid]["props"].setdefault("cluster", self.nodes[self.cluster_id]["props"]["name"])
        loc = self.location()
        if loc:
            self.add_rel(nid, loc, "LOCATED_IN")
        return nid

    def datastore(self, storage, node=None, props=None):
        if not storage:
            return None
        shared = self.storage_shared.get(storage)
        nid = f"ds-{slug(storage)}" if shared or shared is None or not node else f"ds-{slug(node)}-{slug(storage)}"
        return self.add_node("Datastore", nid, {"name": storage, **(props or {})})

    # --- objects
    def load_cluster(self, obj):
        self.cluster(obj.get("name"), {"quorate": bool(obj.get("quorate")) if "quorate" in obj else None,
                                       "nodeCount": to_int(obj.get("nodes")), "version": to_int(obj.get("version"))})
        self.stats["cluster"] += 1

    def load_node(self, obj):
        name = obj.get("node") or obj.get("name")
        status = str(obj.get("status") or "").lower()
        self.node(name, {
            "status": "active" if status in ("online", "", "unknown") else self.args.stopped_status,
            "nodeStatus": status or None, "cpuCores": to_int(obj.get("maxcpu")), "ramGB": bytes_to_gb(obj.get("maxmem")),
            "diskGB": bytes_to_gb(obj.get("maxdisk")), "ramUsedGB": bytes_to_gb(obj.get("mem")),
            "diskUsedGB": bytes_to_gb(obj.get("disk")), "cpuUsagePct": to_float(float(obj["cpu"]) * 100, 1) if obj.get("cpu") is not None else None,
            "uptimeSeconds": to_int(obj.get("uptime")), "subscriptionLevel": obj.get("level") or None,
            "ipAddress": obj.get("ip"), "nodeId": obj.get("id") if str(obj.get("id", "")).startswith("node/") else None,
        })
        self.stats["nodes"] += 1

    def load_storage(self, obj):
        storage = obj.get("storage")
        shared = obj.get("shared")
        if shared is not None:
            self.storage_shared[storage] = bool(to_int(shared))
        node = obj.get("node")
        dsid = self.datastore(storage, node, {
            "type": obj.get("plugintype") or (obj.get("type") if obj.get("type") != "storage" else None),
            "content": obj.get("content"), "shared": bool(to_int(shared)) if shared is not None else None,
            "capacityGB": bytes_to_gb(obj.get("maxdisk") or obj.get("total")), "inUseGB": bytes_to_gb(obj.get("disk") or obj.get("used")),
            "freeGB": bytes_to_gb(obj.get("avail")), "status": obj.get("status"), "enabled": bool(to_int(obj.get("enabled"))) if "enabled" in obj else None,
        })
        if dsid and node:
            self.add_rel(self.node(node), dsid, "MOUNTS")
        self.stats["storages"] += 1

    def load_pool(self, obj):
        # /pools/<poolid> lists members; /cluster/resources type=pool has only poolid
        pool = obj.get("poolid") or obj.get("pool")
        for m in obj.get("members") or []:
            if isinstance(m, dict) and m.get("vmid") is not None:
                vid = self.vm_by_vmid.get(to_int(m["vmid"]))
                if vid:
                    self.nodes[vid]["props"]["pool"] = pool
                    self._pool_app(vid, pool)
        self.stats["pools"] += 1

    def _pool_app(self, vid, pool):
        if self.args.pool_as_application and pool:
            aid = self.application(pool)
            self.add_rel(aid, vid, "DEPLOYED_ON")
            env = self.nodes[vid]["props"].get("environment")
            if env:
                self.app_envs[aid].add(env)

    def load_config(self, obj, filename):
        vmid = to_int(obj.get("vmid"))
        if vmid is None:
            m = re.search(r"(\d+)", os.path.basename(filename))
            vmid = int(m.group(1)) if m else None
        if vmid is None:
            self.warnings.append(f"{filename}: config object without a vmid (put the vmid in the file name, e.g. config-100.json)")
            return
        self.configs[vmid] = (obj, obj.get("node"))
        self.stats["configs"] += 1

    def load_vm(self, obj):
        vmid = to_int(obj.get("vmid"))
        name = obj.get("name") or (f"vm-{vmid}" if vmid is not None else None)
        if name is None:
            return
        vm_type = str(obj.get("type") or ("lxc" if "rootfs" in obj else "qemu")).lower()
        status = str(obj.get("status") or "").lower()
        is_template = bool(to_int(obj.get("template")))
        if is_template and self.args.skip_templates:
            self.stats["templates_skipped"] += 1
            return
        if status != "running" and self.args.skip_stopped:
            self.stats["stopped_skipped"] += 1
            return
        nid = f"vm-{slug(name)}"
        self.vm_names[nid] += 1
        if self.vm_names[nid] > 1 or (nid in self.nodes and self.nodes[nid]["props"].get("vmid") != vmid):
            nid = f"vm-{slug(name)}-{vmid}"
        tags = split_tags(obj.get("tags"))
        env_name, env_id = None, None
        app_name = None
        for t in tags:
            if self.args.app_tag_prefix and t.lower().startswith(self.args.app_tag_prefix.lower()):
                app_name = t[len(self.args.app_tag_prefix):] or None
            elif env_name is None:
                env_name, env_id = self.environment(t)
        props = {
            "hostname": name, "name": name, "vmid": vmid, "vmType": vm_type,
            "status": "active" if status == "running" and not is_template else self.args.stopped_status,
            "powerState": status or None, "template": is_template, "hypervisor": "Proxmox VE",
            "environment": env_name, "cpuCores": to_int(obj.get("maxcpu") or obj.get("cpus")), "vCpu": to_int(obj.get("maxcpu") or obj.get("cpus")),
            "ramGB": bytes_to_gb(obj.get("maxmem")), "diskGB": bytes_to_gb(obj.get("maxdisk")),
            "ramUsedGB": bytes_to_gb(obj.get("mem")), "diskUsedGB": bytes_to_gb(obj.get("disk")),
            "cpuUsagePct": to_float(float(obj["cpu"]) * 100, 1) if obj.get("cpu") is not None else None,
            "uptimeSeconds": to_int(obj.get("uptime")), "node": obj.get("node"), "pool": obj.get("pool"),
            "haState": obj.get("hastate"), "lock": obj.get("lock"), "tags": tags or None,
            "resourceId": obj.get("id") if "/" in str(obj.get("id", "")) else None,
        }
        self.add_node("Server:Virtual", nid, props)
        if vmid is not None:
            self.vm_by_vmid[vmid] = nid
        if env_id:
            self.add_rel(nid, env_id, "IN_ENVIRONMENT")
        if obj.get("node"):
            self.add_rel(nid, self.node(obj["node"]), "HOSTED_ON")
        if self.cluster_id:
            self.add_rel(nid, self.cluster_id, "IN_CLUSTER")
        if app_name:
            aid = self.application(app_name)
            self.add_rel(aid, nid, "DEPLOYED_ON")
            if env_name:
                self.app_envs[aid].add(env_name)
        self._pool_app(nid, obj.get("pool"))
        self.stats["vms"] += 1

    # --- configs (second pass, after every guest is known)
    def apply_configs(self):
        for vmid, (cfg, node_hint) in self.configs.items():
            nid = self.vm_by_vmid.get(vmid)
            if not nid:
                # a config without a matching resource row still describes a guest
                self.load_vm({"vmid": vmid, "name": cfg.get("name") or cfg.get("hostname"), "node": node_hint,
                              "type": "lxc" if "rootfs" in cfg else "qemu", "status": "unknown", "template": cfg.get("template"),
                              "tags": cfg.get("tags")})
                nid = self.vm_by_vmid.get(vmid)
                if not nid:
                    continue
            p = self.nodes[nid]["props"]
            cores, sockets = to_int(cfg.get("cores")), to_int(cfg.get("sockets")) or 1
            ostype = cfg.get("ostype")
            p.update({k: v for k, v in {
                "cpuCores": cores * sockets if cores else p.get("cpuCores"), "vCpu": cores * sockets if cores else p.get("vCpu"),
                "cpuSockets": sockets if cores else None, "ramGB": round(to_int(cfg["memory"]) / 1024, 1) if cfg.get("memory") else p.get("ramGB"),
                "os": OSTYPE_NAMES.get(str(ostype).lower(), ostype) if ostype else p.get("os"), "osType": ostype,
                "description": cfg.get("description"), "bootOrder": cfg.get("boot"), "bios": cfg.get("bios"),
                "machine": cfg.get("machine"), "onBoot": bool(to_int(cfg.get("onboot"))) if "onboot" in cfg else None,
                "qemuAgent": cfg.get("agent"), "hostnameConfigured": cfg.get("hostname"), "vmGenId": cfg.get("vmgenid"),
                "smbios": cfg.get("smbios1"),
            }.items() if v is not None})
            if not p.get("template") and to_int(cfg.get("template")):
                p["template"] = True
            if cfg.get("tags") and not p.get("tags"):
                p["tags"] = split_tags(cfg["tags"])
            if cfg.get("name") and p.get("hostname", "").startswith("vm-") and p["hostname"] != cfg["name"]:
                p["hostname"] = cfg["name"]
            # disks -> datastores (one edge per datastore, listing the disks it holds)
            per_ds = OrderedDict()
            for k, v in cfg.items():
                if re.match(r"^(scsi|virtio|ide|sata|efidisk|tpmstate|rootfs|mp|unused)\d*$", k) and isinstance(v, str):
                    kv = parse_kv(v)
                    spec = (kv.get("_positional") or [None])[0] or kv.get("file")
                    if not spec or spec in ("none", "cdrom") or "media=cdrom" in v:
                        continue
                    storage = spec.split(":")[0] if ":" in spec else None
                    if storage:
                        dsid = self.datastore(storage, p.get("node"))
                        if dsid:
                            entry = per_ds.setdefault(dsid, {"disks": [], "sizeGB": 0.0})
                            entry["disks"].append(k)
                            entry["sizeGB"] = round(entry["sizeGB"] + (size_to_gb(kv.get("size")) or 0.0), 1)
            for dsid, entry in per_ds.items():
                self.add_rel(nid, dsid, "USES_DATASTORE", {"disks": entry["disks"], "sizeGB": entry["sizeGB"] or None})
            # NICs and IPs
            ips_by_index = {}
            for k, v in cfg.items():
                m = re.match(r"^ipconfig(\d+)$", k)
                if m and isinstance(v, str):
                    ips_by_index[int(m.group(1))] = parse_kv(v)
            for k, v in cfg.items():
                m = re.match(r"^net(\d+)$", k)
                if not m or not isinstance(v, str):
                    continue
                idx = int(m.group(1))
                kv = parse_kv(v)
                model, mac = None, None
                for mk in ("virtio", "e1000", "e1000e", "rtl8139", "vmxnet3", "hwaddr"):
                    if mk in kv:
                        model, mac = ("veth" if mk == "hwaddr" else mk), kv[mk]
                        break
                if model is None and kv.get("model"):
                    model, mac = kv.get("model"), kv.get("macaddr")
                nic_id = f"nic-{nid[3:]}-net{idx}"
                self.add_node("NetworkInterface", nic_id, {
                    "name": kv.get("name") or f"net{idx}", "type": "data", "mac": mac.lower() if mac else None, "model": model,
                    "bridge": kv.get("bridge"), "vlanTag": to_int(kv.get("tag")), "firewall": bool(to_int(kv.get("firewall"))) if "firewall" in kv else None,
                    "linkDown": bool(to_int(kv.get("link_down"))) if "link_down" in kv else None, "rateMbps": to_float(kv.get("rate")),
                })
                self.add_rel(nid, nic_id, "HAS_INTERFACE")
                tag = to_int(kv.get("tag"))
                if tag:
                    vid = self.add_node("VLAN", f"vlan-{tag}", {"name": f"VLAN {tag}", "vlanId": tag}, mode="create")
                    self.add_rel(nic_id, vid, "IN_VLAN")
                addrs = []
                ipc = ips_by_index.get(idx) or {}
                for key in ("ip", "ip6"):
                    val = ipc.get(key) or (kv.get(key) if kv.get(key) not in (None, "dhcp", "auto", "manual") else None)
                    if val and val not in ("dhcp", "auto", "manual"):
                        addrs.append((val, "static"))
                    elif val in ("dhcp", "auto"):
                        addrs.append((None, "dhcp"))
                for val, alloc in addrs:
                    if not val:
                        self.nodes[nic_id]["props"]["allocation"] = alloc
                        continue
                    try:
                        iface = ipaddress.ip_interface(val)
                    except ValueError:
                        self.warnings.append(f"vm {vmid}: invalid ipconfig {val!r}")
                        continue
                    ip_id = f"ip-{slug(str(iface.ip))}"
                    self.add_node("IPAddress", ip_id, {"address": str(iface.ip), "version": f"v{iface.version}",
                                                       "type": "private" if iface.ip.is_private else "public", "allocation": alloc,
                                                       "cidr": str(iface.network) if "/" in val else None,
                                                       "gateway": ipc.get("gw") if iface.version == 4 else ipc.get("gw6")}, merge_key="address")
                    self.add_rel(nic_id, ip_id, "HAS_IP")
                    p.setdefault("ipAddress", str(iface.ip))
            self.stats["configs_applied"] += 1

    def finish(self):
        for aid, envs in self.app_envs.items():
            for e in envs:
                self.add_rel(aid, ENVIRONMENTS[e], "IN_ENVIRONMENT")
            if len(envs) == 1:
                self.nodes[aid]["props"]["environment"] = next(iter(envs))
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
            out.append("// ---- remove the inventory part of a previous proxmox import (applications, environments, VLANs and locations are kept)")
            out.append("MATCH (n) WHERE n.origin = 'proxmox' AND (" + " OR ".join(f"n:{l}" for l in labels) + ")\nDETACH DELETE n;")
            out.append("MATCH ()-[r]->() WHERE r.origin = 'proxmox' DELETE r;")

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
        return out

    def summary(self):
        return {"nodes": dict(Counter(n["label"] for n in self.nodes.values())),
                "relationships": dict(Counter(r for (_, _, r) in self.rels)),
                "input": dict(self.stats), "warnings": self.warnings}


# ----------------------------------------------------------------------------- CLI
def main(argv=None):
    ap = argparse.ArgumentParser(prog="proxmox2cypher", description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="Examples:\n"
                                        "  pvesh get /cluster/resources --output-format json > resources.json\n"
                                        "  pvesh get /cluster/status --output-format json > status.json\n"
                                        "  pvesh get /nodes/pve1/qemu/100/config --output-format json > config-100.json\n"
                                        "  proxmox2cypher.py resources.json status.json config-100.json -o pve.cypher --schema --purge\n"
                                        "  proxmox2cypher.py ./pve_dump --datacenter 'Paris DC1' --pool-as-application --load --password secret")
    ap.add_argument("inputs", nargs="+", help="Proxmox API JSON files (see above) or a directory of them")
    ap.add_argument("--cluster", help="cluster name when no /cluster/status object is among the inputs")
    ap.add_argument("--node-of", action="append", default=[], metavar="FILE=NODE",
                    help="node name for guests read from a per-node listing (/nodes/<n>/qemu output has no 'node' field); repeatable")
    ap.add_argument("--datacenter", help="create/link a Location:Datacenter of this name for every node")
    ap.add_argument("--env-map", action="append", metavar="CODE=ENV,...",
                    help="map tag values to production/pre-production/qualification/development/other (repeatable; "
                         "defaults cover prod/prd/p, preprod/staging, qa/uat/test, dev, sandbox/lab)")
    ap.add_argument("--app-tag-prefix", default="app:", help="a guest tag starting with this names its Application (default 'app:'; '' disables)")
    ap.add_argument("--pool-as-application", action="store_true", help="also treat the guest's resource pool as its Application")
    ap.add_argument("--default-criticality", default="medium", choices=["low", "medium", "high", "critical"])
    ap.add_argument("--stopped-status", default="maintenance", choices=["active", "maintenance", "decommissioned"],
                    help="Server.status for stopped/paused guests, templates and offline nodes (default: maintenance)")
    ap.add_argument("--skip-templates", action="store_true", help="ignore templates")
    ap.add_argument("--skip-stopped", action="store_true", help="ignore guests that are not running")
    ap.add_argument("--strict", action="store_true", help="emit only model labels (drop Cluster and Datastore nodes)")
    ap.add_argument("--schema", action="store_true", help="prepend constraints for the enrichment labels")
    ap.add_argument("--purge", action="store_true", help="prepend statements deleting the inventory of a previous proxmox import")
    ap.add_argument("--batch-size", type=int, default=500)
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
    node_of = {}
    for item in args.node_of:
        if "=" not in item:
            ap.error("--node-of expects FILE=NODE")
        f, n = item.rsplit("=", 1)
        node_of[os.path.normcase(os.path.abspath(f))] = n
        node_of[os.path.basename(f)] = n
    files = read_inputs(args.inputs)
    buckets = defaultdict(list)
    for path, objs in files.items():
        default_node = node_of.get(os.path.normcase(os.path.abspath(path))) or node_of.get(os.path.basename(path))
        for obj in objs:
            if default_node and "node" not in obj:
                obj["node"] = default_node
            kind = classify(obj, path)
            if kind:
                buckets[kind].append((obj, path))
            else:
                buckets["ignored"].append((obj, path))
    if not (buckets["vm"] or buckets["config"] or buckets["node"]):
        ap.error("no guest, config or node objects found in " + ", ".join(files) +
                 " (expected pvesh --output-format json output: /cluster/resources, /nodes/<n>/qemu, .../config ...)")

    b = GraphBuilder(args, ", ".join(os.path.basename(p.rstrip("/\\")) for p in args.inputs))
    for obj, _ in buckets["cluster"]:
        b.load_cluster(obj)
    if not b.cluster_id and args.cluster:
        b.cluster(args.cluster)
    for obj, _ in buckets["node"]:
        b.load_node(obj)
    for obj, _ in buckets["storage"]:
        b.load_storage(obj)
    for obj, _ in sorted(buckets["vm"], key=lambda t: (to_int(t[0].get("vmid")) or 0)):
        b.load_vm(obj)
    for obj, path in buckets["config"]:
        b.load_config(obj, path)
    b.apply_configs()
    for obj, _ in buckets["pool"]:
        b.load_pool(obj)
    b.finish()
    b.stats["ignored_objects"] = len(buckets["ignored"])

    stmts = b.statements(purge=args.purge, schema=args.schema)
    header = (f"// Generated by proxmox2cypher from {', '.join(os.path.abspath(p) for p in args.inputs)}\n"
              f"// Idempotent (MERGE on id); rerun with --purge to drop guests that disappeared from the export.\n")
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
