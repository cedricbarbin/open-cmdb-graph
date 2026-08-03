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
CREATE CONSTRAINT vlan_id_unique          IF NOT EXISTS FOR (n:VLAN)        REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT subnet_id_unique        IF NOT EXISTS FOR (n:Subnet)      REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT subnet_cidr_unique      IF NOT EXISTS FOR (n:Subnet)      REQUIRE n.cidr IS UNIQUE;
CREATE CONSTRAINT approval_id_unique      IF NOT EXISTS FOR (n:Approval)    REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT costcenter_id_unique    IF NOT EXISTS FOR (n:CostCenter)  REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT costcenter_code_unique  IF NOT EXISTS FOR (n:CostCenter)  REQUIRE n.code IS UNIQUE;
CREATE CONSTRAINT budget_id_unique        IF NOT EXISTS FOR (n:Budget)      REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT appversion_id_unique    IF NOT EXISTS FOR (n:ApplicationVersion) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT dataflow_id_unique      IF NOT EXISTS FOR (n:DataFlow)    REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT probe_id_unique         IF NOT EXISTS FOR (n:Probe)       REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT function_id_unique      IF NOT EXISTS FOR (n:Function)    REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT menu_id_unique          IF NOT EXISTS FOR (n:Menu)        REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT form_id_unique          IF NOT EXISTS FOR (n:Form)        REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT report_id_unique        IF NOT EXISTS FOR (n:Report)      REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT export_id_unique        IF NOT EXISTS FOR (n:Export)      REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT endpoint_id_unique      IF NOT EXISTS FOR (n:Endpoint)    REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT settingfile_id_unique   IF NOT EXISTS FOR (n:SettingFile) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT algorithm_id_unique     IF NOT EXISTS FOR (n:Algorithm)   REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT repository_id_unique    IF NOT EXISTS FOR (n:Repository)  REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT sourcefile_id_unique    IF NOT EXISTS FOR (n:SourceFile)  REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT masterdatatype_id_unique   IF NOT EXISTS FOR (n:MasterDataType) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT masterdatatype_code_unique IF NOT EXISTS FOR (n:MasterDataType) REQUIRE n.code IS UNIQUE;
CREATE CONSTRAINT masterdata_id_unique       IF NOT EXISTS FOR (n:MasterData)     REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT businessdomain_id_unique   IF NOT EXISTS FOR (n:BusinessDomain) REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT businessdomain_name_unique IF NOT EXISTS FOR (n:BusinessDomain) REQUIRE n.name IS UNIQUE;
CREATE CONSTRAINT alias_id_unique            IF NOT EXISTS FOR (n:Alias)         REQUIRE n.id IS UNIQUE;
CREATE CONSTRAINT alias_hostname_unique      IF NOT EXISTS FOR (n:Alias)         REQUIRE n.hostname IS UNIQUE;

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
CREATE INDEX subnet_cidr_idx          IF NOT EXISTS FOR (n:Subnet)      ON (n.cidr);
CREATE INDEX approval_status_idx      IF NOT EXISTS FOR (n:Approval)    ON (n.status);
CREATE INDEX costcenter_code_idx      IF NOT EXISTS FOR (n:CostCenter)  ON (n.code);
CREATE INDEX budget_fiscalyear_idx    IF NOT EXISTS FOR (n:Budget)      ON (n.fiscalYear);
CREATE INDEX appversion_validfrom_idx IF NOT EXISTS FOR (n:ApplicationVersion) ON (n.validFrom);
CREATE INDEX dataflow_type_idx        IF NOT EXISTS FOR (n:DataFlow)    ON (n.type);
CREATE INDEX probe_status_idx         IF NOT EXISTS FOR (n:Probe)       ON (n.status);
CREATE INDEX probe_checktype_idx      IF NOT EXISTS FOR (n:Probe)       ON (n.checkType);
CREATE INDEX function_name_idx        IF NOT EXISTS FOR (n:Function)    ON (n.name);
CREATE INDEX menu_name_idx            IF NOT EXISTS FOR (n:Menu)        ON (n.name);
CREATE INDEX form_name_idx            IF NOT EXISTS FOR (n:Form)        ON (n.name);
CREATE INDEX report_name_idx          IF NOT EXISTS FOR (n:Report)      ON (n.name);
CREATE INDEX export_name_idx          IF NOT EXISTS FOR (n:Export)      ON (n.name);
CREATE INDEX endpoint_name_idx        IF NOT EXISTS FOR (n:Endpoint)    ON (n.name);
CREATE INDEX endpoint_method_idx      IF NOT EXISTS FOR (n:Endpoint)    ON (n.method);
CREATE INDEX settingfile_name_idx     IF NOT EXISTS FOR (n:SettingFile) ON (n.name);
CREATE INDEX algorithm_name_idx       IF NOT EXISTS FOR (n:Algorithm)   ON (n.name);
CREATE INDEX algorithm_generatedby_idx IF NOT EXISTS FOR (n:Algorithm)  ON (n.generatedBy);
CREATE INDEX repository_name_idx      IF NOT EXISTS FOR (n:Repository)  ON (n.name);
CREATE INDEX sourcefile_path_idx      IF NOT EXISTS FOR (n:SourceFile)  ON (n.path);
CREATE INDEX sourcefile_language_idx  IF NOT EXISTS FOR (n:SourceFile)  ON (n.language);
CREATE INDEX masterdatatype_code_idx  IF NOT EXISTS FOR (n:MasterDataType) ON (n.code);
CREATE INDEX masterdata_code_idx      IF NOT EXISTS FOR (n:MasterData)     ON (n.code);
CREATE INDEX masterdata_status_idx    IF NOT EXISTS FOR (n:MasterData)     ON (n.status);
CREATE INDEX alias_hostname_idx       IF NOT EXISTS FOR (n:Alias)          ON (n.hostname);
CREATE INDEX alias_recordtype_idx     IF NOT EXISTS FOR (n:Alias)          ON (n.recordType);

// Full text index used by the app's search box AND by the business screens'
// relationship-picker autocomplete (see app/src/lib/nodeTypes.js). Dropped
// and recreated on every run so re-running this script after the property
// list changes actually picks up the change (ALTER isn't supported for
// fulltext indexes) - safe to do any time, it just gets rebuilt.
DROP INDEX cmdb_fulltext IF EXISTS;
CREATE FULLTEXT INDEX cmdb_fulltext
FOR (n:Location|Server|Container|Application|Team|Person|Incident|Ticket|ChangeRequest|Vendor|Contract|Environment|SLA|NetworkInterface|IPAddress|Data|DataCategory|VLAN|Subnet|Approval|CostCenter|Budget|ApplicationVersion|DataFlow|Probe|Function|Menu|Form|Report|Export|Endpoint|SettingFile|Algorithm|Repository|SourceFile|MasterDataType|MasterData|BusinessDomain|Alias)
ON EACH [n.name, n.hostname, n.title, n.id, n.address, n.contractNumber, n.cidr, n.code, n.version, n.path, n.url];
