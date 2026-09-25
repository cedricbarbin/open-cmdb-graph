# efficientip2cypher — load EfficientIP SOLIDserver IPAM exports into Open CMDB Graph

`efficientip2cypher.py` reads IPAM exports from EfficientIP SOLIDserver —
network (subnet), address and VLAN lists, either as CSV from the GUI
**Export** button or as JSON from the REST API (`ip_block_subnet_list`,
`ip_address_list`, `vlmvlan_list`) — and emits idempotent Cypher that stores
them in the data model of this repository (README section 1,
`cypher/01_constraints_and_indexes.cypher`).

It reuses the model's **Subnet / VLAN / IPAddress / NetworkInterface /
Location:Datacenter** labels and relationship types 1:1, and adds one
clearly marked *enrichment* label (**IPSpace**, SOLIDserver's "Space") and
two enrichment relationships (`IN_SPACE`, `PART_OF`). Python 3.9+, no
dependency; `--load` needs `pip install neo4j`.

The same importer is available in the app's **Import from tools** screen (`app/src/lib/importers/efficientip.js`): upload the exports there to load them without the CLI, with the same options.

## Usage

```bash
# the sample in this repository (a network export)
python tools/efficientip2cypher/efficientip2cypher.py tools/sample_data/efficientip/sample.csv -o ipam.cypher --schema --purge

# networks + addresses + VLANs from a directory of exports, one space only, linked to existing servers
python tools/efficientip2cypher/efficientip2cypher.py ./solidserver_exports --space 'headquarter C' --link-servers -o ipam.cypher

# generate and load in one go
python tools/efficientip2cypher/efficientip2cypher.py networks.csv addresses.csv --schema --purge --load \
    --uri neo4j://localhost:7687 --user neo4j --password '<password>'

# then, or instead:
cypher-shell -a neo4j://localhost:7687 -u neo4j -p '<password>' -f ipam.cypher
python tools/ua2cypher/check_cypher.py ipam.cypher   # offline structural check
```

Run `cypher/01_constraints_and_indexes.cypher` first (once): the generated
file relies on the `Subnet.cidr` / `IPAddress.address` / `id` uniqueness
constraints and only adds the enrichment-label constraint itself (`--schema`).

Options:

| Option | Meaning |
|---|---|
| `inputs` | `.csv` / `.json` exports, or a directory of them. Each file is recognised as a **network**, **address** or **VLAN** list from its columns |
| `--kind FILE=KIND` | force a file to be read as `networks`, `addresses` or `vlans` |
| `--space NAME` | only import this IP space (`Space` column / API `site_name`) |
| `--include-free` | also import free/unassigned addresses (default: only addresses with a status other than free, or with a name/device/MAC) |
| `--link-servers` | append a statement that links imported addresses to **existing** `Server` nodes — matched by `Server.ipAddress` or by hostname (short name, case-insensitive, against the address `Name` and `Device` columns) — through a `NetworkInterface` named after the `Interface` column (`eth0` by default). Servers are matched, never created |
| `--vlan-domains` | key VLANs as `vlan-<domain>-<id>` when the export carries a VLAN domain (default `vlan-<id>`, which matches `cypher/02_sample_data.cypher` and the other importers) |
| `--no-locations` | do not create `Location:Datacenter` nodes from the `Location`/`Site` column |
| `--strict` | only model labels/relationships: no `IPSpace`, `IN_SPACE`, `PART_OF` (the space stays as a `space` property) |
| `--schema` | prepend `CREATE CONSTRAINT … IF NOT EXISTS` for the enrichment label and an index on `IPAddress.origin` |
| `--purge` | prepend `MATCH (n {origin:'efficientip'}) … DETACH DELETE` for subnets, VLANs, IP spaces, IP addresses and the interfaces this tool created, plus every `origin:'efficientip'` relationship, so entries that left the export disappear; locations and servers are kept |
| `--batch-size` | rows per `UNWIND` statement (default 500) |
| `-o`, `--summary` | output file; JSON summary (counts, file kinds, warnings) on stderr |
| `--load`, `--uri`, `--user`, `--password`, `--database` | execute the statements with the `neo4j` Python driver (also read from `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`) |

Every generated node carries `origin: 'efficientip'`, `importedAt` and
`sourceFile`. Ids are deterministic (`subnet-<cidr>`, `ip-<address>`,
`vlan-<id>`, `ipspace-<name>`, `loc-dc-<location>`), and subnets/addresses
are merged on the constrained property (`cidr` / `address`) rather than on
`id`, so an address that already exists in the CMDB — created by hand, by
`rvtools2cypher` from vNetwork, or by `proxmox2cypher` from a cloud-init
config — is enriched with the IPAM data instead of colliding with the
uniqueness constraint. Subnets, VLANs, spaces and addresses are refreshed
on every run (IPAM is the source of truth for them); `Location` nodes are
created only if missing.

## Mapping

### Network export (`Space, Network, Netmask, Status, Name, Description, Gateway, Location, VLAN …`)

| SOLIDserver | Neo4j |
|---|---|
| `Network` + `Netmask` (prefix length, dotted mask, or the API's `subnet_size` address count) — or `start`/`end` address | `(:Subnet {id:'subnet-<cidr>', cidr, version, prefixLength, addressCount})` |
| `Name`, `Description`, `Gateway`, `Status`, `Class`, `Is terminal`, `Parent` | `name` (falls back to the CIDR), `description`, `gateway`, `status` (lower-cased), `networkClass`, `terminal`, `parentNetwork` |
| `Space` (API `site_name`) | `space` property and `(:IPSpace {name})` enrichment, `(subnet)-[:IN_SPACE]->(space)`. The same CIDR in two spaces is kept once (`Subnet.cidr` is unique) with a warning — use `--space` |
| `Location` / `Site` | `(:Location:Datacenter {id:'loc-dc-<slug>', name})`, `(subnet)-[:LOCATED_IN]->(location)` (`LOCATED_IN` is a model relationship, its use from a Subnet is an enrichment) |
| `VLAN ID` / `VLAN` (API `vlmvlan_vlan_id` / `vlmvlan_name`) | `(:VLAN {id:'vlan-<id>', name, vlanId})`, `(subnet)-[:IN_VLAN]->(vlan)` |
| a network contained in a larger imported network (block → subnet, same space) | `(child)-[:PART_OF]->(parent)` enrichment, computed from the CIDRs |

### Address export (`Space, Network, Netmask, Address, Name, MAC address, Status, Device, Interface, Description, Domain …`)

| SOLIDserver | Neo4j |
|---|---|
| `Address` (API `hostaddr`) | `(:IPAddress {id:'ip-<address>', address, version:'v4'/'v6', type:'private'/'public'})` |
| `Status` / API `type` | `allocation` (`dhcp` when the status mentions DHCP, else `static`), `status` (lower-cased); free addresses are skipped unless `--include-free` |
| `Name` (+ `Domain`), `MAC address`, `Device`, `Interface`, `Description`, `Alias`, `Class` | `hostname` (FQDN when a domain is given), `mac`, `device`, `interface`, `description`, `alias`, `ipClass` |
| `Network` + `Netmask`, else longest-prefix match among the imported networks | `(ip)-[:IN_SUBNET]->(:Subnet)`; a network named only by the address export is created as a bare Subnet |
| `Name` / `Device` with `--link-servers` | `MATCH (s:Server)` by `ipAddress` or short hostname, `MERGE (s)-[:HAS_INTERFACE]->(:NetworkInterface {id:'nic-<server id>-<interface>', mac})-[:HAS_IP]->(ip)` |

### VLAN export (`VLAN ID, Name, Domain, Description`)

`(:VLAN {id:'vlan-<id>', name, vlanId, vlanDomain, description})`. Network
rows that reference the VLAN link to the same node.

## Column-name handling

Headers are matched after lower-casing and stripping non-alphanumerics, so
GUI labels (`MAC address`, `VLAN ID`), API field names (`mac_addr`,
`vlmvlan_vlan_id`, `start_hostaddr`, `subnet_size`) and common synonyms
(`Prefix`, `Mask`, `Hostname`, `Site`) all resolve to the same field. A file
is an **address** list when it has an address column, otherwise a
**network** list when it has a network column, otherwise a **VLAN** list
when it has a VLAN id column; `--kind` overrides that. Quoted CSV values,
`;`/`,`/tab delimiters and UTF-8/UTF-16/cp1252 encodings are detected.
