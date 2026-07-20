// =====================================================================
// CMDB Graph Model - Query cookbook
// A grab-bag of read / write / update / delete Cypher used by the app
// and useful on their own from Neo4j Browser or cypher-shell.
// =====================================================================

// ---------------------------------------------------------------------
// A. DISCOVERY / OVERVIEW
// ---------------------------------------------------------------------

// A1. Whole graph, capped (used as the app's default view)
MATCH (n)-[r]-(m)
RETURN n, r, m
LIMIT 150;

// A2. Count nodes per label
MATCH (n)
RETURN labels(n) AS labels, count(*) AS total
ORDER BY total DESC;

// A3. Count relationships per type
MATCH ()-[r]->()
RETURN type(r) AS relType, count(*) AS total
ORDER BY total DESC;

// A4. Full text search across the CMDB (uses cmdb_fulltext index)
CALL db.index.fulltext.queryNodes('cmdb_fulltext', 'order*')
YIELD node, score
RETURN node, score
ORDER BY score DESC
LIMIT 20;

// ---------------------------------------------------------------------
// B. LOCATIONS / INFRASTRUCTURE TOPOLOGY
// ---------------------------------------------------------------------

// B1. Everything physically hosted in a given datacenter
MATCH (loc:Location {id: 'loc-dc-par1'})<-[:LOCATED_IN]-(physical:Server)
OPTIONAL MATCH (vm:Server:Virtual)-[:HOSTED_ON]->(physical)
RETURN loc, physical, collect(vm) AS virtualMachines;

// B2. Full stack for a cloud region: region -> VM -> containers -> apps
MATCH (loc:Location:CloudRegion {id: 'loc-aws-euw1'})<-[:LOCATED_IN]-(vm:Server)
OPTIONAL MATCH (vm)<-[:RUNS_ON]-(ctr:Container)<-[:DEPLOYED_ON]-(app:Application)
RETURN loc, vm, ctr, app;

// B3. Capacity summary per physical host: how many VMs, total vCPU/RAM allocated
MATCH (host:Server:Physical)
OPTIONAL MATCH (vm:Server:Virtual)-[:HOSTED_ON]->(host)
RETURN host.hostname AS host,
       host.cpuCores AS hostCpu, host.ramGB AS hostRam,
       count(vm) AS vmCount,
       sum(vm.vCpu) AS allocatedVcpu,
       sum(vm.ramGB) AS allocatedRamGB
ORDER BY host;

// ---------------------------------------------------------------------
// C. APPLICATION TOPOLOGY / DEPENDENCIES
// ---------------------------------------------------------------------

// C1. Full deployment path for one application: app -> container -> VM -> host -> location
MATCH (app:Application {id: 'app-orderapi'})-[:DEPLOYED_ON]->(ctr:Container)-[:RUNS_ON]->(vm:Server)
OPTIONAL MATCH (vm)-[:HOSTED_ON]->(host:Server:Physical)-[:LOCATED_IN]->(loc:Location)
OPTIONAL MATCH (vm)-[:LOCATED_IN]->(cloudLoc:Location:CloudRegion)
RETURN app, ctr, vm, host, coalesce(loc, cloudLoc) AS location;

// C2. Application dependency graph (who depends on whom, transitively)
MATCH path = (app:Application {id: 'app-webportal'})-[:DEPENDS_ON*1..5]->(dep:Application)
RETURN path;

// C3. Reverse dependency / "blast radius": what breaks if app-authsvc goes down?
MATCH (victim:Application {id: 'app-authsvc'})<-[:DEPENDS_ON*1..5]-(impacted:Application)
RETURN DISTINCT impacted.name AS impactedApplication, impacted.criticality AS criticality
ORDER BY criticality DESC;

// C4. Applications owned by a team, with their criticality
MATCH (t:Team {id: 'team-appdev'})-[:OWNS]->(app:Application)
RETURN t.name AS team, app.name AS application, app.criticality AS criticality
ORDER BY criticality DESC;

// ---------------------------------------------------------------------
// D. INCIDENT / TICKET MANAGEMENT
// ---------------------------------------------------------------------

// D1. All open/investigating incidents with what they impact
MATCH (i:Incident)
WHERE i.status IN ['open', 'investigating']
OPTIONAL MATCH (i)-[:IMPACTS]->(affected)
RETURN i.id AS incident, i.title AS title, i.severity AS severity,
       collect(affected.name) AS impacts
ORDER BY i.severity;

// D2. Blast radius of an incident: every Application reachable from what it impacts
MATCH (i:Incident {id: 'inc-2026-0002'})-[:IMPACTS]->(res)
OPTIONAL MATCH (res)<-[:DEPLOYED_ON|RUNS_ON|HOSTED_ON*0..3]-(downstream:Application)
RETURN i.title AS incident, collect(DISTINCT coalesce(downstream.name, res.name)) AS affectedApplications;

// D3. Tickets currently assigned to a person, sorted by priority
MATCH (p:Person {id: 'p-bob'})<-[:ASSIGNED_TO]-(t:Ticket)
WHERE t.status <> 'closed'
RETURN t.id AS ticket, t.title AS title, t.priority AS priority, t.status AS status
ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END;

// D4. Mean time to resolve (MTTR) per severity, in minutes
MATCH (i:Incident)
WHERE i.resolvedAt IS NOT NULL
RETURN i.severity AS severity,
       avg(duration.inSeconds(i.createdAt, i.resolvedAt).seconds) / 60.0 AS mttrMinutes
ORDER BY severity;

// D5. Ticket + incident + concerned resource + assignee, one row per ticket
MATCH (t:Ticket)
OPTIONAL MATCH (t)-[:TRACKS]->(i:Incident)
OPTIONAL MATCH (t)-[:CONCERNS]->(res)
OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(assignee:Person)
RETURN t.id AS ticket, t.title AS title, t.status AS status, t.priority AS priority,
       i.id AS relatedIncident, res.name AS concerns, assignee.name AS assignee
ORDER BY t.createdAt DESC;

// D6. All incidents ever reported against a given server/app/container
MATCH (res {id: 'app-authsvc'})<-[:IMPACTS]-(i:Incident)
RETURN i.id AS incident, i.title AS title, i.severity AS severity, i.status AS status
ORDER BY i.createdAt DESC;

// ---------------------------------------------------------------------
// E. WRITE OPERATIONS (create / update / delete)
// These mirror what the web app does through its Add/Edit/Delete forms.
// ---------------------------------------------------------------------

// E1. Create a new physical server
CREATE (s:Server:Physical {
  id: 'srv-phy-005',
  hostname: 'hv-par1-03',
  ipAddress: '10.10.1.13',
  os: 'VMware ESXi',
  osVersion: '8.0',
  status: 'active',
  environment: 'prod',
  cpuCores: 64,
  ramGB: 512,
  diskGB: 8000,
  vendor: 'Dell',
  model: 'PowerEdge R740',
  serialNumber: 'DL740-88233'
})
RETURN s;

// E2. Attach it to a location
MATCH (s:Server {id: 'srv-phy-005'}), (l:Location {id: 'loc-dc-par1'})
MERGE (s)-[:LOCATED_IN]->(l);

// E3. Create a new Virtual server hosted on it, in one statement
MATCH (host:Server:Physical {id: 'srv-phy-005'})
CREATE (vm:Server:Virtual {
  id: 'vm-web-03', hostname: 'web-03.prod.local', ipAddress: '10.10.2.13',
  os: 'Ubuntu', osVersion: '22.04', status: 'active', environment: 'prod',
  cpuCores: 4, ramGB: 16, diskGB: 100, hypervisor: 'ESXi', vCpu: 4
})-[:HOSTED_ON]->(host)
RETURN vm;

// E4. Generic "add node with arbitrary label + properties" (what the app's
// Add Node form runs; label & props come from user input, id always required)
// :params { label: 'Application', props: { id: 'app-newsvc', name: 'New Service', criticality: 'low' } }
CALL apoc.merge.node([$label], {id: $props.id}, $props, $props) YIELD node
RETURN node;
// NOTE: this one example uses APOC for a fully dynamic label; the app itself
// avoids APOC by building the label into the query string safely (see
// app/src/lib/neo4j.js) since the target Neo4j instance may not have it.

// E5. Generic "add relationship between two existing nodes by id"
MATCH (a {id: $fromId}), (b {id: $toId})
CALL apoc.merge.relationship(a, $relType, {}, $props, b) YIELD rel
RETURN rel;
// Same remark as E4 - see app/src/lib/neo4j.js for the APOC-free equivalent.

// E6. Update a node's properties (partial update / PATCH semantics)
MATCH (a:Application {id: 'app-orderapi'})
SET a.version = '2.5.0', a.criticality = 'critical', a.updatedAt = datetime()
RETURN a;

// E7. Update a relationship's properties
MATCH (:Application {id: 'app-orderapi'})-[r:DEPENDS_ON]->(:Application {id: 'app-authsvc'})
SET r.type = 'synchronous', r.timeoutMs = 2000
RETURN r;

// E8. Close a ticket and resolve its linked incident
MATCH (t:Ticket {id: 'tkt-1004'})
SET t.status = 'resolved', t.updatedAt = datetime()
WITH t
MATCH (t)-[:TRACKS]->(i:Incident)
SET i.status = 'resolved', i.resolvedAt = datetime();

// E9. Move a VM to a different physical host (replace a relationship)
MATCH (vm:Server:Virtual {id: 'vm-app-02'})-[r:HOSTED_ON]->(:Server:Physical)
DELETE r
WITH vm
MATCH (newHost:Server:Physical {id: 'srv-phy-001'})
MERGE (vm)-[:HOSTED_ON]->(newHost);

// E10. Decommission a server: detach then delete (keeps history-free graph tidy)
MATCH (s:Server {id: 'srv-phy-005'})
DETACH DELETE s;

// E11. Delete a single relationship between two known nodes
MATCH (:Application {id: 'app-crm'})-[r:DEPENDS_ON]->(:Application {id: 'app-authsvc'})
DELETE r;

// E12. Create an incident + link it to affected resources + reporter in one go
MATCH (reporter:Person {id: 'p-eve'})
MATCH (target:Server {id: 'srv-phy-004'})
CREATE (i:Incident {
  id: 'inc-2026-0005', title: 'Backup job failures on bkp-lyon1-01',
  description: 'Nightly backup job has failed 3 nights in a row',
  severity: 'SEV3', status: 'open', createdAt: datetime(), resolvedAt: null
})-[:IMPACTS]->(target)
CREATE (i)-[:REPORTED_BY]->(reporter)
RETURN i;

// E13. Open a ticket against that incident and assign it
MATCH (i:Incident {id: 'inc-2026-0005'}), (assignee:Person {id: 'p-alice'}), (opener:Person {id: 'p-eve'})
CREATE (t:Ticket {
  id: 'tkt-1006', title: 'Fix nightly backup failures', description: 'See inc-2026-0005',
  type: 'incident', status: 'open', priority: 'high',
  createdAt: datetime(), updatedAt: datetime(), dueDate: date() + duration('P3D')
})-[:TRACKS]->(i)
CREATE (t)-[:CONCERNS]->(i)
CREATE (t)-[:ASSIGNED_TO]->(assignee)
CREATE (t)-[:OPENED_BY]->(opener)
RETURN t;
