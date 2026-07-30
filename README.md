# Open CMDB Graph

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
├── app/                                    React + @neo4j-nvl/react + neo4j-driver
└── ontology/                               create-context-graph ontology (optional, unrelated to the app - see ontology/README.md)
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
| `:VLAN`                      | Layer-2 network segment                    | id, name, vlanId, description |
| `:Subnet`                    | IP subnet, grouped under a VLAN            | id, name, cidr, gateway, description |
| `:Approval`                  | One step in a change's approval chain      | id, step, status (pending/approved/rejected), comment, decidedAt |
| `:CostCenter`                | Chargeback/showback cost center            | id, name, code |
| `:Budget`                    | A cost center's budget for a fiscal year   | id, name, amount, currency, fiscalYear |
| `:ApplicationVersion`        | Point-in-time version snapshot of an app   | id, version, validFrom, validTo, changelog |
| `:DataFlow`                  | ETL/replication pipeline between data assets | id, name, description, type, schedule |
| `:Probe`                     | Supervision/health check on a resource     | id, name, description, checkType (command/process/port), command, process, port, intervalSeconds, timeoutSeconds, alertCondition, alertThreshold, severity (SEV1-4), status (ok/warning/critical/unknown/disabled) |

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

(:Subnet)            -[:IN_VLAN]->      (:VLAN)
(:IPAddress)         -[:IN_SUBNET]->    (:Subnet)

(:ChangeRequest)     -[:HAS_APPROVAL]-> (:Approval)   // multi-step chain, alongside the simpler APPROVED_BY edge
(:Approval)          -[:DECIDED_BY]->   (:Person)

(:Application | :Team) -[:CHARGED_TO]-> (:CostCenter)
(:CostCenter)        -[:HAS_BUDGET]->   (:Budget)

(:Application)       -[:HAD_VERSION]->  (:ApplicationVersion)

(:DataFlow)          -[:SOURCE_DATA]->  (:Data)
(:DataFlow)          -[:TARGET_DATA]->  (:Data)
(:Application)       -[:IMPLEMENTS]->   (:DataFlow)   // which app runs/owns the pipeline

(:Probe)             -[:MONITORS]->     (:Server:Virtual | :Container | :Application)
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
classification, K IPAM v2 (VLAN/Subnet), L multi-step change approvals,
M cost centers/budgets, N application version history, O data flows,
P supervision probes, and Q write operations. Run individual blocks (A1, B2,
D3, G1, I3, …) as needed; the last section (`Q.` write operations) mutates
the sample data so run those selectively.

The data is idempotent (`MERGE` on `id`) except for section Q of the cookbook,
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
database to create four roles and four example users (one per role):

```bash
cypher-shell -a neo4j://localhost:7687 -u neo4j -p <password> -d system -f cypher/00_security_setup.cypher
```

| Profile | Role | Example user | Can do |
|---|---|---|---|
| Read-only | `cmdb_readonly` | `cmdb_viewer` | Browse the graph and business screens, run read queries. No write controls anywhere, and no access to the sidebar's **Admin** group. |
| Operator | `cmdb_operator` | `cmdb_operator` | Everything read-only can, plus create/update/delete nodes and relationships from the **business screens**. Still no access to the **Admin** group. |
| Superuser | `cmdb_superuser` | `cmdb_superuser` | Everything operator can, plus **Graph Explorer** (free-form Cypher, canvas Inspector, "+ Node"/"+ Relationship" — which can introduce new labels/relationship types on the fly, matching the role's DB-level schema-evolution privileges, `NAME MANAGEMENT`/`INDEX MANAGEMENT`/`CONSTRAINT MANAGEMENT`). Still no **Manage Users** or **Backup & Restore**. |
| Admin | `cmdb_admin` | `cmdb_admin` | Everything superuser can, plus the rest of the **Admin** sidebar group: **Manage Users** and **Backup & Restore**. **Menu Settings** is the one item in that group every profile gets, since it's a display preference, not a permission. |

Each tier is a superset of the one before it — Neo4j privileges are additive
across a user's roles, so a user holding a higher tier's role automatically
gets everything the lower tiers grant too.

All four example users are created with `CHANGE REQUIRED`, so change their
demo passwords on first login. Only `cmdb_admin` carries DBMS-level
privileges (`USER MANAGEMENT`/`ROLE MANAGEMENT`, so it can run the Manage
Users screen) — the other three roles are scoped entirely to *this
database's* data and schema, same as before.

**First-login password change**: signing in with a `CHANGE REQUIRED`
account (any of the four example users above, or a user an admin just
created from the Manage Users screen) doesn't fail with a generic error —
the **Sign in** bar swaps to a "Neo4j requires a new password for `<user>`"
form. Under the hood, Neo4j authenticates the connection but rejects every
query except one with `Neo.ClientError.Security.CredentialsExpired`; the app
detects that specific status code (`isCredentialsExpiredError` in
`app/src/lib/neo4j.js`) and runs the one query that *is* still allowed,
`ALTER CURRENT USER SET PASSWORD FROM $old TO $new` — self-service, so it
needs no admin privileges — then reconnects with the new password (the old
one is invalid immediately, and the existing driver's cached auth token
still has it) before continuing the normal sign-in flow.

**How the app picks it up**: after signing in, the app runs `SHOW CURRENT
USER` against the `system` database to read the account's roles, maps them
to a profile via `deriveCmdbProfile`/`getCurrentUserProfile` in
`app/src/lib/neo4j.js`, and shows a badge next to the connection status
(e.g. `alice · Superuser` or `bob · Read-only`). Below `readonly`, the app
hides write controls (the *"+ New"*/*Edit*/*Delete* buttons on business
screens); below `superuser`, it hides **Graph Explorer**; below `admin`, it
also hides **Manage Users** and **Backup & Restore** — and redirects away
from `/graph`, `/users`, and `/backup-restore` if any of them is navigated
to directly. None of that is what actually stops a write or a
user-management call — the `GRANT`/`REVOKE` privileges in
`cypher/00_security_setup.cypher` are what stop it; Neo4j will reject a
`CREATE`/`SET`/`DELETE`, or a `CREATE USER`/`GRANT ROLE`, from a session
that lacks the matching privilege regardless of what the browser tried to do.

**Role-detection fallbacks** (see `getCurrentUserProfile` in
`app/src/lib/neo4j.js`): if the account has no custom roles, roles that
match none of the four known tiers, or `SHOW CURRENT USER` isn't available
at all, the app fails towards the extreme that keeps data safe rather than
silently locking the account out — empty roles or an unsupported `SHOW
CURRENT USER` fail open to `admin` (Community Edition has no custom roles at
all, see below), while roles that exist but don't match any tier fail closed
to `readonly`. A mis-detected profile only affects what the UI *offers*,
never what Neo4j actually *allows*, so failing open here doesn't create a
security hole, only a UX one (a write or admin action Neo4j rejects still
surfaces as a normal error toast/form error).

**Community Edition**: custom roles/privileges (`CREATE ROLE`, `GRANT ...`)
require Enterprise Edition or Aura. On Community Edition every authenticated
user is effectively unrestricted, so there's no real "read-only account" to
create — running the app against Community Edition, everyone gets the admin
profile (matching the "empty roles list" fallback above), because there's
nothing for the UI to meaningfully restrict.

**Manage Users** (admin only, `app/src/pages/UserManagementPage.jsx`): lists
every Neo4j user via `SHOW USERS`, with a form to create a user (username +
password + one of the four profiles), edit an existing user (change profile
and/or reset password), or delete one. Profile changes revoke the user's
previous CMDB role before granting the new one, so nobody ends up holding two
of the four roles at once. Administration commands support parameters for
usernames/role names (unlike labels/relationship types in ordinary Cypher),
so these calls are plain parameterized Cypher — no identifier allow-list
needed. An admin can't delete their own account from this screen (disabled in
the UI; Neo4j also rejects it server-side).

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

The app has one **business screen per node type** in the left sidebar once
you're signed in (list/search/create/edit/export, the "line of business"
view of the data), grouped by category same as the data model tables above,
plus one more category at the very end, **Admin**, holding **Graph
Explorer** (free-form querying/visualization), **Manage Users**, **Menu
Settings**, and **Backup & Restore** — styled and grouped exactly like any
other sidebar category, not called out as special. Manage Users and Backup
& Restore are admin-only; Graph Explorer is superuser-and-admin; Menu
Settings has no gate at all, since it's a display preference rather than a
permission. Routing is
client-side only (`HashRouter` — URLs look like `#/type/application`), so it
works from a static file server with no rewrite rules.

### Graph Explorer

Superuser and admin — hidden from the sidebar (and its route redirects away
if visited directly) for read-only and operator, see section 3. Every
profile that can reach it also has `canWrite`, so every control below is
always fully enabled for whoever's looking at it:

- **Query bar**: run any of the preset Cypher queries (topology views,
  dependency graphs, open incidents, ticket boards…) or type your own
  Cypher and hit Run.
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
- **Export CSV** (operator, superuser, and admin — hidden for read-only):
  exports the currently filtered rows using the same column set as the
  table (display labels as headers).
- **Get CSV template**: downloads a header-only CSV listing every one of the
  type's *fields* (not just the table's display columns) using their raw
  property keys, e.g. `ipAddress` rather than "IP address" - fill it in and
  it's ready for Import CSV. Available to every profile (it's just a
  header, no data).
- **Import CSV** (operator, superuser, and admin): bulk-creates nodes from a
  CSV file - one row per node, using `createNode` under the hood (same
  number/date/datetime coercion as the Create/Edit form). Headers are
  matched against the type's fields by either property key (the template's
  headers) or display label (Export CSV's headers), case-insensitively, so
  a template you filled in *or* a previously exported CSV both import
  cleanly; unrecognized columns are ignored. Rows missing a required field
  fail validation before any write; everything else is attempted, and a
  summary ("created N of M, K failed: …") lists per-row failures (e.g. a
  duplicate `id`, which Neo4j's uniqueness constraint rejects). Scoped to
  properties only - relationships aren't part of the CSV format, since
  resolving a relationship target from a spreadsheet cell isn't a well-defined
  operation the way autocomplete-picking one in the form is; use Edit
  afterwards for those.
- **Create** (operator, superuser, and admin — i.e. every profile above
  read-only) / **Edit** (every profile, including read-only — see below): a
  form built from the registry's field list, plus one relationship picker
  per configured relationship. Relationship pickers use **autocomplete** -
  type 2+ characters and it searches the `cmdb_fulltext` index (optionally
  restricted to the relevant labels, e.g. a Physical Server's "Location"
  picker only searches `Location` nodes; an Incident's "Impacts" picker
  searches everything, since incidents can impact servers, containers,
  applications, or data). Single-valued relationships (e.g. "assigned to")
  show one picker; multi-valued ones (e.g. "depends on") show existing picks
  as removable chips plus a picker to add more. Saving diffs the selection
  against what was there before and only creates/deletes the relationships
  that actually changed. For a **read-only** profile, the row action itself
  is relabeled **View** (instead of Edit, and instead of being hidden) and
  opens the same modal in view mode: every field and relationship picker is
  disabled (chips show with no remove button, no autocomplete search box),
  the title reads "View `<Type>`" instead of "Edit `<Type>`", and the Save
  button is replaced by a single **Close** button — there's no Cancel next
  to it, since nothing was ever editable to cancel. `EntityFormModal.jsx`'s
  `readOnly` prop drives the modal side of this; the write itself is still
  blocked server-side by Neo4j regardless (see section 3), this only
  changes what the UI *offers*.
- **Delete** (operator, superuser, and admin): detaches and deletes the
  node, with a confirm prompt.
- **Graph** (every row, every profile): opens a modal with that node's
  dependency graph, starting from its 1-hop neighborhood. It's exploratory,
  not editable - **click any node in the modal to expand its own
  connections**, merged into what's already shown, so you can walk the graph
  outward (e.g. from a Ticket → the Incident it tracks → the Application it
  impacts → the Team that owns it) without leaving the modal or re-running a
  query by hand.

### Manage Users

Admin only — hidden from the sidebar (and its route redirects away if
visited directly) for every other profile. Lists every Neo4j user (`SHOW
USERS`), with **+ New User** (username, password, and one of the four
profiles), **Edit** (change profile and/or reset password), and **Delete**.
See section 3 for the underlying `CREATE USER`/`ALTER USER`/`DROP USER`/
`GRANT ROLE`/`REVOKE ROLE` calls.

### Menu Settings

Every profile. A checkbox per entity type (grouped by category, same
grouping as the sidebar itself), "Show all"/"Hide all", to declutter which
business screens actually show up in *your* sidebar. This is a per-browser
preference (`localStorage`, see `MenuPrefsContext.jsx`), not a permission —
a hidden type is still reachable directly by URL and completely unaffected
by what Neo4j will let the account do.

### Backup & Restore

Admin only — hidden from the sidebar (and its route redirects away if
visited directly) for every other profile, same as Manage Users (Graph
Explorer is the one Admin-group item superuser gets too). Same
checkbox-per-type picker as Menu Settings, but for bulk data movement
instead of menu display:

- **Export ZIP**: for the selected types, bundles one `<type>.csv` per type
  (every field, keyed headers — the same machine-readable format
  `Get CSV template` produces on each business screen) plus a
  `relationships.csv` covering edges that run directly between two of the
  selected types (`relType,fromId,toId`), into a single ZIP built
  client-side with `jszip`.
- **Restore ZIP**: reads a ZIP built the same way — imports every
  recognized `<type>.csv` first (node creation across types has no ordering
  dependency), then `relationships.csv` last, so the ids it references
  already exist. Unrecognized entries (a foreign zip, or a type key this
  app version doesn't know) are ignored rather than failing the whole
  restore. Per-type and relationship results (created vs. failed counts)
  are shown after the restore finishes.

Like single-type CSV import, this is additive (`CREATE`, not `MERGE`) and
scoped to node properties + inter-type relationships only — it doesn't
attempt to reconcile or diff against what's already in the database, so
restoring into overlapping data reports per-row failures (duplicate `id`s,
rejected by the uniqueness constraints) rather than overwriting anything.
`app/src/lib/backup.js` holds the export/restore orchestration;
`app/src/lib/csvImport.js` holds the row-level CSV → node/relationship
logic shared with the single-type Import CSV button.

## 5. Extending the model further

Earlier versions of this README suggested extensions; the following are now
implemented (schema, sample data, cookbook queries, and app support):
IPAM (`:NetworkInterface`/`:IPAddress`), change management (`:ChangeRequest`),
asset/warranty tracking (`:Vendor`/`:Contract`), first-class
`:Environment`/`:SLA` nodes, and data classification (`:Data`/`:DataCategory`
with `OWNS_DATA`/`CONSUMES_DATA`/`CLASSIFIED_AS`). See the tables and diagram
in section 1, and cookbook sections E–I for example queries.

A second batch, also now implemented:
- Full IPAM via `:Subnet`/`:VLAN` nodes above `:IPAddress` (`IN_SUBNET`,
  `IN_VLAN`), so capacity-per-subnet is a traversal instead of a manual
  count — cookbook section K.
- `:Approval` as its own node, so a `:ChangeRequest` can carry a multi-step,
  multi-approver sign-off chain (`HAS_APPROVAL`, `DECIDED_BY`) alongside the
  original single `APPROVED_BY` edge, which is kept for the simple case —
  cookbook section L.
- `:CostCenter`/`:Budget` linked from `:Application` and `:Team` via
  `CHARGED_TO`/`HAS_BUDGET`, for chargeback/showback reporting alongside the
  existing `Contract.cost` — cookbook section M.
- Versioned/point-in-time snapshots via `:Application` -[:HAD_VERSION]->
  `:ApplicationVersion {validFrom, validTo}`, so "what version was live on
  date X" is queryable instead of only "what version is it now" —
  cookbook section N.
- `:DataFlow` nodes modeling ETL/replication pipelines between `:Data`
  assets (`SOURCE_DATA`/`TARGET_DATA`), independent of the applications that
  own the data, plus `(:Application)-[:IMPLEMENTS]->(:DataFlow)` to record
  which application actually runs a given pipeline — cookbook section O.

No open "further ideas" are currently listed here — the two batches above
cover every extension previously suggested. Anything genuinely new (e.g.
`:Approval` gaining explicit multi-approver quorum rules, or `:DataFlow`
edges between data assets independent of `:Application`) can be added the
same way: schema in `01_constraints_and_indexes.cypher`, sample data +
relationships in `02_sample_data.cypher`, cookbook queries in
`03_sample_queries.cypher`, and a registry entry in
`app/src/lib/nodeTypes.js`.
