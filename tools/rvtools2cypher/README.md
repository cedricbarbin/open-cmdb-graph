# rvtools2cypher — load an RVTools export into Open CMDB Graph

`rvtools2cypher.py` reads an [RVTools](https://www.robware.net/) export of a
VMware vSphere inventory — the `.xlsx` workbook or the per-tab
`RVTools_tabvInfo.csv` / `RVTools_tabvHost.csv` / … files — and emits
idempotent Cypher that stores it in the data model of this repository
(README section 1, `cypher/01_constraints_and_indexes.cypher`).

It reuses the model's **Server:Virtual / Server:Physical / Location:Datacenter /
Application / BusinessDomain / Environment / NetworkInterface / IPAddress**
labels and their relationship types 1:1, and adds two clearly marked
*enrichment* labels for what the model has no home for (**Cluster**,
**Datastore**). Python 3.9+, no dependency — the `.xlsx` is read with the
standard library; `--load` needs `pip install neo4j`.

The same importer is available in the app's **Import from tools** screen (`app/src/lib/importers/rvtools.js`): upload the `.xlsx` (or the csv files) there to load it without the CLI, with the same options.

## Usage

```bash
# generate Cypher from the workbook (all tabs it contains are used)
python tools/rvtools2cypher/rvtools2cypher.py RVTools_export.xlsx -o vsphere.cypher --schema --purge

# same from the per-tab csv files RVTools writes with "Export all to csv"
python tools/rvtools2cypher/rvtools2cypher.py ./rvtools_csv_dir -o vsphere.cypher --schema --purge

# an export kept locally (tools/sample_data/ is git-ignored: keep your own exports there)
python tools/rvtools2cypher/rvtools2cypher.py tools/sample_data/rvtools/RVTools_export.xlsx -o rvtools.cypher --schema --purge

# generate and load in one go
python tools/rvtools2cypher/rvtools2cypher.py RVTools_export.xlsx --schema --purge --load \
    --uri neo4j://localhost:7687 --user neo4j --password '<password>'

# then, or instead:
cypher-shell -a neo4j://localhost:7687 -u neo4j -p '<password>' -f vsphere.cypher
python tools/ua2cypher/check_cypher.py vsphere.cypher   # offline structural check
```

Run `cypher/01_constraints_and_indexes.cypher` first (once): the generated
file relies on the `id` uniqueness constraints and only adds the two
enrichment-label constraints itself (`--schema`).

Options:

| Option | Meaning |
|---|---|
| `inputs` | one `.xlsx`, one or more `.csv` files, or a directory of `RVTools_tab*.csv` |
| `--sheet NAME=KIND` | force a sheet/csv to be read as `vInfo`, `vHost`, `vCluster`, `vDatastore` or `vNetwork` when auto-detection (by column names) gets it wrong |
| `--app-column`, `--domain-column`, `--env-column`, `--site-column` | vInfo column (header text) holding the application name, business domain, environment and site/datacenter. Defaults: a vSphere tag or custom attribute named `ApplicationName`/`Application`, `ApplicationDomain`/`Domain`, `Environment`/`Env`, `SITE`/`Location`; the site falls back to RVTools' own `Datacenter` column |
| `--env-map CODE=ENV,...` | map raw environment values to the 5 canonical environments (`production`, `pre-production`, `qualification`, `development`, `other`). Defaults cover `P`/`PROD`/`X`, `PP`/`PREPROD`/`STAGING`, `Q`/`QA`/`UAT`/`TEST`/`R`/`T`, `D`/`DEV`, `S`/`SANDBOX`; unknown values go to `other` and are counted in the summary. When both `X` and `P` occur in the file, `P` is read as pre-production (French "X = exploitation" convention) unless you map it yourself |
| `--tag-columns HEADER ...`, `--no-tags` | which extra vInfo columns to copy onto the VM as `tag_<name>` properties (default: every `vInfo_tags_*` column; RVTools custom attributes have plain headers, so name them here) |
| `--provider` | `Location.provider` for datacenters created by this import (default `VMware vSphere`) |
| `--default-criticality` | `Application.criticality` for applications created by this import (default `medium`) |
| `--powered-off-status` | `Server.status` for powered-off VMs and templates: `active`, `maintenance` (default) or `decommissioned` |
| `--no-vm-location` | do not link VMs to their site with `LOCATED_IN` (hosts always are) |
| `--skip-templates`, `--skip-powered-off` | drop those vInfo rows |
| `--strict` | only model labels: no `Cluster`/`Datastore` nodes (the names stay as `cluster`/`vmPath` properties) |
| `--schema` | prepend `CREATE CONSTRAINT … IF NOT EXISTS` for the enrichment labels and an index on `Server.origin` |
| `--purge` | prepend `MATCH (n {origin:'rvtools'}) … DETACH DELETE` for the inventory labels (servers, interfaces, IPs, clusters, datastores) and every `origin:'rvtools'` relationship, so VMs that left the export disappear; applications, domains, environments and locations are kept |
| `--batch-size` | rows per `UNWIND` statement (default 500) |
| `-o`, `--summary` | output file; JSON summary (node/relationship counts, columns picked, effective environment map, warnings) on stderr |
| `--load`, `--uri`, `--user`, `--password`, `--database` | execute the statements with the `neo4j` Python driver (also read from `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`) |

Every generated node carries `origin: 'rvtools'`, `importedAt` and
`sourceFile`. Ids are deterministic (`vm-<vm name>`, `srv-phy-<host fqdn>`,
`loc-dc-<site>`, `app-<name>`, `cluster-<name>`, `ds-<name>`,
`nic-<vm>-<adapter>`, `ip-<address>`) so the output is safe to re-run
(`MERGE` on `id`).

**Two write modes.** Inventory nodes (servers, interfaces, IPs, clusters,
datastores) are *refreshed* on every run (`MERGE … SET n += row`): RVTools is
the source of truth for them. Reference nodes (Application, BusinessDomain,
Environment, Location) are *created only if missing* (`ON CREATE SET`):
an application or datacenter that already exists in the CMDB — with an owner
team, an SLA, a real address — keeps its hand-maintained properties, and
only the relationships to the freshly imported VMs are (re)created.
`Environment` and `BusinessDomain` are merged by `name` (both have a
uniqueness constraint on it), the others by `id`.

## Mapping

### vInfo (required — one row per VM or template)

| RVTools column | Neo4j |
|---|---|
| `VM` (`vInfoVMName`) | `(:Server:Virtual {id:'vm-<slug>', name})` — rows without a VM name are skipped |
| `DNS Name` (`vInfoGuestHostName`) | `hostname` (falls back to the VM name) |
| `Powerstate`, `Template` | `status` (`poweredOn` → `active`, otherwise `--powered-off-status`), `powerState`, `template` |
| `Primary IP Address` | `ipAddress` |
| `OS according to the VMware Tools` / `… configuration file` | `os` (tools first), `osConfigured` when they differ |
| `CPUs`, `Memory`, `Total disk capacity MiB`, `Provisioned MiB`, `In Use MiB` | `cpuCores` = `vCpu`, `ramGB`, `diskGB`, `provisionedGB`, `inUseGB` (MiB → GB) |
| `Creation date`, `PowerOn`, `Change Version` | `createdAt`, `bootTime`, `changedAt` as `datetime()` (Excel serials and `yyyy/mm/dd hh:mm:ss` text are both understood; vSphere's 1970-01-01 "unknown" is dropped) |
| `Guest state`, `Connection state`, `Config status`, `Heartbeat`, `Firmware`, `HW version`, `Path`, `Folder`, `Resource pool`, `vApp`, `VM ID`, `VM UUID`, `VI SDK Server`, `HA Restart Priority`, `Latency Sensitivity`, `Annotation` | same-named camelCase properties (`vmPath`, `hwVersion`, `vCenter`, `description` …) |
| `Host` | `(:Server:Physical {hostname, os:'VMware ESXi', status:'active'})`, `(VM)-[:HOSTED_ON]->(host)`; the host's `LOCATED_IN` datacenter is the majority site of its VMs unless a vHost tab says otherwise |
| `Cluster` | `(:Cluster)` enrichment, `(VM)-[:IN_CLUSTER]->`, `(host)-[:IN_CLUSTER]->`, plus a flat `cluster` property |
| `Datacenter`, or the site tag (`--site-column`) | `(:Location:Datacenter {name})`, `(VM)-[:LOCATED_IN]->` (`--no-vm-location` to skip), `(host)-[:LOCATED_IN]->`; flat `site`/`datacenter` properties |
| `[datastore]` prefix of `Path` | `(:Datastore)` enrichment, `(VM)-[:USES_DATASTORE]->` |
| application tag (`--app-column`) | `(:Application {id:'app-<slug>', name, businessService:<domain>})`, `(app)-[:DEPLOYED_ON]->(VM)`, `(app)-[:IN_ENVIRONMENT]->` for every environment its VMs run in, `environment` property when there is only one |
| domain tag (`--domain-column`) | `(:BusinessDomain {name})`, `(app)-[:IN_BUSINESS_DOMAIN]->` |
| environment tag (`--env-column`) | `environment` (canonical), `environmentCode` (raw), `(VM)-[:IN_ENVIRONMENT]->(:Environment)` — the five `env-*` nodes match `cypher/02_sample_data.cypher` |
| other `vInfo_tags_*` / `--tag-columns` | `tag_<name>` string properties on the VM |

### vHost (optional)

`Host`, `Datacenter`, `Cluster`, `# CPU`, `Cores per CPU`, `# Cores`, `# Memory`,
`CPU Model`, `ESX Version`, `Boot time`, `Vendor`, `Model`, `Serial number`,
`Service tag`, `BIOS Version`, `Domain`, `UUID`, `Object ID`, `# VMs` →
`(:Server:Physical {osVersion, cpuCores, cpuSockets, ramGB, cpuModel, vendor,
model, serialNumber, serviceTag, biosVersion, bootTime, vmCount …})`,
`(host)-[:LOCATED_IN]->(:Location:Datacenter)`, `(host)-[:IN_CLUSTER]->(:Cluster)`.
Hosts are matched to vInfo's `Host` column by short name, so `esx01` and
`esx01.example.com` are the same node.

### vCluster, vDatastore, vNetwork (optional)

| Tab | Neo4j |
|---|---|
| vCluster | `(:Cluster {configStatus, overallStatus, hostCount, totalCpuMHz, cpuCores, ramGB, haEnabled, drsEnabled})` |
| vDatastore | `(:Datastore {type, capacityGB, provisionedGB, inUseGB, freeGB, vmCount, url})`, `(host)-[:MOUNTS]->(datastore)` from its `Hosts` column |
| vNetwork | `(:NetworkInterface {id:'nic-<vm>-<adapter>', name, mac, macType, adapterType, network, switch, connected, type:'data'})`, `(VM)-[:HAS_INTERFACE]->`, one `(:IPAddress {address, version, type})` per `IPv4 Address`/`IPv6 Address` entry, `(nic)-[:HAS_IP]->` |

Every other RVTools tab (vCPU, vMemory, vDisk, vPartition, vSnapshot, vTools,
vNIC, vSwitch, vPort, vHBA, vHealth, vLicense …) is ignored.

## Column-name handling

Headers are matched after lower-casing, stripping non-alphanumerics and an
optional tab prefix, so RVTools' "pretty" headers (`Primary IP Address`,
`# Cores`), the internal names some versions and custom sheets carry
(`vInfoPrimaryIPAddress`, `vHostNumCores`) and the tab-prefixed csv layout
all resolve to the same field. `#` becomes `num`, which keeps `# Hosts`
(a count) apart from `Hosts` (a list). A sheet is recognised as vInfo /
vHost / vCluster / vDatastore / vNetwork by which of those fields it has,
whatever the sheet is named; `--sheet` overrides that.

`#N/A`, `#REF!` and other Excel error values are treated as empty — the
sample workbook's helper columns (`Application cartosi`, `Valeur refac`) are
full of them and are simply not tag columns, so they are ignored unless you
pass them to `--tag-columns` or pick one with `--app-column`.
