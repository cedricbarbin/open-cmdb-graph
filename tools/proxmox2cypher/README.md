# proxmox2cypher — load a Proxmox VE inventory into Open CMDB Graph

`proxmox2cypher.py` reads Proxmox VE API output — JSON as written by
`pvesh get … --output-format json` or returned by the REST API — and emits
idempotent Cypher that stores the guests, nodes, storage, network and tags in
the data model of this repository (README section 1,
`cypher/01_constraints_and_indexes.cypher`).

It reuses the model's **Server:Virtual / Server:Physical / Application /
Environment / Location:Datacenter / NetworkInterface / IPAddress / VLAN**
labels and relationship types 1:1, and adds two clearly marked *enrichment*
labels for what the model has no home for (**Cluster**, **Datastore**).
Python 3.9+, no dependency; `--load` needs `pip install neo4j`.

The same importer is available in the app's **Import from tools** screen (`app/src/lib/importers/proxmox.js`): upload the json files there to load them without the CLI, with the same options.

## Usage

```bash
# on a Proxmox node (or through the API with the same paths):
pvesh get /cluster/resources --output-format json > resources.json     # guests, nodes, storage, pools — the one call that lists everything
pvesh get /cluster/status    --output-format json > status.json        # cluster name
pvesh get /nodes/pve1/qemu/100/config --output-format json > config-100.json   # optional, per guest: CPU/RAM/OS/NICs/IPs/disks/tags
pvesh get /nodes/pve1/lxc/200/config  --output-format json > config-200.json
pvesh get /pools/webshop     --output-format json > pool-webshop.json  # optional: pool members

# the sample in this repository (one guest from /cluster/resources)
python tools/proxmox2cypher/proxmox2cypher.py tools/sample_data/proxmox/sample.json -o pve.cypher --schema --purge

# a directory with everything above
python tools/proxmox2cypher/proxmox2cypher.py ./pve_dump --datacenter 'Paris DC1' --pool-as-application -o pve.cypher --schema --purge

# generate and load in one go
python tools/proxmox2cypher/proxmox2cypher.py resources.json status.json --schema --purge --load \
    --uri neo4j://localhost:7687 --user neo4j --password '<password>'

# then, or instead:
cypher-shell -a neo4j://localhost:7687 -u neo4j -p '<password>' -f pve.cypher
python tools/ua2cypher/check_cypher.py pve.cypher   # offline structural check
```

Run `cypher/01_constraints_and_indexes.cypher` first (once): the generated
file relies on the `id` uniqueness constraints and only adds the two
enrichment-label constraints itself (`--schema`).

Options:

| Option | Meaning |
|---|---|
| `inputs` | `.json` files or a directory of them. Each file is a list, or an object with a `data` list, of API objects; every object is classified on its own (`type` field, else its keys), so any mix of the calls above works |
| `--cluster NAME` | cluster name when no `/cluster/status` object is among the inputs |
| `--node-of FILE=NODE` | node name for guests read from a per-node listing (`/nodes/<n>/qemu` and `/nodes/<n>/lxc` output has no `node` field). `/cluster/resources` needs no such hint |
| `--datacenter NAME` | create (if missing) a `Location:Datacenter` of this name and link every node to it with `LOCATED_IN` — Proxmox has no site concept of its own |
| `--env-map CODE=ENV,...` | map tag values to `production`, `pre-production`, `qualification`, `development`, `other` (defaults cover `prod`/`prd`/`p`, `preprod`/`staging`, `qa`/`uat`/`test`, `dev`, `sandbox`/`lab`); the first tag that matches sets the guest's environment |
| `--app-tag-prefix PREFIX` | a tag starting with this names the guest's `Application` (default `app:`, e.g. tag `app:webshop`; `''` disables) |
| `--pool-as-application` | also treat the guest's resource pool as its `Application` |
| `--default-criticality` | `Application.criticality` for applications created by this import (default `medium`) |
| `--stopped-status` | `Server.status` for stopped/paused guests, templates and offline nodes: `active`, `maintenance` (default) or `decommissioned` |
| `--skip-templates`, `--skip-stopped` | drop those guests |
| `--strict` | only model labels: no `Cluster`/`Datastore` nodes (the names stay as `cluster`/`node` properties) |
| `--schema` | prepend `CREATE CONSTRAINT … IF NOT EXISTS` for the enrichment labels and an index on `Server.origin` |
| `--purge` | prepend `MATCH (n {origin:'proxmox'}) … DETACH DELETE` for servers, interfaces, IPs, clusters and datastores plus every `origin:'proxmox'` relationship, so guests that left the export disappear; applications, environments, VLANs and locations are kept |
| `--batch-size` | rows per `UNWIND` statement (default 500) |
| `-o`, `--summary` | output file; JSON summary (counts, object kinds, warnings) on stderr |
| `--load`, `--uri`, `--user`, `--password`, `--database` | execute the statements with the `neo4j` Python driver (also read from `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`) |

Every generated node carries `origin: 'proxmox'`, `importedAt` and
`sourceFile`. Ids are deterministic (`vm-<name>`, or `vm-<name>-<vmid>` for a
second guest with the same name, `srv-phy-<node>`, `cluster-<name>`,
`ds-<storage>` for shared storage and `ds-<node>-<storage>` for local
storage, `nic-<guest>-netN`, `ip-<address>`, `vlan-<tag>`), so the output
is safe to re-run (`MERGE` on `id`). Inventory nodes are refreshed on every
run; `Application`, `Environment`, `Location` and `VLAN` nodes are created
only if missing, so hand-maintained properties survive a re-import.

## Mapping

| Proxmox object | Neo4j |
|---|---|
| guest (`type` qemu/lxc from `/cluster/resources`, or a `/nodes/<n>/qemu` / `lxc` row) | `(:Server:Virtual {id, hostname:<name>, name, vmid, vmType, hypervisor:'Proxmox VE'})`; `status` (`running` → `active`, else `--stopped-status`), `powerState`, `template`, `cpuCores` = `vCpu` (`maxcpu`/`cpus`), `ramGB`/`diskGB` (`maxmem`/`maxdisk`), `ramUsedGB`/`diskUsedGB`/`cpuUsagePct`, `uptimeSeconds`, `node`, `pool`, `haState`, `lock`, `tags` (list) |
| guest `node` | `(:Server:Physical {id:'srv-phy-<node>', hostname, os:'Proxmox VE'})`, `(guest)-[:HOSTED_ON]->(node)` |
| node (`type` node, or a `/nodes` row) | the same `Server:Physical` with `nodeStatus`, `cpuCores`, `ramGB`, `diskGB`, `ramUsedGB`, `diskUsedGB`, `cpuUsagePct`, `uptimeSeconds`, `subscriptionLevel`; offline → `--stopped-status` |
| cluster (`/cluster/status` `type` cluster, or `--cluster`) | `(:Cluster {name, quorate, nodeCount, version})` enrichment, `(node)-[:IN_CLUSTER]->`, `(guest)-[:IN_CLUSTER]->`, `cluster` property on nodes |
| storage (`type` storage, or a `/nodes/<n>/storage` row) | `(:Datastore {name, type:<plugintype>, content, shared, capacityGB, inUseGB, freeGB, status})` enrichment, `(node)-[:MOUNTS]->(datastore)`; shared storage is one node for the whole cluster |
| config `cores` × `sockets`, `memory`, `ostype`, `description`, `boot`, `bios`, `machine`, `onboot`, `agent`, `hostname`, `smbios1`, `vmgenid` | `cpuCores`/`vCpu`/`cpuSockets`, `ramGB`, `os` (`l26` → Linux, `win10` → Windows 10 / Server 2016-2019 …) + `osType`, `description`, `bootOrder`, `bios`, `machine`, `onBoot`, `qemuAgent`, `hostnameConfigured`, `smbios`, `vmGenId` |
| config disks (`scsiN`, `virtioN`, `ideN`, `sataN`, `efidiskN`, `tpmstateN`, `rootfs`, `mpN`, `unusedN`; CD-ROMs skipped) | `(guest)-[:USES_DATASTORE {disks:[...], sizeGB}]->(:Datastore)`, one edge per datastore |
| config `netN` (`virtio=MAC,bridge=vmbr0,tag=20,firewall=1`, or the LXC form `name=eth0,hwaddr=MAC,ip=…,gw=…`) | `(:NetworkInterface {id:'nic-<guest>-netN', name, mac, model, bridge, vlanTag, firewall, linkDown, rateMbps, type:'data'})`, `(guest)-[:HAS_INTERFACE]->`; `tag=<vlan>` → `(:VLAN {id:'vlan-<tag>', vlanId})` and `(nic)-[:IN_VLAN]->(vlan)` (a model relationship, used here from a NIC) |
| config `ipconfigN` (cloud-init `ip=10.0.0.5/24,gw=10.0.0.1`) or the LXC `ip=`/`gw=` on `netN` | `(:IPAddress {id:'ip-<address>', address, version, type, allocation:'static', cidr, gateway})`, `(nic)-[:HAS_IP]->(ip)`, first address copied to `Server.ipAddress`; `ip=dhcp` sets `allocation:'dhcp'` on the interface |
| tags | `tags` list on the guest; a tag matching the environment map sets `environment` + `(guest)-[:IN_ENVIRONMENT]->(:Environment)`; a tag `app:<name>` (see `--app-tag-prefix`) creates `(:Application {name})` and `(app)-[:DEPLOYED_ON]->(guest)`, plus `(app)-[:IN_ENVIRONMENT]->` for each environment its guests run in |
| pool (`pool` field on the guest, or `/pools/<id>` members) | `pool` property; with `--pool-as-application` also an `Application` as above |
| `--datacenter` | `(:Location:Datacenter {id:'loc-dc-<slug>', name, provider:'Proxmox VE'})`, `(node)-[:LOCATED_IN]->` |

Objects of other types (`sdn`, `openvz`, …) are ignored and counted in the
summary. A config file whose object has no `vmid` takes it from the digits
in the file name (`config-100.json`); a config for a guest that no listing
mentions still produces the guest node.
