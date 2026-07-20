// =====================================================================
// CMDB Graph Model - Sample data
// Run after 01_constraints_and_indexes.cypher
// Idempotent: uses MERGE on the unique "id" property throughout.
// =====================================================================

// ---------------------------------------------------------------------
// 1. LOCATIONS (Datacenter / CloudRegion)
// ---------------------------------------------------------------------
UNWIND [
  {id:'loc-dc-par1',   name:'Paris DC1',           type:'Datacenter', provider:'OVHcloud', city:'Paris', country:'FR', address:'2 Rue Kellermann, 91120 Paris', tier:'III'},
  {id:'loc-dc-lyon1',  name:'Lyon DC1',             type:'Datacenter', provider:'Self-hosted', city:'Lyon', country:'FR', address:'12 Avenue Rockefeller, 69008 Lyon', tier:'III'}
] AS row
MERGE (l:Location:Datacenter {id: row.id})
SET l += row;

UNWIND [
  {id:'loc-aws-euw1',  name:'AWS eu-west-1',        type:'CloudRegion', provider:'AWS',   region:'eu-west-1',      country:'IE'},
  {id:'loc-az-frc',    name:'Azure France Central', type:'CloudRegion', provider:'Azure', region:'francecentral', country:'FR'}
] AS row
MERGE (l:Location:CloudRegion {id: row.id})
SET l += row;

// ---------------------------------------------------------------------
// 2. SERVERS (Physical hosts + Virtual machines)
// ---------------------------------------------------------------------
UNWIND [
  {id:'srv-phy-001', hostname:'hv-par1-01', ipAddress:'10.10.1.11', os:'VMware ESXi',  osVersion:'8.0', status:'active', environment:'prod', cpuCores:64,  ramGB:512,  diskGB:8000,  vendor:'Dell',  model:'PowerEdge R740', serialNumber:'DL740-88231', rackPosition:'A12-U10', purchaseDate:'2023-02-15', warrantyEnd:'2027-02-15'},
  {id:'srv-phy-002', hostname:'hv-par1-02', ipAddress:'10.10.1.12', os:'VMware ESXi',  osVersion:'8.0', status:'active', environment:'prod', cpuCores:64,  ramGB:512,  diskGB:8000,  vendor:'Dell',  model:'PowerEdge R740', serialNumber:'DL740-88232', rackPosition:'A12-U14', purchaseDate:'2023-02-15', warrantyEnd:'2027-02-15'},
  {id:'srv-phy-003', hostname:'hv-lyon1-01',ipAddress:'10.20.1.11', os:'VMware ESXi',  osVersion:'7.0', status:'active', environment:'prod', cpuCores:48,  ramGB:384,  diskGB:12000, vendor:'HPE',   model:'ProLiant DL380', serialNumber:'HPE380-55120', rackPosition:'B03-U04', purchaseDate:'2021-06-01', warrantyEnd:'2026-06-01'},
  {id:'srv-phy-004', hostname:'bkp-lyon1-01',ipAddress:'10.20.1.20',os:'Debian',       osVersion:'12',  status:'active', environment:'prod', cpuCores:16,  ramGB:64,   diskGB:40000, vendor:'HPE',   model:'ProLiant DL380', serialNumber:'HPE380-55121', rackPosition:'B03-U08', purchaseDate:'2021-06-01', warrantyEnd:'2026-06-01'}
] AS row
MERGE (s:Server:Physical {id: row.id})
SET s += row;

UNWIND [
  {id:'vm-web-01',  hostname:'web-01.prod.local',  ipAddress:'10.10.2.11', os:'Ubuntu', osVersion:'22.04', status:'active', environment:'prod', cpuCores:4, ramGB:16, diskGB:100, hypervisor:'ESXi', vCpu:4},
  {id:'vm-web-02',  hostname:'web-02.prod.local',  ipAddress:'10.10.2.12', os:'Ubuntu', osVersion:'22.04', status:'active', environment:'prod', cpuCores:4, ramGB:16, diskGB:100, hypervisor:'ESXi', vCpu:4},
  {id:'vm-app-01',  hostname:'app-01.prod.local',  ipAddress:'10.10.2.21', os:'Ubuntu', osVersion:'22.04', status:'active', environment:'prod', cpuCores:8, ramGB:32, diskGB:200, hypervisor:'ESXi', vCpu:8},
  {id:'vm-app-02',  hostname:'app-02.prod.local',  ipAddress:'10.10.2.22', os:'Ubuntu', osVersion:'22.04', status:'active', environment:'prod', cpuCores:8, ramGB:32, diskGB:200, hypervisor:'ESXi', vCpu:8},
  {id:'vm-db-01',   hostname:'db-01.prod.local',   ipAddress:'10.20.2.11', os:'Rocky Linux', osVersion:'9', status:'active', environment:'prod', cpuCores:16, ramGB:128, diskGB:2000, hypervisor:'ESXi', vCpu:16},
  {id:'vm-cloud-api-01', hostname:'ip-10-0-1-101.eu-west-1.compute.internal', ipAddress:'10.0.1.101', os:'Amazon Linux', osVersion:'2023', status:'active', environment:'prod', cpuCores:4, ramGB:16, diskGB:80, hypervisor:'AWS Nitro', vCpu:4},
  {id:'vm-cloud-api-02', hostname:'ip-10-0-1-102.eu-west-1.compute.internal', ipAddress:'10.0.1.102', os:'Amazon Linux', osVersion:'2023', status:'active', environment:'prod', cpuCores:4, ramGB:16, diskGB:80, hypervisor:'AWS Nitro', vCpu:4},
  {id:'vm-cloud-worker-01', hostname:'vm-worker-01.francecentral.cloudapp.azure.com', ipAddress:'10.1.1.10', os:'Ubuntu', osVersion:'22.04', status:'active', environment:'prod', cpuCores:4, ramGB:16, diskGB:120, hypervisor:'Azure Hyper-V', vCpu:4}
] AS row
MERGE (v:Server:Virtual {id: row.id})
SET v += row;

// ---------------------------------------------------------------------
// 3. CONTAINERS
// ---------------------------------------------------------------------
UNWIND [
  {id:'ctr-web-nginx-01',    name:'nginx-frontend',   image:'nginx',        imageTag:'1.25-alpine', status:'running', ports:'80,443',  cpuLimit:1.0, memLimitMB:512},
  {id:'ctr-web-nginx-02',    name:'nginx-frontend',   image:'nginx',        imageTag:'1.25-alpine', status:'running', ports:'80,443',  cpuLimit:1.0, memLimitMB:512},
  {id:'ctr-app-api-01',      name:'order-api',        image:'order-api',    imageTag:'2.4.1',       status:'running', ports:'8080',    cpuLimit:2.0, memLimitMB:2048},
  {id:'ctr-app-api-02',      name:'order-api',        image:'order-api',    imageTag:'2.4.1',       status:'running', ports:'8080',    cpuLimit:2.0, memLimitMB:2048},
  {id:'ctr-app-auth-01',     name:'auth-service',     image:'auth-service', imageTag:'1.9.0',       status:'running', ports:'9000',    cpuLimit:1.5, memLimitMB:1024},
  {id:'ctr-cloud-api-01',    name:'cloud-api',        image:'cloud-api',    imageTag:'3.1.0',       status:'running', ports:'8443',    cpuLimit:2.0, memLimitMB:2048},
  {id:'ctr-cloud-api-02',    name:'cloud-api',        image:'cloud-api',    imageTag:'3.1.0',       status:'running', ports:'8443',    cpuLimit:2.0, memLimitMB:2048},
  {id:'ctr-worker-billing-01',name:'billing-worker',  image:'billing-worker',imageTag:'1.4.2',      status:'running', ports:'',        cpuLimit:1.0, memLimitMB:1024}
] AS row
MERGE (c:Container {id: row.id})
SET c += row;

// ---------------------------------------------------------------------
// 4. APPLICATIONS
// ---------------------------------------------------------------------
UNWIND [
  {id:'app-webportal', name:'Customer Web Portal', version:'4.2.0', criticality:'high',     environment:'prod', businessService:'E-commerce', description:'Public facing customer web portal'},
  {id:'app-orderapi',  name:'Order API',           version:'2.4.1', criticality:'critical', environment:'prod', businessService:'E-commerce', description:'Order management REST API'},
  {id:'app-authsvc',   name:'Auth Service',        version:'1.9.0', criticality:'critical', environment:'prod', businessService:'Platform',   description:'Central authentication & authorization service'},
  {id:'app-billing',   name:'Billing Worker',      version:'1.4.2', criticality:'high',     environment:'prod', businessService:'Finance',    description:'Asynchronous billing/invoicing worker'},
  {id:'app-crm',       name:'CRM',                 version:'9.1',   criticality:'medium',   environment:'prod', businessService:'Sales',      description:'Legacy customer relationship management app'},
  {id:'app-cloudapi',  name:'Public Cloud API',    version:'3.1.0', criticality:'critical', environment:'prod', businessService:'Platform',   description:'Public API gateway hosted in AWS'}
] AS row
MERGE (a:Application {id: row.id})
SET a += row;

// ---------------------------------------------------------------------
// 5. TEAMS & PEOPLE
// ---------------------------------------------------------------------
UNWIND [
  {id:'team-platform', name:'Platform Engineering', email:'platform-eng@example.com'},
  {id:'team-appdev',   name:'Application Development', email:'app-dev@example.com'},
  {id:'team-infra',    name:'Infrastructure & Datacenter', email:'infra@example.com'}
] AS row
MERGE (t:Team {id: row.id})
SET t += row;

UNWIND [
  {id:'p-alice', name:'Alice Martin',   email:'alice.martin@example.com',   role:'Infra Lead'},
  {id:'p-bob',   name:'Bob Durand',     email:'bob.durand@example.com',     role:'Backend Developer'},
  {id:'p-carol', name:'Carol Nguyen',   email:'carol.nguyen@example.com',   role:'SRE'},
  {id:'p-dave',  name:'Dave Petit',     email:'dave.petit@example.com',     role:'Developer'},
  {id:'p-eve',   name:'Eve Rousseau',   email:'eve.rousseau@example.com',   role:'Network Engineer'}
] AS row
MERGE (p:Person {id: row.id})
SET p += row;

// ---------------------------------------------------------------------
// 6. INCIDENTS & TICKETS
// ---------------------------------------------------------------------
UNWIND [
  {id:'inc-2026-0001', title:'Order API latency spike',        description:'p95 latency > 3s on order-api', severity:'SEV2', status:'resolved',      createdAt:datetime('2026-05-03T09:12:00Z'), resolvedAt:datetime('2026-05-03T11:45:00Z')},
  {id:'inc-2026-0002', title:'Auth Service outage',             description:'auth-service returning 503 for all requests', severity:'SEV1', status:'resolved', createdAt:datetime('2026-06-11T02:30:00Z'), resolvedAt:datetime('2026-06-11T03:55:00Z')},
  {id:'inc-2026-0003', title:'Disk space warning on hypervisor',description:'hv-lyon1-01 datastore usage above 90%', severity:'SEV3', status:'open', createdAt:datetime('2026-07-10T08:00:00Z'), resolvedAt:null},
  {id:'inc-2026-0004', title:'Cloud API 500 errors',            description:'Intermittent 500 errors on Public Cloud API', severity:'SEV2', status:'investigating', createdAt:datetime('2026-07-18T14:20:00Z'), resolvedAt:null}
] AS row
MERGE (i:Incident {id: row.id})
SET i += row;

UNWIND [
  {id:'tkt-1001', title:'Investigate order API latency',    description:'Root cause the p95 spike reported in inc-2026-0001', type:'incident', status:'resolved',    priority:'high',   createdAt:datetime('2026-05-03T09:15:00Z'), updatedAt:datetime('2026-05-03T11:50:00Z'), dueDate:null},
  {id:'tkt-1002', title:'Postmortem: auth outage',          description:'Write and review postmortem for inc-2026-0002', type:'incident', status:'resolved',    priority:'high',   createdAt:datetime('2026-06-11T04:00:00Z'), updatedAt:datetime('2026-06-13T09:00:00Z'), dueDate:null},
  {id:'tkt-1003', title:'Increase disk on hv-lyon1-01',     description:'Add datastore capacity before it fills up', type:'incident', status:'in_progress', priority:'medium', createdAt:datetime('2026-07-10T08:10:00Z'), updatedAt:datetime('2026-07-15T10:00:00Z'), dueDate:date('2026-07-25')},
  {id:'tkt-1004', title:'Fix Cloud API intermittent errors', description:'Investigate and fix 500 errors on cloud-api', type:'incident', status:'open',       priority:'urgent', createdAt:datetime('2026-07-18T14:25:00Z'), updatedAt:datetime('2026-07-18T14:25:00Z'), dueDate:date('2026-07-21')},
  {id:'tkt-1005', title:'Add monitoring to billing worker',  description:'No alerting configured yet for billing-worker', type:'request',  status:'open',       priority:'low',    createdAt:datetime('2026-07-16T10:00:00Z'), updatedAt:datetime('2026-07-16T10:00:00Z'), dueDate:date('2026-08-01')}
] AS row
MERGE (t:Ticket {id: row.id})
SET t += row;

// ---------------------------------------------------------------------
// 7. VENDORS & CONTRACTS (asset / warranty tracking for physical servers)
// ---------------------------------------------------------------------
UNWIND [
  {id:'vnd-dell', name:'Dell Technologies',          supportPhone:'+33 1 55 94 71 00', supportEmail:'support.fr@dell.com', website:'https://www.dell.com'},
  {id:'vnd-hpe',  name:'Hewlett Packard Enterprise',  supportPhone:'+33 1 41 91 60 00', supportEmail:'support.fr@hpe.com',  website:'https://www.hpe.com'}
] AS row
MERGE (v:Vendor {id: row.id})
SET v += row;

UNWIND [
  {id:'ctc-dell-maint-01', contractNumber:'DELL-FR-2023-0456', type:'maintenance', startDate:date('2023-02-15'), endDate:date('2027-02-15'), cost:8400, currency:'EUR'},
  {id:'ctc-hpe-maint-01',  contractNumber:'HPE-FR-2021-1187',  type:'maintenance', startDate:date('2021-06-01'), endDate:date('2026-06-01'), cost:6200, currency:'EUR'}
] AS row
MERGE (c:Contract {id: row.id})
SET c += row;

// ---------------------------------------------------------------------
// 8. NETWORK INTERFACES & IP ADDRESSES (physical hosts: data + mgmt NIC)
// ---------------------------------------------------------------------
UNWIND [
  {id:'nic-srv-phy-001-eth0', name:'eth0',  type:'data',       speedMbps:10000, mac:'3C:EC:EF:11:22:01'},
  {id:'nic-srv-phy-001-mgmt', name:'iDRAC', type:'management', speedMbps:1000,  mac:'3C:EC:EF:11:22:0F'},
  {id:'nic-srv-phy-002-eth0', name:'eth0',  type:'data',       speedMbps:10000, mac:'3C:EC:EF:11:22:02'},
  {id:'nic-srv-phy-002-mgmt', name:'iDRAC', type:'management', speedMbps:1000,  mac:'3C:EC:EF:11:22:1F'},
  {id:'nic-srv-phy-003-eth0', name:'eth0',  type:'data',       speedMbps:10000, mac:'B8:AE:ED:33:44:01'},
  {id:'nic-srv-phy-003-mgmt', name:'iLO',   type:'management', speedMbps:1000,  mac:'B8:AE:ED:33:44:0F'},
  {id:'nic-srv-phy-004-eth0', name:'eth0',  type:'data',       speedMbps:1000,  mac:'B8:AE:ED:33:44:02'},
  {id:'nic-srv-phy-004-mgmt', name:'iLO',   type:'management', speedMbps:1000,  mac:'B8:AE:ED:33:44:2F'}
] AS row
MERGE (n:NetworkInterface {id: row.id})
SET n += row;

UNWIND [
  {id:'ip-10-10-1-11',  address:'10.10.1.11',  version:'v4', type:'private', allocation:'static'},
  {id:'ip-10-10-1-101', address:'10.10.1.101', version:'v4', type:'private', allocation:'static'},
  {id:'ip-10-10-1-12',  address:'10.10.1.12',  version:'v4', type:'private', allocation:'static'},
  {id:'ip-10-10-1-102', address:'10.10.1.102', version:'v4', type:'private', allocation:'static'},
  {id:'ip-10-20-1-11',  address:'10.20.1.11',  version:'v4', type:'private', allocation:'static'},
  {id:'ip-10-20-1-111', address:'10.20.1.111', version:'v4', type:'private', allocation:'static'},
  {id:'ip-10-20-1-20',  address:'10.20.1.20',  version:'v4', type:'private', allocation:'static'},
  {id:'ip-10-20-1-120', address:'10.20.1.120', version:'v4', type:'private', allocation:'static'}
] AS row
MERGE (ip:IPAddress {id: row.id})
SET ip += row;

// ---------------------------------------------------------------------
// 9. CHANGE REQUESTS (change management, alongside Ticket)
// ---------------------------------------------------------------------
UNWIND [
  {id:'chg-2026-0001', title:'Add datastore capacity on hv-lyon1-01', description:'Extend the NFS-backed datastore before it fills up (see inc-2026-0003)', status:'approved',  riskLevel:'medium', scheduledStart:datetime('2026-07-22T20:00:00Z'), scheduledEnd:datetime('2026-07-22T22:00:00Z'), implementedAt:null},
  {id:'chg-2026-0002', title:'Deploy Auth Service v2.0',              description:'Major version upgrade of auth-service; breaking JWT format change', status:'scheduled', riskLevel:'high',   scheduledStart:datetime('2026-08-02T22:00:00Z'), scheduledEnd:datetime('2026-08-03T02:00:00Z'), implementedAt:null},
  {id:'chg-2026-0003', title:'Upgrade Order API to 2.5.0',            description:'Rolling upgrade across both order-api containers', status:'draft', riskLevel:'low', scheduledStart:null, scheduledEnd:null, implementedAt:null}
] AS row
MERGE (c:ChangeRequest {id: row.id})
SET c += row;

// ---------------------------------------------------------------------
// 10. ENVIRONMENTS & SLAs
// ---------------------------------------------------------------------
UNWIND [
  {id:'env-prod',    name:'prod',    description:'Production'},
  {id:'env-staging', name:'staging', description:'Pre-production staging'},
  {id:'env-dev',     name:'dev',     description:'Developer sandbox'}
] AS row
MERGE (e:Environment {id: row.id})
SET e += row;

UNWIND [
  {id:'sla-gold',   name:'Gold',   uptimeTargetPct:99.95, responseTimeMinutes:15, resolutionTimeHours:4},
  {id:'sla-silver', name:'Silver', uptimeTargetPct:99.9,  responseTimeMinutes:30, resolutionTimeHours:8},
  {id:'sla-bronze', name:'Bronze', uptimeTargetPct:99.5,  responseTimeMinutes:60, resolutionTimeHours:24}
] AS row
MERGE (s:SLA {id: row.id})
SET s += row;

// A small staging deployment, so "everything in staging" is non-trivial to query
MERGE (vm:Server:Virtual {id:'vm-staging-01'})
SET vm += {hostname:'staging-01.internal', ipAddress:'10.10.3.11', os:'Ubuntu', osVersion:'22.04', status:'active', environment:'staging', cpuCores:4, ramGB:16, diskGB:100, hypervisor:'ESXi', vCpu:4};

MERGE (ctr:Container {id:'ctr-staging-api-01'})
SET ctr += {name:'order-api', image:'order-api', imageTag:'2.5.0-rc1', status:'running', ports:'8080', cpuLimit:1.0, memLimitMB:1024};

// =====================================================================
// RELATIONSHIPS
// =====================================================================

// Physical servers -> Datacenter
UNWIND [
  ['srv-phy-001','loc-dc-par1'], ['srv-phy-002','loc-dc-par1'],
  ['srv-phy-003','loc-dc-lyon1'], ['srv-phy-004','loc-dc-lyon1']
] AS pair
MATCH (s:Server {id: pair[0]}), (l:Location {id: pair[1]})
MERGE (s)-[:LOCATED_IN]->(l);

// Virtual machines -> Physical host (on-prem) OR -> CloudRegion (cloud-native)
UNWIND [
  ['vm-web-01','srv-phy-001'], ['vm-web-02','srv-phy-001'],
  ['vm-app-01','srv-phy-002'], ['vm-app-02','srv-phy-002'],
  ['vm-db-01','srv-phy-003']
] AS pair
MATCH (v:Server:Virtual {id: pair[0]}), (h:Server:Physical {id: pair[1]})
MERGE (v)-[:HOSTED_ON]->(h);

UNWIND [
  ['vm-cloud-api-01','loc-aws-euw1'], ['vm-cloud-api-02','loc-aws-euw1'],
  ['vm-cloud-worker-01','loc-az-frc']
] AS pair
MATCH (v:Server:Virtual {id: pair[0]}), (l:Location:CloudRegion {id: pair[1]})
MERGE (v)-[:LOCATED_IN]->(l);

// Containers -> Server they run on
UNWIND [
  ['ctr-web-nginx-01','vm-web-01'], ['ctr-web-nginx-02','vm-web-02'],
  ['ctr-app-api-01','vm-app-01'],   ['ctr-app-api-02','vm-app-02'],
  ['ctr-app-auth-01','vm-app-01'],
  ['ctr-cloud-api-01','vm-cloud-api-01'], ['ctr-cloud-api-02','vm-cloud-api-02'],
  ['ctr-worker-billing-01','vm-cloud-worker-01']
] AS pair
MATCH (c:Container {id: pair[0]}), (s:Server {id: pair[1]})
MERGE (c)-[:RUNS_ON]->(s);

// Applications -> Container (or directly -> Server for the legacy CRM)
UNWIND [
  ['app-webportal','ctr-web-nginx-01'], ['app-webportal','ctr-web-nginx-02'],
  ['app-orderapi','ctr-app-api-01'],    ['app-orderapi','ctr-app-api-02'],
  ['app-authsvc','ctr-app-auth-01'],
  ['app-cloudapi','ctr-cloud-api-01'],  ['app-cloudapi','ctr-cloud-api-02'],
  ['app-billing','ctr-worker-billing-01']
] AS pair
MATCH (a:Application {id: pair[0]}), (c:Container {id: pair[1]})
MERGE (a)-[:DEPLOYED_ON]->(c);

MATCH (a:Application {id:'app-crm'}), (s:Server {id:'vm-db-01'})
MERGE (a)-[:DEPLOYED_ON]->(s);

// Application dependencies
UNWIND [
  ['app-webportal','app-orderapi'], ['app-webportal','app-authsvc'],
  ['app-orderapi','app-authsvc'],   ['app-orderapi','app-billing'],
  ['app-cloudapi','app-authsvc'],   ['app-crm','app-authsvc']
] AS pair
MATCH (a:Application {id: pair[0]}), (b:Application {id: pair[1]})
MERGE (a)-[:DEPENDS_ON]->(b);

// Team ownership / management
UNWIND [
  ['team-appdev','app-webportal'], ['team-appdev','app-orderapi'], ['team-appdev','app-crm'],
  ['team-platform','app-authsvc'], ['team-platform','app-cloudapi'], ['team-platform','app-billing']
] AS pair
MATCH (t:Team {id: pair[0]}), (a:Application {id: pair[1]})
MERGE (t)-[:OWNS]->(a);

UNWIND ['srv-phy-001','srv-phy-002','srv-phy-003','srv-phy-004'] AS sid
MATCH (t:Team {id:'team-infra'}), (s:Server {id: sid})
MERGE (t)-[:MANAGES]->(s);

// People -> Team
UNWIND [
  ['p-alice','team-infra'], ['p-bob','team-appdev'], ['p-carol','team-platform'],
  ['p-dave','team-appdev'], ['p-eve','team-infra']
] AS pair
MATCH (p:Person {id: pair[0]}), (t:Team {id: pair[1]})
MERGE (p)-[:MEMBER_OF]->(t);

// Incidents -> impacted resource + reporter
MATCH (i:Incident {id:'inc-2026-0001'}), (a:Application {id:'app-orderapi'}) MERGE (i)-[:IMPACTS]->(a);
MATCH (i:Incident {id:'inc-2026-0001'}), (c:Container {id:'ctr-app-api-01'}) MERGE (i)-[:IMPACTS]->(c);
MATCH (i:Incident {id:'inc-2026-0002'}), (a:Application {id:'app-authsvc'}) MERGE (i)-[:IMPACTS]->(a);
MATCH (i:Incident {id:'inc-2026-0002'}), (s:Server {id:'vm-app-01'})        MERGE (i)-[:IMPACTS]->(s);
MATCH (i:Incident {id:'inc-2026-0003'}), (s:Server {id:'srv-phy-003'})     MERGE (i)-[:IMPACTS]->(s);
MATCH (i:Incident {id:'inc-2026-0004'}), (a:Application {id:'app-cloudapi'}) MERGE (i)-[:IMPACTS]->(a);
MATCH (i:Incident {id:'inc-2026-0004'}), (c:Container {id:'ctr-cloud-api-01'}) MERGE (i)-[:IMPACTS]->(c);

UNWIND [
  ['inc-2026-0001','p-bob'], ['inc-2026-0002','p-carol'],
  ['inc-2026-0003','p-alice'], ['inc-2026-0004','p-dave']
] AS pair
MATCH (i:Incident {id: pair[0]}), (p:Person {id: pair[1]})
MERGE (i)-[:REPORTED_BY]->(p);

// Tickets -> Incident / concerned resource / assignee / opener
UNWIND [
  ['tkt-1001','inc-2026-0001'], ['tkt-1002','inc-2026-0002'],
  ['tkt-1003','inc-2026-0003'], ['tkt-1004','inc-2026-0004']
] AS pair
MATCH (t:Ticket {id: pair[0]}), (i:Incident {id: pair[1]})
MERGE (t)-[:TRACKS]->(i);

UNWIND [
  ['tkt-1001','app-orderapi'], ['tkt-1002','app-authsvc'],
  ['tkt-1003','srv-phy-003'],  ['tkt-1004','app-cloudapi'],
  ['tkt-1005','app-billing']
] AS pair
MATCH (t:Ticket {id: pair[0]})
MATCH (n {id: pair[1]})
WHERE n:Server OR n:Application OR n:Container
MERGE (t)-[:CONCERNS]->(n);

UNWIND [
  ['tkt-1001','p-bob'], ['tkt-1002','p-carol'], ['tkt-1003','p-eve'],
  ['tkt-1004','p-dave'], ['tkt-1005','p-bob']
] AS pair
MATCH (t:Ticket {id: pair[0]}), (p:Person {id: pair[1]})
MERGE (t)-[:ASSIGNED_TO]->(p);

UNWIND [
  ['tkt-1001','p-carol'], ['tkt-1002','p-carol'], ['tkt-1003','p-alice'],
  ['tkt-1004','p-dave'],  ['tkt-1005','p-carol']
] AS pair
MATCH (t:Ticket {id: pair[0]}), (p:Person {id: pair[1]})
MERGE (t)-[:OPENED_BY]->(p);

// ---------------------------------------------------------------------
// Vendors & contracts -> physical servers
// ---------------------------------------------------------------------
UNWIND [
  ['srv-phy-001','vnd-dell'], ['srv-phy-002','vnd-dell'],
  ['srv-phy-003','vnd-hpe'],  ['srv-phy-004','vnd-hpe']
] AS pair
MATCH (s:Server:Physical {id: pair[0]}), (v:Vendor {id: pair[1]})
MERGE (s)-[:SUPPLIED_BY]->(v);

UNWIND [
  ['srv-phy-001','ctc-dell-maint-01'], ['srv-phy-002','ctc-dell-maint-01'],
  ['srv-phy-003','ctc-hpe-maint-01'],  ['srv-phy-004','ctc-hpe-maint-01']
] AS pair
MATCH (s:Server:Physical {id: pair[0]}), (c:Contract {id: pair[1]})
MERGE (s)-[:COVERED_BY]->(c);

UNWIND [
  ['ctc-dell-maint-01','vnd-dell'], ['ctc-hpe-maint-01','vnd-hpe']
] AS pair
MATCH (c:Contract {id: pair[0]}), (v:Vendor {id: pair[1]})
MERGE (c)-[:PROVIDED_BY]->(v);

// ---------------------------------------------------------------------
// Network interfaces & IP addresses -> physical servers
// ---------------------------------------------------------------------
UNWIND [
  ['srv-phy-001','nic-srv-phy-001-eth0'], ['srv-phy-001','nic-srv-phy-001-mgmt'],
  ['srv-phy-002','nic-srv-phy-002-eth0'], ['srv-phy-002','nic-srv-phy-002-mgmt'],
  ['srv-phy-003','nic-srv-phy-003-eth0'], ['srv-phy-003','nic-srv-phy-003-mgmt'],
  ['srv-phy-004','nic-srv-phy-004-eth0'], ['srv-phy-004','nic-srv-phy-004-mgmt']
] AS pair
MATCH (s:Server:Physical {id: pair[0]}), (n:NetworkInterface {id: pair[1]})
MERGE (s)-[:HAS_INTERFACE]->(n);

UNWIND [
  ['nic-srv-phy-001-eth0','ip-10-10-1-11'],  ['nic-srv-phy-001-mgmt','ip-10-10-1-101'],
  ['nic-srv-phy-002-eth0','ip-10-10-1-12'],  ['nic-srv-phy-002-mgmt','ip-10-10-1-102'],
  ['nic-srv-phy-003-eth0','ip-10-20-1-11'],  ['nic-srv-phy-003-mgmt','ip-10-20-1-111'],
  ['nic-srv-phy-004-eth0','ip-10-20-1-20'],  ['nic-srv-phy-004-mgmt','ip-10-20-1-120']
] AS pair
MATCH (n:NetworkInterface {id: pair[0]}), (ip:IPAddress {id: pair[1]})
MERGE (n)-[:HAS_IP]->(ip);

// ---------------------------------------------------------------------
// Change requests -> concerned resource / people / originating ticket
// ---------------------------------------------------------------------
UNWIND [
  ['chg-2026-0001','srv-phy-003'], ['chg-2026-0002','app-authsvc'], ['chg-2026-0003','app-orderapi']
] AS pair
MATCH (c:ChangeRequest {id: pair[0]})
MATCH (n {id: pair[1]})
WHERE n:Server OR n:Application OR n:Container
MERGE (c)-[:CONCERNS]->(n);

UNWIND [
  ['chg-2026-0001','p-eve'],  ['chg-2026-0002','p-carol'], ['chg-2026-0003','p-bob']
] AS pair
MATCH (c:ChangeRequest {id: pair[0]}), (p:Person {id: pair[1]})
MERGE (c)-[:REQUESTED_BY]->(p)
MERGE (c)-[:ASSIGNED_TO]->(p);

// chg-2026-0003 is still 'draft' and has no approver yet
UNWIND [
  ['chg-2026-0001','p-alice'], ['chg-2026-0002','p-alice']
] AS pair
MATCH (c:ChangeRequest {id: pair[0]}), (p:Person {id: pair[1]})
MERGE (c)-[:APPROVED_BY]->(p);

MATCH (t:Ticket {id:'tkt-1003'}), (c:ChangeRequest {id:'chg-2026-0001'})
MERGE (t)-[:RELATES_TO]->(c);

// ---------------------------------------------------------------------
// New staging deployment (VM + container + extra Application deployment edge)
// ---------------------------------------------------------------------
MATCH (vm:Server:Virtual {id:'vm-staging-01'}), (host:Server:Physical {id:'srv-phy-002'})
MERGE (vm)-[:HOSTED_ON]->(host);

MATCH (ctr:Container {id:'ctr-staging-api-01'}), (vm:Server:Virtual {id:'vm-staging-01'})
MERGE (ctr)-[:RUNS_ON]->(vm);

MATCH (a:Application {id:'app-orderapi'}), (ctr:Container {id:'ctr-staging-api-01'})
MERGE (a)-[:DEPLOYED_ON]->(ctr);

// ---------------------------------------------------------------------
// Environments: link every Server/Application to the Environment node
// matching its existing `environment` string property.
// ---------------------------------------------------------------------
MATCH (n)
WHERE (n:Server OR n:Application) AND n.environment IS NOT NULL
MATCH (e:Environment {name: n.environment})
MERGE (n)-[:IN_ENVIRONMENT]->(e);

// ---------------------------------------------------------------------
// SLAs -> Applications, based on criticality
// ---------------------------------------------------------------------
UNWIND [
  ['app-orderapi','sla-gold'], ['app-authsvc','sla-gold'], ['app-cloudapi','sla-gold'],
  ['app-webportal','sla-silver'], ['app-billing','sla-silver'],
  ['app-crm','sla-bronze']
] AS pair
MATCH (a:Application {id: pair[0]}), (s:SLA {id: pair[1]})
MERGE (a)-[:HAS_SLA]->(s);
