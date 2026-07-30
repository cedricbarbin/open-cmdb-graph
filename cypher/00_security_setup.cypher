// =====================================================================
// CMDB Graph Model - Security setup (authentication & authorization)
//
// Defines four profiles for the app in Neo4j's own native RBAC:
//   - cmdb_readonly  : browse the CMDB graph, cannot write anything
//   - cmdb_operator  : read/write the CMDB graph (business screens only -
//                      the app hides its Graph Explorer menu for this
//                      profile, so no schema-evolution privileges needed)
//   - cmdb_superuser : same as cmdb_operator, plus the schema privileges
//                      needed by Graph Explorer's "+ Node"/"+ Relationship"
//                      forms (which can introduce new labels/relationship
//                      types/property keys on the fly)
//   - cmdb_admin     : same as cmdb_superuser, plus DBMS-level user/role
//                      management, so the app's "Manage Users" screen can
//                      create/update/delete users and assign them to one
//                      of these four profiles
//
// REQUIRES Neo4j ENTERPRISE EDITION or AURA. Custom roles/privileges are not
// available on Community Edition - see the "Community Edition" note in the
// README for what that means for this app.
//
// These are administration commands: run this file against the `system`
// database, not the CMDB data database.
//   cypher-shell -d system -u neo4j -p <password> -f cypher/00_security_setup.cypher
// In Neo4j Browser: run `:use system` first, then paste this file.
//
// Scope note: only cmdb_admin carries DBMS-level privileges (user/role
// management), and only for users/roles - it still does NOT include other
// DBMS-level privileges like database creation/deletion or server config.
// =====================================================================

// ---------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------
CREATE ROLE cmdb_readonly IF NOT EXISTS;
CREATE ROLE cmdb_operator IF NOT EXISTS;
CREATE ROLE cmdb_superuser IF NOT EXISTS;
CREATE ROLE cmdb_admin IF NOT EXISTS;

// ---------------------------------------------------------------------
// cmdb_readonly: read the CMDB graph, nothing else.
// `system` ACCESS is granted so the app can look up the connected user's
// own roles via `SHOW CURRENT USER` to decide which profile to render -
// it does NOT grant permission to read other users, roles, or databases.
// ---------------------------------------------------------------------
GRANT ACCESS ON DATABASE neo4j TO cmdb_readonly;
GRANT MATCH {*} ON GRAPH neo4j TO cmdb_readonly;
GRANT ACCESS ON DATABASE system TO cmdb_readonly;

// ---------------------------------------------------------------------
// cmdb_operator: read/write the CMDB graph via the business screens.
// No schema-evolution privileges - the app doesn't show this profile the
// Graph Explorer menu (and its dynamic "add any label/type" forms), and
// the business screens only ever write labels/relationship types that
// already exist in the schema.
// ---------------------------------------------------------------------
GRANT ACCESS ON DATABASE neo4j TO cmdb_operator;
GRANT MATCH {*} ON GRAPH neo4j TO cmdb_operator;
GRANT WRITE ON GRAPH neo4j TO cmdb_operator;
GRANT ACCESS ON DATABASE system TO cmdb_operator;

// ---------------------------------------------------------------------
// cmdb_superuser: everything cmdb_operator has, plus schema evolution on
// the CMDB graph (needed by Graph Explorer's "+ Node"/"+ Relationship"
// forms, which this profile - unlike cmdb_operator - can see and use).
// ---------------------------------------------------------------------
GRANT ACCESS ON DATABASE neo4j TO cmdb_superuser;
GRANT MATCH {*} ON GRAPH neo4j TO cmdb_superuser;
GRANT WRITE ON GRAPH neo4j TO cmdb_superuser;
GRANT NAME MANAGEMENT ON DATABASE neo4j TO cmdb_superuser;
GRANT INDEX MANAGEMENT ON DATABASE neo4j TO cmdb_superuser;
GRANT CONSTRAINT MANAGEMENT ON DATABASE neo4j TO cmdb_superuser;
GRANT ACCESS ON DATABASE system TO cmdb_superuser;

// ---------------------------------------------------------------------
// cmdb_admin: everything cmdb_superuser has, plus DBMS-level user/role
// management so the app's "Manage Users" screen can create, update
// (password/profile), and delete users, and assign them to one of these
// four roles. USER MANAGEMENT and ROLE MANAGEMENT are composite privileges
// covering SHOW/CREATE/ALTER/DROP USER and SHOW/ASSIGN/REMOVE ROLE
// respectively.
// ---------------------------------------------------------------------
GRANT ACCESS ON DATABASE neo4j TO cmdb_admin;
GRANT MATCH {*} ON GRAPH neo4j TO cmdb_admin;
GRANT WRITE ON GRAPH neo4j TO cmdb_admin;
GRANT NAME MANAGEMENT ON DATABASE neo4j TO cmdb_admin;
GRANT INDEX MANAGEMENT ON DATABASE neo4j TO cmdb_admin;
GRANT CONSTRAINT MANAGEMENT ON DATABASE neo4j TO cmdb_admin;
GRANT ACCESS ON DATABASE system TO cmdb_admin;
GRANT USER MANAGEMENT ON DBMS TO cmdb_admin;
GRANT ROLE MANAGEMENT ON DBMS TO cmdb_admin;

// ---------------------------------------------------------------------
// Example users - CHANGE THESE PASSWORDS before using outside a demo.
// CHANGE REQUIRED forces a password reset on first login. Usernames match
// the role they're granted, one-to-one, to keep the demo unambiguous.
// ---------------------------------------------------------------------
CREATE USER cmdb_viewer IF NOT EXISTS
  SET PASSWORD 'ChangeMe_Viewer1!' CHANGE REQUIRED
  SET STATUS ACTIVE;
GRANT ROLE cmdb_readonly TO cmdb_viewer;

CREATE USER cmdb_operator IF NOT EXISTS
  SET PASSWORD 'ChangeMe_Operator1!' CHANGE REQUIRED
  SET STATUS ACTIVE;
GRANT ROLE cmdb_operator TO cmdb_operator;

CREATE USER cmdb_superuser IF NOT EXISTS
  SET PASSWORD 'ChangeMe_Superuser1!' CHANGE REQUIRED
  SET STATUS ACTIVE;
GRANT ROLE cmdb_superuser TO cmdb_superuser;

CREATE USER cmdb_admin IF NOT EXISTS
  SET PASSWORD 'ChangeMe_Admin1!' CHANGE REQUIRED
  SET STATUS ACTIVE;
GRANT ROLE cmdb_admin TO cmdb_admin;

// ---------------------------------------------------------------------
// To scope these roles to a differently-named database, replace `neo4j`
// above with your database name. To scope them to every database on the
// DBMS instead (simpler for multi-database setups, broader in scope),
// replace `ON DATABASE neo4j` with `ON DATABASE *` and `ON GRAPH neo4j`
// with `ON GRAPH *`.
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// Verify: run these against the `system` database to confirm the setup.
// ---------------------------------------------------------------------
// SHOW ROLES YIELD role WHERE role STARTS WITH 'cmdb_' RETURN role;
// SHOW ROLE cmdb_readonly PRIVILEGES;
// SHOW ROLE cmdb_operator PRIVILEGES;
// SHOW ROLE cmdb_superuser PRIVILEGES;
// SHOW ROLE cmdb_admin PRIVILEGES;
// SHOW USERS YIELD user, roles WHERE user STARTS WITH 'cmdb_' RETURN user, roles;
