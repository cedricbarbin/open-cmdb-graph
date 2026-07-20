// =====================================================================
// CMDB Graph Model - Security setup (authentication & authorization)
//
// Defines two profiles for the app in Neo4j's own native RBAC:
//   - cmdb_readonly : can browse the CMDB graph, cannot write anything
//   - cmdb_admin    : full read/write on the CMDB graph, plus the schema
//                     privileges needed by the app's "+ Node" / "+ Relationship"
//                     forms (which can introduce new labels/relationship
//                     types/property keys on the fly)
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
// Scope note: cmdb_admin is scoped to *this database's* data and schema.
// It intentionally does NOT include DBMS-level privileges (user/role
// management, other databases, server config) - "admin" here means
// "administers the CMDB", not "administers the DBMS".
// =====================================================================

// ---------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------
CREATE ROLE cmdb_readonly IF NOT EXISTS;
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
// cmdb_admin: full read/write + schema evolution on the CMDB graph only.
// ---------------------------------------------------------------------
GRANT ACCESS ON DATABASE neo4j TO cmdb_admin;
GRANT MATCH {*} ON GRAPH neo4j TO cmdb_admin;
GRANT WRITE ON GRAPH neo4j TO cmdb_admin;
GRANT NAME MANAGEMENT ON DATABASE neo4j TO cmdb_admin;
GRANT INDEX MANAGEMENT ON DATABASE neo4j TO cmdb_admin;
GRANT CONSTRAINT MANAGEMENT ON DATABASE neo4j TO cmdb_admin;
GRANT ACCESS ON DATABASE system TO cmdb_admin;

// ---------------------------------------------------------------------
// Example users - CHANGE THESE PASSWORDS before using outside a demo.
// CHANGE REQUIRED forces a password reset on first login.
// ---------------------------------------------------------------------
CREATE USER cmdb_viewer IF NOT EXISTS
  SET PASSWORD 'ChangeMe_Viewer1!' CHANGE REQUIRED
  SET STATUS ACTIVE;
GRANT ROLE cmdb_readonly TO cmdb_viewer;

CREATE USER cmdb_operator IF NOT EXISTS
  SET PASSWORD 'ChangeMe_Operator1!' CHANGE REQUIRED
  SET STATUS ACTIVE;
GRANT ROLE cmdb_admin TO cmdb_operator;

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
// SHOW ROLE cmdb_admin PRIVILEGES;
// SHOW USERS YIELD user, roles WHERE user STARTS WITH 'cmdb_' RETURN user, roles;
