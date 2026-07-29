# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Open CMDB Graph: a configuration management database modeled as a Neo4j
property graph (locations, servers, containers, applications, teams,
incidents/tickets, change requests, network/IPAM, vendors/contracts,
environments/SLAs, data classification), plus a React SPA (`app/`) that
connects directly to Neo4j from the browser (no backend) to explore and
edit the graph via Neo4j NVL.

Repo layout:
```
cypher/   Cypher scripts: security setup, constraints/indexes, sample data, query cookbook
app/      React + @neo4j-nvl/react + neo4j-driver SPA
```

## Commands

All app commands run from `app/`:
```bash
cd app
npm install
npm run dev       # Vite dev server, http://localhost:5173
npm run build     # production build
npm run preview   # preview a production build
```
There is no lint script and no test suite configured in this repo — don't
invent `npm run lint`/`npm test` invocations.

Loading the Neo4j schema/data (requires Neo4j 5.x, no APOC needed):
```bash
cypher-shell -a neo4j://localhost:7687 -u neo4j -p <password> -f cypher/01_constraints_and_indexes.cypher
cypher-shell -a neo4j://localhost:7687 -u neo4j -p <password> -f cypher/02_sample_data.cypher
# optional, Enterprise/Aura only:
cypher-shell -a neo4j://localhost:7687 -u neo4j -p <password> -d system -f cypher/00_security_setup.cypher
```
Sample data is idempotent (`MERGE` on `id`), except cookbook section Q
(`03_sample_queries.cypher`), which intentionally uses `CREATE` and will
duplicate nodes if re-run.

## Architecture

**No backend.** The app talks Bolt-over-WebSocket directly from the browser
to Neo4j via `neo4j-driver`. Database credentials therefore live in the
browser tab; see `app/src/lib/neo4j.js` for the note on why this is fine for
a local/demo tool but not beyond that.

**Data model source of truth is the README** (section 1: node labels,
relationships, and the reasoning behind denormalized properties like
`Server.environment` alongside the `IN_ENVIRONMENT` relationship, and why
`:Data` is split out from `:Application`). Read it before adding
labels/relationships — most modeling questions are already answered there.

**Auth/authorization is entirely Neo4j's**, not app-level. The app signs in
with whatever Bolt credentials the user provides, then calls `SHOW CURRENT
USER` (against the `system` db) to infer one of 4 UI profiles — `readonly`
< `operator` < `superuser` < `admin`, each a superset of the one before it —
via `getCurrentUserProfile`/`deriveCmdbProfile` in `app/src/lib/neo4j.js`.
`ConnectionContext.jsx` turns that into four booleans consumed everywhere
else: `canWrite` (everything above `readonly` — gates business-screen
create/edit/delete), `canAccessGraphExplorer` (`superuser` and `admin` —
matches the role's DB-level schema-evolution privileges, `NAME MANAGEMENT`/
`INDEX MANAGEMENT`/`CONSTRAINT MANAGEMENT`, still granted by
`cypher/00_security_setup.cypher`, which is what Graph Explorer's "+ Node"/
"+ Relationship" forms actually need), and two `admin`-only ones —
`canManageUsers`, `canAccessBackupRestore`. `operator` therefore gets
`canWrite` and nothing from the "Admin" sidebar group; `superuser` gets
`canWrite` plus Graph Explorer; `admin` gets everything. All four booleans
only control what the UI *offers* (hiding menus/buttons, redirecting away
from `/graph`, `/users`, or `/backup-restore`); detection deliberately
fails open to `admin` on ambiguous/undetectable roles, because the actual
boundary is Neo4j's `GRANT`/`DENY` privileges
(`cypher/00_security_setup.cypher`), which reject unauthorized writes or
user-management calls regardless of what the client attempted. Community
Edition has no custom roles, so every session there resolves to `admin`.

**First-login / CHANGE REQUIRED password change**: `ConnectionContext.jsx`'s
`connect()` treats Neo4j's `Neo.ClientError.Security.CredentialsExpired`
status specially (`isCredentialsExpiredError` in `app/src/lib/neo4j.js`) —
auth succeeded but every query except the self-service `ALTER CURRENT USER
SET PASSWORD FROM $old TO $new` is rejected until a new password is set.
Rather than surfacing that as a generic connection error, it stashes the
attempted credentials as `pendingCredentials`/exposes `passwordChangeRequired`,
and `ConnectionPanel.jsx` swaps the sign-in form for a password-change form.
`changePassword()` runs the `ALTER CURRENT USER` query, then calls
`connect()`'s driver-creation path again with the new password before
resuming the normal sign-in sequence — necessary because the old password
is invalid immediately and the existing driver's auth token still has it.

**User management** (`admin` only): `UserManagementPage.jsx` calls
`fetchUsers`/`createUser`/`setUserRole`/`setUserPassword`/`deleteUser` in
`app/src/lib/neo4j.js`, which run `SHOW USERS`/`CREATE USER`/`ALTER USER`/
`DROP USER`/`GRANT ROLE`/`REVOKE ROLE` against the `system` database.
Unlike labels/relationship types, administration commands support
parameters for usernames and role names, so these are plain parameterized
Cypher — no identifier allow-list needed (that's only for the Cypher-pattern
case in `assertValidIdentifier` below).

**Cypher injection guard**: labels and relationship types can't be
parameterized in Cypher, so anywhere they're interpolated into a query
string, they first go through `assertValidIdentifier` in
`app/src/lib/neo4j.js` (allow-list regex, then backtick-quoted). Any new
code path that builds Cypher with a dynamic label/rel-type must go through
this same guard.

**`app/src/lib/nodeTypes.js` is the registry that drives the business
screens** — one entry per node type declaring its labels, table columns,
form fields (with input type / options / required / readOnlyOnEdit), and
relationships (type, direction, cardinality, target label restriction for
autocomplete). `EntityListScreen.jsx` (list/search/CSV export/CSV import)
and `EntityFormModal.jsx` (create/edit with relationship-picker autocomplete
against the `cmdb_fulltext` index) are both generic components driven
entirely by this registry — adding a new business screen means adding one
entry here, not writing a new screen or route. `Sidebar.jsx` also reads this
registry to build its grouped menu, filtered by `MenuPrefsContext.jsx`'s
per-browser `localStorage` hidden-types set (`MenuSettingsPage.jsx` is the
UI for it — a display preference, not a permission; a hidden type is still
reachable by URL).

**`EntityFormModal.jsx`'s `readOnly` prop** turns the same create/edit modal
into a view-only one, rather than the caller rendering a different
component: every `ScalarField` gets `disabled`, relationship chips drop
their remove button and the `NodeAutocomplete` picker doesn't render, the
title switches to "View `<Type>`", and Cancel disappears in favor of a
single Save→"Close" submit button whose handler short-circuits to
`onClose()` before touching `buildProperties`/`createNode`/`updateNodeProperties` at
all. `EntityListScreen.jsx` always renders that row button (unlike Delete,
which stays `canWrite`-gated), labeled "Edit"/"View" based on `canWrite` to
match, and passes `readOnly={!canWrite}` — so a read-only profile can still
open and inspect a node's full detail/relationships
through the familiar edit form, just without any way to change it.

**CSV import/export is layered so single-type and bulk paths share code**:
`app/src/lib/formUtils.js` exports `buildProperties` (form-value → property
coercion: number/date/datetime), used by both `EntityFormModal.jsx`'s
manual Create/Edit and `app/src/lib/csvImport.js`'s `importNodesFromCsvText`
(one `createNode` call per CSV row, scoped to `typeDef.fields` — no
relationship import, since there's no autocomplete to resolve a spreadsheet
cell against). CSV headers are matched against `typeDef.fields` by key or
by label, case-insensitively, so both "Get CSV template" output (keys) and
"Export CSV" output (labels) import cleanly. `csvImport.js` also exports
`importRelationshipsFromCsvText` (`relType,fromId,toId` rows, matched by
the `id` property via `createRelationshipByBusinessId` in `neo4j.js` — not
elementId, since a CSV cell has no live elementId to reference). `EntityListScreen.jsx`
(single type) and `app/src/lib/backup.js` (multiple types at once, zipped
with `jszip` — `BackupRestorePage.jsx`) both call into this same
`csvImport.js` layer rather than duplicating the row-loop/validation logic.

**State/routing**: `ConnectionContext.jsx` (React context) holds the driver
connection, detected profile, and cached schema (`knownLabels`/`knownTypes`
from `db.labels()`/`db.relationshipTypes()`, refreshed via
`refreshSchema()` after schema-changing writes). Routing is `HashRouter`-based
client-side only (`#/graph`, `#/type/:typeKey`, `#/users`, `#/menu-settings`,
`#/backup-restore`), so the app works from a static file server with no
server-side rewrite rules. `App.jsx` redirects `/graph`, `/users`, and
`/backup-restore` away to the first business screen for profiles that can't
reach them (`/graph` requires `superuser` or `admin`; `/users` and
`/backup-restore` require `admin`), so gating isn't just a hidden
`Sidebar.jsx` link; `/menu-settings` is the one unguarded route — every
profile can reach it, since it's a display preference, not a permission.
Every page in `App.jsx`'s route table is `React.lazy()`-imported (wrapped
in one `<Suspense>` around `<Routes>`), not statically imported — this is
what keeps the entry chunk small (~40kB vs. a single ~2.7MB bundle
everyone downloaded on first load, back when every page/dependency was
eager). `lib/backup.js` dynamically `import()`s `jszip` itself too, for
the same reason. **New pages should follow this pattern** (`lazy(() =>
import('./pages/Whatever.jsx'))`), especially any that pull in a large
dependency. `vite.config.js`'s `manualChunks` additionally splits
react/react-dom/react-router-dom and `neo4j-driver` into their own
vendor chunks (cached independently of app code, which changes far more
often); `@neo4j-nvl` and `jszip` don't need a manual entry since they're
only ever reached through the dynamic imports above and Rollup already
isolates them into their own chunks (`GraphView-*.js`, `jszip.min-*.js`)
for that reason alone.

**Graph Explorer vs. business screens**: `GraphExplorerPage.jsx` is free-form
— preset/typed Cypher queries rendered on an NVL canvas, with an Inspector
for ad hoc property/label edits and node/relationship creation. The
per-type business screens are the structured, registry-driven counterpart
(list/search/create/edit/export/import). Both gate write UI on
`useConnection().canWrite`, and both ultimately call the same functions in
`app/src/lib/neo4j.js`. `Sidebar.jsx` renders business-screen categories
first, then one more category, "Admin", styled identically (same
`.sidebar-group`/`<h4>` markup as a `NODE_TYPE_CATEGORIES` entry, not
visually called out) holding Graph Explorer (rendered for `superuser` and
`admin`), Manage Users and Backup & Restore (rendered for `admin` only),
plus Menu Settings (always rendered) — see section 3/4 in the README for
why.

**`DetailGraphModal.jsx`** implements outward graph-walking from a business
screen row (1-hop neighborhood, then merge in more on each node click) via
`fetchNeighborhood`/`fetchFilteredNeighborhood`/`fetchNeighborhoodTypes` in
`neo4j.js` — it's read-only/exploratory, not an editor.
