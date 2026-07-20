// =====================================================================
// CMDB Graph Model - Schema (constraints & indexes)
// Target: Neo4j 5.x
// Run once against an empty database before loading sample data.
// =====================================================================

// ---------------------------------------------------------------------
// Uniqueness constraints (also create a backing index automatically)
// A constraint on the "base" label (:Location, :Server) is enough,
// because every specialised node (Datacenter, CloudRegion, Physical,
// Virtual) also carries that base label.
// ---------------------------------------------------------------------
CREATE CONSTRAINT location_id_unique      IF NOT EXISTS FOR (n:Location)    REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT server_id_unique        IF NOT EXISTS FOR (n:Server)      REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT container_id_unique     IF NOT EXISTS FOR (n:Container)   REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT application_id_unique   IF NOT EXISTS FOR (n:Application) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT team_id_unique          IF NOT EXISTS FOR (n:Team)        REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT person_id_unique        IF NOT EXISTS FOR (n:Person)      REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT incident_id_unique      IF NOT EXISTS FOR (n:Incident)    REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT ticket_id_unique        IF NOT EXISTS FOR (n:Ticket)      REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT changerequest_id_unique IF NOT EXISTS FOR (n:ChangeRequest) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT netiface_id_unique      IF NOT EXISTS FOR (n:NetworkInterface) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT ipaddress_id_unique     IF NOT EXISTS FOR (n:IPAddress)   REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT ipaddress_addr_unique   IF NOT EXISTS FOR (n:IPAddress)   REQUIRE n.address IS UNIQUE;
CREATE CONSTRAINT vendor_id_unique        IF NOT EXISTS FOR (n:Vendor)      REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT contract_id_unique      IF NOT EXISTS FOR (n:Contract)    REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT environment_id_unique   IF NOT EXISTS FOR (n:Environment) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT environment_name_unique IF NOT EXISTS FOR (n:Environment) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT sla_id_unique           IF NOT EXISTS FOR (n:SLA)         REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT data_id_unique          IF NOT EXISTS FOR (n:Data)        REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT datacategory_id_unique  IF NOT EXISTS FOR (n:DataCategory) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT datacategory_name_unique IF NOT EXISTS FOR (n:DataCategory) REQUIRE n.name IS UNIQUE;

// Person email should be unique too
CREATE CONSTRAINT person_email_unique     IF NOT EXISTS FOR (n:Person)      REQUIRE n.email IS UNIQUE;

// ---------------------------------------------------------------------
// Property existence constraints (Enterprise Edition only - optional)
// Uncomment if you run Neo4j Enterprise and want to enforce them.
// ---------------------------------------------------------------------
// CREATE CONSTRAINT server_hostname_exists IF NOT EXISTS FOR (n:Server) REQUIRE n.hostname IS NOT NULL;
// CREATE CONSTRAINT incident_status_exists IF NOT EXISTS FOR (n:Incident) REQUIRE n.status IS NOT NULL;

// ---------------------------------------------------------------------
// Secondary indexes for common lookups / filters
// ---------------------------------------------------------------------
CREATE INDEX server_hostname_idx      IF NOT EXISTS FOR (n:Server)      ON (n.hostname);
CREATE INDEX server_status_idx        IF NOT EXISTS FOR (n:Server)      ON (n.status);
CREATE INDEX container_name_idx       IF NOT EXISTS FOR (n:Container)   ON (n.name);
CREATE INDEX application_name_idx     IF NOT EXISTS FOR (n:Application) ON (n.name);
CREATE INDEX application_crit_idx     IF NOT EXISTS FOR (n:Application) ON (n.criticality);
CREATE INDEX incident_status_idx      IF NOT EXISTS FOR (n:Incident)    ON (n.status);
CREATE INDEX incident_severity_idx    IF NOT EXISTS FOR (n:Incident)    ON (n.severity);
CREATE INDEX ticket_status_idx        IF NOT EXISTS FOR (n:Ticket)      ON (n.status);
CREATE INDEX ticket_priority_idx      IF NOT EXISTS FOR (n:Ticket)      ON (n.priority);
CREATE INDEX location_name_idx        IF NOT EXISTS FOR (n:Location)    ON (n.name);
CREATE INDEX changerequest_status_idx IF NOT EXISTS FOR (n:ChangeRequest) ON (n.status);
CREATE INDEX contract_end_idx         IF NOT EXISTS FOR (n:Contract)    ON (n.endDate);
CREATE INDEX ipaddress_address_idx    IF NOT EXISTS FOR (n:IPAddress)   ON (n.address);
CREATE INDEX data_name_idx            IF NOT EXISTS FOR (n:Data)        ON (n.name);
CREATE INDEX data_type_idx            IF NOT EXISTS FOR (n:Data)        ON (n.type);
CREATE INDEX datacategory_sensitivity_idx IF NOT EXISTS FOR (n:DataCategory) ON (n.sensitivity);

// Full text index used by the app's search box
CREATE FULLTEXT INDEX cmdb_fulltext IF NOT EXISTS
FOR (n:Location|Server|Container|Application|Team|Person|Incident|Ticket|ChangeRequest|Vendor|Contract|Environment|SLA|NetworkInterface|IPAddress|Data|DataCategory)
ON EACH [n.name, n.hostname, n.title, n.id, n.address];
