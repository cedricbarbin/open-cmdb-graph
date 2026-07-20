# CMDB Graph Model (Neo4j)

A configuration management database modeled as a property graph: locations
(datacenters/cloud regions), servers (physical/virtual), containers,
applications, teams/people, and incident/ticket tracking — plus a small
React app to explore and edit the graph visually with Neo4j NVL.

```
cmdb/
├── cypher/
│   ├── 01_constraints_and_indexes.cypher   schema: uniqueness constraints, indexes, fulltext index
│   ├── 02_sample_data.cypher               ~80 nodes / ~140 relationships of realistic sample data
│   └── 03_sample_queries.cypher            read/write query cookbook (also used as app presets)
└── app/                                    React + @neo4j-nvl/react + neo4j-driver
```

## 1. Data model

### Node labels

| Label(s)                    | Purpose                                   | Key properties |
|------------------------------|--------------------------------------------|-----------------|
| `:Location:Datacenter`       | Physical site                              | id, name, provider, city, country, tier |
| `:Location:CloudRegion`      | Cloud provider region                      | id, name, provider, region, country |
| `:Server:Physical`           | Physical/hypervisor host                   | id, hostname, ipAddress, os, status, cpuCores, ramGB, serialNumber, vendor, model |
| `:Server:Virtual`            | VM (on-prem or cloud-native)               | id, hostname, ipAddress, os, status, hypervisor, vCpu |
| `:Container`                 | Container instance                         | id, name, image, imageTag, status, ports |
| `:Application`               | Business/technical application             | id, name, version, criticality, businessService |
| `:Team`                      | Owning/operating team                      | id, name, email |
| `:Person`                    | Individual                                 | id, name, email, role |
| `:Incident`                  | Operational incident                       | id, title, severity (SEV1-4), status, createdAt, resolvedAt |
| `:Ticket`                    | Work item (incident/change/request)        | id, title, type, status, priority, createdAt, dueDate |
| `:ChangeRequest`             | Planned change (CAB-style workflow)        | id, title, status (draft/approved/scheduled/…), riskLevel, scheduledStart, scheduledEnd |
| `:NetworkInterface`          | NIC on a server (data or management)       | id, name, type (data/management), speedMbps, mac |
| `:IPAddress`                 | IP address bound to an interface           | id, address, version (v4/v6), type, allocation |
| `:Vendor`                    | Hardware/support vendor                    | id, name, supportPhone, supportEmail, website |
| `:Contract`                  | Maintenance/support contract               | id, contractNumber, type, startDate, endDate, cost, currency |
| `:Environment`               | First-class prod/staging/dev entity        | id, name, description |
| `:SLA`                       | Service level agreement tier               | id, name, uptimeTargetPct, responseTimeMinutes, resolutionTimeHours |

Every node carries a unique `id` string property (enforced by constraints) —
this is what all sample Cypher `MERGE`s and the app's write operations key off.
Physical/Virtual nodes both carry the shared `:Server` label so generic
queries (`MATCH (s:Server)`) work across both; same pattern for
`:Location` and Datacenter/CloudRegion.

### Relationships

```
(:Server:Physical)  -[:LOCATED_IN]->  (:Location)
(:Server:Virtual)   -[:HOSTED_ON]->   (:Server:Physical)      // on-prem VM
(:Server:Virtual)   -[:LOCATED_IN]->  (:Location:CloudRegion) // cloud-native VM
(:Container)        -[:RUNS_ON]->     (:Server)
(:Application)      -[:DEPLOYED_ON]-> (:Container | :Server)
(:Application)      -[:DEPENDS_ON]->  (:Application)
(:Team)              -[:OWNS]->        (:Application)
(:Team)              -[:MANAGES]->     (:Server)
(:Person)            -[:MEMBER_OF]->   (:Team)
(:Incident)          -[:IMPACTS]->     (:Server | :Container | :Application | :Location)
(:Incident)          -[:REPORTED_BY]-> (:Person)
(:Ticket)             -[:TRACKS]->      (:Incident)
(:Ticket)             -[:CONCERNS]->    (:Server | :Container | :Application)
(:Ticket)             -[:ASSIGNED_TO]-> (:Person)
(:Ticket)             -[:OPENED_BY]->   (:Person)
(:Ticket)             -[:RELATES_TO]->  (:ChangeRequest)

(:ChangeRequest)      -[:CONCERNS]->    (:Server | :Container | :Application)
(:ChangeRequest)      -[:REQUESTED_BY]->(:Person)
(:ChangeRequest)      -[:ASSIGNED_TO]-> (:Person)
(:ChangeRequest)      -[:APPROVED_BY]-> (:Person)

(:Server:Physical)   -[:HAS_INTERFACE]->(:NetworkInterface)
(:NetworkInterface)  -[:HAS_IP]->       (:IPAddress)

(:Server:Physical)   -[:SUPPLIED_BY]->  (:Vendor)
(:Server:Physical)   -[:COVERED_BY]->   (:Contract)
(:Contract)          -[:PROVIDED_BY]->  (:Vendor)

(:Server | :Application) -[:IN_ENVIRONMENT]-> (:Environment)
(:Application)       -[:HAS_SLA]->      (:SLA)
```

This lets you answer typical CMDB questions directly with graph traversals:
"what breaks if this VM goes down" (`RUNS_ON`/`HOSTED_ON`/`DEPLOYED_ON` reverse
traversal), "blast radius of an incident" (`IMPACTS` + `DEPENDS_ON*`), "who
owns this app" (`OWNS`), "what's open against this server" (`CONCERNS`),
"which contracts are about to expire" (`COVERED_BY`), "what's approved to go
live this week" (`ChangeRequest.status` + `APPROVED_BY`), or "show me
everything in staging" (`IN_ENVIRONMENT`) as a relationship traversal instead
of a property filter scattered across every label.

Note on denormalization: `Server`/`Application` nodes still carry a flat
`environment` string property *and* now have an `IN_ENVIRONMENT` relationship
to the matching `:Environment` node. That's intentional, not an oversight —
the property is convenient for a quick `WHERE n.environment = 'prod'` filter,
while the relationship lets `:Environment` carry its own metadata and support
richer traversals (e.g. "everything in staging" without touching every label
that happens to have an `environment` property). Same reasoning applies to
`Server:Physical.vendor`/`.model` (quick display) versus the `SUPPLIED_BY`
relationship to `:Vendor` (queryable asset/contract graph).

## 2. Load the schema and sample data

Requires a running Neo4j instance (Desktop, self-hosted, or Aura), Neo4j 5.x,
**no APOC required** — everything runs on stock Cypher.

Using `cypher-shell`:

```bash
cypher-shell -a neo4j://localhost:7687 -u neo4j -p <password> -f cypher/01_constraints_and_indexes.cypher
cypher-shell -a neo4j://localhost:7687 -u neo4j -p <password> -f cypher/02_sample_data.cypher
```

Or paste the files into Neo4j Browser / Neo4j Desktop's query pane and run
each statement (they're `;`-separated). `03_sample_queries.cypher` is a
cookbook organized in lettered sections — A/B discovery & topology, C
application dependencies, D incidents/tickets, E network/IPAM, F vendors
& contracts, G change management, H environments/SLAs, and I write
operations. Run individual blocks (A1, B2, D3, G1, …) as needed; the last
section (`I.` write operations) mutates the sample data so run those
selectively.

The data is idempotent (`MERGE` on `id`) except for section I of the cookbook,
which uses `CREATE` on purpose (it demonstrates ad hoc writes matching what
the app does) — re-running those blocks will duplicate nodes.

## 3. Run the visualization app

```bash
cd app
npm install
npm run dev
```

Open the printed local URL, then in the **Connect** bar at the top enter your
Neo4j connection details (defaults assume `neo4j://localhost:7687` /
`neo4j`/`neo4j`). For Aura use `neo4j+s://<dbid>.databases.neo4j.io`.

The app connects directly from the browser to Neo4j using `neo4j-driver`'s
Bolt-over-WebSocket transport — there's no backend server. This keeps the
demo self-contained, but it does mean the database credentials live in the
browser tab's memory; for anything beyond local/demo use, put a thin API
layer in front (see note in `app/src/lib/neo4j.js`) instead of shipping
credentials to the client.

### What you can do in the app

- **Query bar**: run any of the preset Cypher queries (topology views,
  dependency graphs, open incidents, ticket boards…) or type your own
  read/write Cypher and hit Run.
- **Click a node or relationship** to open the Inspector: edit properties
  in place, add an extra label to a node, or delete the node/relationship
  (node delete detaches all its relationships).
- **+ Node**: pick one or more labels (CMDB ones are suggested, or type your
  own) and fill in properties; `id` is required since it's the unique key
  the rest of the model relies on.
- **+ Relationship**: pick a source/target node from what's currently on
  the canvas, a type (CMDB types suggested via autocomplete), and optional
  properties.

All writes go straight to the database via parameterized Cypher — labels and
relationship types can't be parameterized in Cypher, so `src/lib/neo4j.js`
validates them against an identifier allow-list before interpolating them
into the query string (prevents Cypher injection through that path).

## 4. Extending the model further

The previous version of this README suggested four extensions; all four are
now implemented (schema, sample data, cookbook queries, and app support):
IPAM (`:NetworkInterface`/`:IPAddress`), change management (`:ChangeRequest`),
asset/warranty tracking (`:Vendor`/`:Contract`), and first-class
`:Environment`/`:SLA` nodes. See the tables and diagram in section 1, and
cookbook sections E–H for example queries.

Further ideas that still fit this schema without restructuring it:
- `:Subnet`/`:VLAN` nodes above `:IPAddress` for full IPAM (currently IPs are
  flat; grouping them would let you query capacity per subnet).
- `:Approval` as its own node (instead of a single `APPROVED_BY` edge) if a
  change ever needs multi-step/multi-approver sign-off with per-step status.
- `:CostCenter`/`:Budget` linked from `:Application` or `:Team` for
  chargeback/showback reporting alongside the existing `Contract.cost`.
- Versioned/point-in-time snapshots (e.g. `:Application` -[:HAD_VERSION]->
  `:ApplicationVersion {validFrom, validTo}`) if you need historical CMDB
  state rather than just "current".
