# CMDB Graph Model (Neo4j)

A configuration management database modeled as a property graph: locations
(datacenters/cloud regions), servers (physical/virtual), containers,
applications, teams/people, and incident/ticket tracking — plus a React 
app to explore and edit the graph visually with Neo4j NVL.

```
cmdb/
├── cypher/
│   ├── 00_security_setup.cypher            optional: cmdb_readonly / cmdb_admin roles + demo users
│   ├── 01_constraints_and_indexes.cypher   schema: uniqueness constraints, indexes, fulltext index
│   ├── 02_sample_data.cypher               ~90 nodes / ~160 relationships of realistic sample data
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
| `:Data`                      | Data asset (database, cache, log store…)   | id, name, description, type, format, volumeGB |
| `:DataCategory`              | Data classification taxonomy entry         | id, name, sensitivity (public/internal/confidential/restricted), regulatoryScope |

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

(:Server | :Application | :Data) -[:IN_ENVIRONMENT]-> (:Environment)
(:Application)       -[:HAS_SLA]->      (:SLA)

(:Application)       -[:OWNS_DATA]->    (:Data)   // system of record
(:Application)       -[:CONSUMES_DATA]->(:Data)   // reads/depends on it (data lineage)
(:Data)              -[:CLASSIFIED_AS]->(:DataCategory)
(:Data)              -[:STORED_ON]->    (:Server)
(:Incident)          -[:IMPACTS]->      (:Data)   // Data is also a valid IMPACTS/CONCERNS target
(:Ticket)            -[:CONCERNS]->     (:Data)
```

This lets you answer typical CMDB questions directly with graph traversals:
"what breaks if this VM goes down" (`RUNS_ON`/`HOSTED_ON`/`DEPLOYED_ON` reverse
traversal), "blast radius of an incident" (`IMPACTS` + `DEPENDS_ON*`), "who
owns this app" (`OWNS`), "what's open against this server" (`CONCERNS`),
"which contracts are about to expire" (`COVERED_BY`), "what's approved to go
live this week" (`ChangeRequest.status` + `APPROVED_BY`), "show me everything
in staging" (`IN_ENVIRONMENT`), or "which applications touch regulated data"
(`OWNS_DATA`/`CONSUMES_DATA` + `CLASSIFIED_AS` + `DataCategory.regulatoryScope`)
as a relationship traversal instead of a property filter scattered across
every label.

Data modeling note: `:Data` is deliberately separate from `:Application` —
an application node is "the order-api service", a data node is "the orders
database it reads/writes". Splitting them lets more than one application
point at the same data asset (`OWNS_DATA` for the system of record,
`CONSUMES_DATA` for everyone else reading it), which is what makes data
lineage and "who touches this PII" queries possible in the first place; if
data lived as a property on `Application` there'd be nothing to traverse.

Note on denormalization: `Server`/`Application`/`Data` nodes still carry a flat
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
& contracts, G change management, H environments/SLAs, I data &
classification, and J write operations. Run individual blocks (A1, B2, D3,
G1, I3, …) as needed; the last section (`J.` write operations) mutates the
sample data so run those selectively.

The data is idempotent (`MERGE` on `id`) except for section J of the cookbook,
which uses `CREATE` on purpose (it demonstrates ad hoc writes matching what
the app does) — re-running those blocks will duplicate nodes.

## 3. Authentication & authorization

The app doesn't implement its own login system — it authenticates with
whatever Neo4j credentials you give it in the **Sign in** form (the same
`neo4j-driver` Bolt auth used everywhere else), and authorization is
Neo4j's own native role-based access control, not something bolted onto
the client. That matters here specifically because there's no backend: the
browser holds the real database credentials, so the only trustworthy place
to enforce "this account can't write" is the database itself — a UI that
merely hides a button is not a security boundary.

**Setup** (Neo4j Enterprise Edition or Aura only — see the Community Edition
note below): run `cypher/00_security_setup.cypher` against the `system`
database to create two roles and two example users:

```bash
cypher-shell -a neo4j://localhost:7687 -u neo4j -p <password> -d system -f cypher/00_security_setup.cypher
```

| Profile | Role | Example user | Can do |
|---|---|---|---|
| Read-only | `cmdb_readonly` | `cmdb_viewer` | Browse the graph, run read queries |
| Admin | `cmdb_admin` | `cmdb_operator` | Everything read-only can, plus create/update/delete nodes and relationships, add labels, and (since the app's forms can introduce new labels/relationship types on the fly) evolve the schema |

Both example users are created with `CHANGE REQUIRED`, so change their demo
passwords on first login. `cmdb_admin` is deliberately scoped to *this
database's* data and schema — it does not include DBMS-level privileges like
user/role management or other databases, even though the app calls it
"admin".

**How the app picks it up**: after signing in, the app runs `SHOW CURRENT
USER` against the `system` database to read the account's roles, maps them
to a profile, and shows a badge next to the connection status (e.g. `alice ·
admin` or `bob · read-only`). For a read-only profile it hides the *"+
Node"*/*"+ Relationship"* buttons, renders the Inspector's properties as
plain text instead of editable fields, and warns inline in the query bar if
a typed query looks like a write. None of that is what actually stops a
write — `GRANT WRITE ON GRAPH neo4j TO cmdb_admin` (and its absence for
`cmdb_readonly`) is what stops it; Neo4j will reject a `CREATE`/`SET`/`DELETE`
from a `cmdb_readonly` session regardless of what the browser tried to do.

**Role-detection fallbacks** (see `getCurrentUserProfile` in
`app/src/lib/neo4j.js`): if the account has no custom roles, or `SHOW
CURRENT USER` isn't available at all, the app defaults to showing the admin
UI rather than silently locking the account out of its own data — a
mis-detected profile only affects what the UI *offers*, never what Neo4j
actually *allows*, so failing open here doesn't create a security hole, only
a UX one (a write attempt that Neo4j rejects still surfaces as a normal error
toast).

**Community Edition**: custom roles/privileges (`CREATE ROLE`, `GRANT ...`)
require Enterprise Edition or Aura. On Community Edition every authenticated
user is effectively unrestricted, so there's no real "read-only account" to
create — running the app against Community Edition, everyone gets the admin
profile (matching the "empty roles list" fallback above), because there's
nothing for the UI to meaningfully restrict.

## 4. Run the visualization app

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

The app has two areas, both listed in the left sidebar once you're signed in:
**Graph Explorer** (free-form querying/visualization) and one **business
screen per node type** (list/search/create/edit/export, the "line of
business" view of the same data). Routing is client-side only (`HashRouter`
— URLs look like `#/type/application`), so it works from a static file
server with no rewrite rules.

### Graph Explorer

- **Query bar**: run any of the preset Cypher queries (topology views,
  dependency graphs, open incidents, ticket boards…) or type your own
  Cypher and hit Run. Available to both profiles; for a read-only profile,
  a query that looks like a write is flagged inline and the Run button is
  disabled (see section 3) rather than sending it and waiting for Neo4j to
  reject it.
- **Click a node or relationship** to open the Inspector: edit properties
  in place, add an extra label to a node, or delete the node/relationship
  (node delete detaches all its relationships). Read-only profiles get a
  view-only version of the same panel.
- **+ Node**: pick one or more labels (CMDB ones are suggested, or type your
  own) and fill in properties; `id` is required since it's the unique key
  the rest of the model relies on. Admin only.
- **+ Relationship**: pick a source/target node from what's currently on
  the canvas, a type (CMDB types suggested via autocomplete), and optional
  properties. Admin only.

All writes go straight to the database via parameterized Cypher — labels and
relationship types can't be parameterized in Cypher, so `src/lib/neo4j.js`
validates them against an identifier allow-list before interpolating them
into the query string (prevents Cypher injection through that path).

### Business screens

One sidebar entry per node type (Datacenters, Physical Servers, Applications,
Incidents, Tickets, Change Requests, Vendors, …), grouped by category. Every
entry is driven by the same two generic screens, configured from a single
registry (`app/src/lib/nodeTypes.js`) that lists each type's columns, form
fields (with the right input: text/number/date/datetime/select), and
relationships (direction, cardinality, which labels to search) - adding a
20th business screen means adding one entry to that file, not writing a new
screen.

- **List + search**: a table of that type's nodes (columns from the
  registry), with a client-side filter box across all visible columns.
- **Export CSV**: exports the currently filtered rows using the same column
  set as the table.
- **Create / Edit** (admin only, same gating as the Graph Explorer):
  a form built from the registry's field list, plus one relationship picker
  per configured relationship. Relationship pickers use **autocomplete** -
  type 2+ characters and it searches the `cmdb_fulltext` index (optionally
  restricted to the relevant labels, e.g. a Physical Server's "Location"
  picker only searches `Location` nodes; an Incident's "Impacts" picker
  searches everything, since incidents can impact servers, containers,
  applications, or data). Single-valued relationships (e.g. "assigned to")
  show one picker; multi-valued ones (e.g. "depends on") show existing picks
  as removable chips plus a picker to add more. Saving diffs the selection
  against what was there before and only creates/deletes the relationships
  that actually changed.
- **Delete** (admin only): detaches and deletes the node, with a confirm
  prompt.
- **Detail** (every row, both profiles): opens a modal with that node's
  dependency graph, starting from its 1-hop neighborhood. It's exploratory,
  not editable - **click any node in the modal to expand its own
  connections**, merged into what's already shown, so you can walk the graph
  outward (e.g. from a Ticket → the Incident it tracks → the Application it
  impacts → the Team that owns it) without leaving the modal or re-running a
  query by hand.

## 5. Extending the model further

Earlier versions of this README suggested extensions; the following are now
implemented (schema, sample data, cookbook queries, and app support):
IPAM (`:NetworkInterface`/`:IPAddress`), change management (`:ChangeRequest`),
asset/warranty tracking (`:Vendor`/`:Contract`), first-class
`:Environment`/`:SLA` nodes, and data classification (`:Data`/`:DataCategory`
with `OWNS_DATA`/`CONSUMES_DATA`/`CLASSIFIED_AS`). See the tables and diagram
in section 1, and cookbook sections E–I for example queries.

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
- `:DataFlow` edges between `:Data` assets (instead of only `Application`
  -> `Data`) if you need to model ETL/replication pipelines that move data
  between stores independently of the applications that own them.

TODO/Possible roadmap:
- Add a logo
- Add new data types (see above)
- Add global export to CSV/JSON capability
- Add import from CSV/JSON capability & downloadable templates
- Embed the launch of neo4j backend (or document how to container it)
