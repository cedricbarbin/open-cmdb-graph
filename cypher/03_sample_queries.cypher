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
// E. NETWORK / IPAM
// ---------------------------------------------------------------------

// E1. Full NIC + IP inventory for a physical host
MATCH (s:Server:Physical {id: 'srv-phy-001'})-[:HAS_INTERFACE]->(nic:NetworkInterface)-[:HAS_IP]->(ip:IPAddress)
RETURN s.hostname AS host, nic.name AS interface, nic.type AS interfaceType, ip.address AS ipAddress;

// E2. Reverse lookup: which server/interface owns a given IP address
MATCH (ip:IPAddress {address: '10.20.1.111'})<-[:HAS_IP]-(nic:NetworkInterface)<-[:HAS_INTERFACE]-(s:Server)
RETURN s.hostname AS server, nic.name AS interface, ip.address AS ipAddress;

// E3. All management interfaces (iDRAC/iLO) across the estate, for a firewall/VLAN audit
MATCH (s:Server)-[:HAS_INTERFACE]->(nic:NetworkInterface {type: 'management'})-[:HAS_IP]->(ip:IPAddress)
RETURN s.hostname AS server, nic.name AS interface, ip.address AS ipAddress
ORDER BY server;

// ---------------------------------------------------------------------
// F. VENDORS / CONTRACTS (asset & warranty tracking)
// ---------------------------------------------------------------------

// F1. Which vendor supplied and covers each physical server
MATCH (s:Server:Physical)-[:SUPPLIED_BY]->(v:Vendor)
OPTIONAL MATCH (s)-[:COVERED_BY]->(c:Contract)
RETURN s.hostname AS server, s.model AS model, v.name AS vendor,
       c.contractNumber AS contract, c.endDate AS contractEnd
ORDER BY contractEnd;

// F2. Contracts that have already expired or expire within 90 days (renewal risk)
MATCH (c:Contract)<-[:COVERED_BY]-(s:Server)
WHERE c.endDate <= date() + duration('P90D')
RETURN c.contractNumber AS contract, c.endDate AS endDate,
       CASE WHEN c.endDate < date() THEN 'EXPIRED' ELSE 'EXPIRING_SOON' END AS status,
       collect(s.hostname) AS coveredServers
ORDER BY endDate;

// F3. Total contract spend per vendor
MATCH (v:Vendor)<-[:PROVIDED_BY]-(c:Contract)
RETURN v.name AS vendor, count(c) AS contracts, sum(c.cost) AS totalCost, head(collect(c.currency)) AS currency;

// ---------------------------------------------------------------------
// G. CHANGE MANAGEMENT
// ---------------------------------------------------------------------

// G1. Upcoming/scheduled changes (a simple change calendar)
MATCH (c:ChangeRequest)
WHERE c.status IN ['approved', 'scheduled']
OPTIONAL MATCH (c)-[:CONCERNS]->(res)
RETURN c.id AS change, c.title AS title, c.riskLevel AS risk,
       c.scheduledStart AS start, c.scheduledEnd AS end, res.name AS concerns
ORDER BY start;

// G2. High-risk changes still in draft (need review before they can be scheduled)
MATCH (c:ChangeRequest {status: 'draft'})
WHERE c.riskLevel IN ['high', 'medium']
OPTIONAL MATCH (c)-[:REQUESTED_BY]->(requester:Person)
RETURN c.id AS change, c.title AS title, c.riskLevel AS risk, requester.name AS requestedBy;

// G3. Full approval chain for a change request
MATCH (c:ChangeRequest {id: 'chg-2026-0001'})
OPTIONAL MATCH (c)-[:REQUESTED_BY]->(requester:Person)
OPTIONAL MATCH (c)-[:APPROVED_BY]->(approver:Person)
OPTIONAL MATCH (c)-[:CONCERNS]->(res)
OPTIONAL MATCH (t:Ticket)-[:RELATES_TO]->(c)
RETURN c.title AS change, requester.name AS requestedBy, approver.name AS approvedBy,
       res.name AS concerns, collect(t.id) AS linkedTickets;

// ---------------------------------------------------------------------
// H. ENVIRONMENTS / SLAs
// ---------------------------------------------------------------------

// H1. Everything running in staging (first-class Environment node, not a property filter)
MATCH (e:Environment {name: 'staging'})<-[:IN_ENVIRONMENT]-(res)
OPTIONAL MATCH (res)<-[:RUNS_ON]-(ctr:Container)
RETURN e.name AS environment, res, collect(ctr) AS containers;

// H2. SLA compliance view: applications, their SLA target, and any open incidents against them
MATCH (a:Application)-[:HAS_SLA]->(sla:SLA)
OPTIONAL MATCH (a)<-[:IMPACTS]-(i:Incident) WHERE i.status IN ['open', 'investigating']
RETURN a.name AS application, sla.name AS slaTier, sla.uptimeTargetPct AS uptimeTarget,
       count(i) AS openIncidents
ORDER BY sla.uptimeTargetPct DESC;

// H3. Move an application (and everything it depends on operationally) into a new environment
// - illustrates that Environment membership is just a relationship to re-target
MATCH (a:Application {id: 'app-crm'})
MATCH (e:Environment {name: 'staging'})
MERGE (a)-[:IN_ENVIRONMENT]->(e);

// ---------------------------------------------------------------------
// I. DATA & CLASSIFICATION
// ---------------------------------------------------------------------

// I1. Full data footprint of an application: what it owns vs. merely consumes
MATCH (a:Application {id: 'app-orderapi'})
OPTIONAL MATCH (a)-[:OWNS_DATA]->(owned:Data)
OPTIONAL MATCH (a)-[:CONSUMES_DATA]->(consumed:Data)
RETURN a.name AS application, collect(DISTINCT owned.name) AS ownsData, collect(DISTINCT consumed.name) AS consumesData;

// I2. Data lineage for one data asset: who owns it, and every other app that reads it
MATCH (d:Data {id: 'data-customers'})
OPTIONAL MATCH (owner:Application)-[:OWNS_DATA]->(d)
OPTIONAL MATCH (consumer:Application)-[:CONSUMES_DATA]->(d)
RETURN d.name AS data, owner.name AS systemOfRecord, collect(DISTINCT consumer.name) AS alsoConsumedBy;

// I3. Regulatory/compliance audit: every application that touches PII or credentials,
//     whether as owner or consumer
MATCH (a:Application)-[r:OWNS_DATA|CONSUMES_DATA]->(d:Data)-[:CLASSIFIED_AS]->(cat:DataCategory)
WHERE cat.regulatoryScope <> 'none'
RETURN DISTINCT a.name AS application, d.name AS data, type(r) AS relationship,
       cat.name AS category, cat.regulatoryScope AS regulation
ORDER BY regulation, application;

// I4. Data classification breakdown: how many data assets per sensitivity tier
MATCH (d:Data)-[:CLASSIFIED_AS]->(cat:DataCategory)
RETURN cat.sensitivity AS sensitivity, collect(DISTINCT cat.name) AS categories, count(DISTINCT d) AS dataAssets
ORDER BY CASE sensitivity WHEN 'restricted' THEN 0 WHEN 'confidential' THEN 1 WHEN 'internal' THEN 2 ELSE 3 END;

// I5. Data-aware blast radius: if a server goes down, which data assets (and their
//     classification) are affected, and which applications rely on that data
MATCH (s:Server {id: 'vm-app-01'})<-[:STORED_ON]-(d:Data)
OPTIONAL MATCH (d)-[:CLASSIFIED_AS]->(cat:DataCategory)
OPTIONAL MATCH (d)<-[:OWNS_DATA|CONSUMES_DATA]-(a:Application)
RETURN s.hostname AS server, d.name AS data, collect(DISTINCT cat.name) AS categories,
       collect(DISTINCT a.name) AS affectedApplications;

// I6. Incidents/tickets that were actually about data (not just infrastructure)
MATCH (d:Data)<-[:IMPACTS]-(i:Incident)
OPTIONAL MATCH (d)<-[:CONCERNS]-(t:Ticket)
RETURN d.name AS data, i.title AS incident, i.severity AS severity, collect(DISTINCT t.id) AS tickets;

// ---------------------------------------------------------------------
// J. WRITE OPERATIONS (create / update / delete)
// These mirror what the web app does through its Add/Edit/Delete forms.
// ---------------------------------------------------------------------

// J1. Create a new physical server
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

// J2. Attach it to a location
MATCH (s:Server {id: 'srv-phy-005'}), (l:Location {id: 'loc-dc-par1'})
MERGE (s)-[:LOCATED_IN]->(l);

// J3. Create a new Virtual server hosted on it, in one statement
MATCH (host:Server:Physical {id: 'srv-phy-005'})
CREATE (vm:Server:Virtual {
  id: 'vm-web-03', hostname: 'web-03.prod.local', ipAddress: '10.10.2.13',
  os: 'Ubuntu', osVersion: '22.04', status: 'active', environment: 'prod',
  cpuCores: 4, ramGB: 16, diskGB: 100, hypervisor: 'ESXi', vCpu: 4
})-[:HOSTED_ON]->(host)
RETURN vm;

// J4. Generic "add node with arbitrary label + properties" (what the app's
// Add Node form runs; label & props come from user input, id always required)
// :params { label: 'Application', props: { id: 'app-newsvc', name: 'New Service', criticality: 'low' } }
CALL apoc.merge.node([$label], {id: $props.id}, $props, $props) YIELD node
RETURN node;
// NOTE: this one example uses APOC for a fully dynamic label; the app itself
// avoids APOC by building the label into the query string safely (see
// app/src/lib/neo4j.js) since the target Neo4j instance may not have it.

// J5. Generic "add relationship between two existing nodes by id"
MATCH (a {id: $fromId}), (b {id: $toId})
CALL apoc.merge.relationship(a, $relType, {}, $props, b) YIELD rel
RETURN rel;
// Same remark as J4 - see app/src/lib/neo4j.js for the APOC-free equivalent.

// J6. Update a node's properties (partial update / PATCH semantics)
MATCH (a:Application {id: 'app-orderapi'})
SET a.version = '2.5.0', a.criticality = 'critical', a.updatedAt = datetime()
RETURN a;

// J7. Update a relationship's properties
MATCH (:Application {id: 'app-orderapi'})-[r:DEPENDS_ON]->(:Application {id: 'app-authsvc'})
SET r.type = 'synchronous', r.timeoutMs = 2000
RETURN r;

// J8. Close a ticket and resolve its linked incident
MATCH (t:Ticket {id: 'tkt-1004'})
SET t.status = 'resolved', t.updatedAt = datetime()
WITH t
MATCH (t)-[:TRACKS]->(i:Incident)
SET i.status = 'resolved', i.resolvedAt = datetime();

// J9. Move a VM to a different physical host (replace a relationship)
MATCH (vm:Server:Virtual {id: 'vm-app-02'})-[r:HOSTED_ON]->(:Server:Physical)
DELETE r
WITH vm
MATCH (newHost:Server:Physical {id: 'srv-phy-001'})
MERGE (vm)-[:HOSTED_ON]->(newHost);

// J10. Decommission a server: detach then delete (keeps history-free graph tidy)
MATCH (s:Server {id: 'srv-phy-005'})
DETACH DELETE s;

// J11. Delete a single relationship between two known nodes
MATCH (:Application {id: 'app-crm'})-[r:DEPENDS_ON]->(:Application {id: 'app-authsvc'})
DELETE r;

// J12. Create an incident + link it to affected resources + reporter in one go
MATCH (reporter:Person {id: 'p-eve'})
MATCH (target:Server {id: 'srv-phy-004'})
CREATE (i:Incident {
  id: 'inc-2026-0005', title: 'Backup job failures on bkp-lyon1-01',
  description: 'Nightly backup job has failed 3 nights in a row',
  severity: 'SEV3', status: 'open', createdAt: datetime(), resolvedAt: null
})-[:IMPACTS]->(target)
CREATE (i)-[:REPORTED_BY]->(reporter)
RETURN i;

// J13. Open a ticket against that incident and assign it
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
