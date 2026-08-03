import neo4j from 'neo4j-driver';

let driver = null;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Cypher can't parameterize labels/relationship types - validate against
 * an allow-list pattern before interpolating them into a query string. */
export function assertValidIdentifier(value, kind = 'identifier') {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new Error(`Invalid ${kind}: "${value}". Use letters, digits, underscore, starting with a letter.`);
  }
  return value;
}

function backtick(identifier) {
  return `\`${identifier}\``;
}

export function connect({ uri, username, password, database }) {
  if (driver) {
    driver.close();
  }
  driver = neo4j.driver(uri, neo4j.auth.basic(username, password), {
    maxConnectionLifetime: 3 * 60 * 60 * 1000
  });
  return driver.getServerInfo({ database }).then((info) => {
    return info;
  });
}

export function disconnect() {
  if (driver) {
    driver.close();
    driver = null;
  }
}

export function isConnected() {
  return driver !== null;
}

// The status code Neo4j returns on every query (except the self-service
// password change below) when the account authenticated successfully but
// is flagged CHANGE REQUIRED - e.g. a brand new user's first sign-in.
const CREDENTIALS_EXPIRED_CODE = 'Neo.ClientError.Security.CredentialsExpired';

export function isCredentialsExpiredError(err) {
  return err?.code === CREDENTIALS_EXPIRED_CODE;
}

/** Self-service password change. This is the one command Neo4j still lets
 * a CHANGE REQUIRED account run (every other query is rejected with
 * CredentialsExpired), so it works against the `driver` already
 * authenticated with the old password - no admin privileges needed, since
 * a user is always allowed to change their own password. */
export async function changeOwnPassword({ oldPassword, newPassword }) {
  await runQuery(
    'ALTER CURRENT USER SET PASSWORD FROM $oldPassword TO $newPassword',
    { oldPassword, newPassword },
    'system'
  );
}

// Ranked low -> high privilege. `hints` matches common naming conventions
// beyond this app's own role names (cmdb_*), so profile detection still
// degrades sensibly against a differently-named RBAC setup.
const ROLE_TIERS = [
  { profile: 'readonly',  role: 'cmdb_readonly',  label: 'Read-only', hints: ['cmdb_readonly', 'readonly', 'reader'] },
  { profile: 'operator',  role: 'cmdb_operator',  label: 'Operator',  hints: ['cmdb_operator', 'operator', 'editor', 'publisher'] },
  { profile: 'superuser', role: 'cmdb_superuser', label: 'Superuser', hints: ['cmdb_superuser', 'superuser', 'poweruser', 'power_user'] },
  { profile: 'admin',     role: 'cmdb_admin',     label: 'Admin',     hints: ['cmdb_admin', 'admin', 'administrator', 'architect'] }
];

/** The app's 4 canonical CMDB roles, for the Manage Users screen's profile
 * picker (`role` is the literal Neo4j role name granted/revoked). */
export const CMDB_PROFILES = ROLE_TIERS.map(({ role, profile, label }) => ({ role, profile, label }));

// Neo4j privileges are additive across a user's roles, so if more than one
// tier matches, the highest one wins - that reflects what Neo4j will
// actually let the account do, not just the first role alphabetically.
function matchRoleTier(roles) {
  const lowerRoles = (roles ?? []).map((r) => String(r).toLowerCase());
  let matched = null;
  for (const tier of ROLE_TIERS) {
    if (lowerRoles.some((r) => tier.hints.includes(r))) matched = tier;
  }
  return matched;
}

/** Best-effort mapping of a user's raw Neo4j roles to one of the app's 4
 * canonical CMDB profiles (used by the Manage Users screen). Returns null
 * if none of the roles match any known tier. */
export function deriveCmdbProfile(roles) {
  const tier = matchRoleTier(roles);
  return tier ? { role: tier.role, profile: tier.profile, label: tier.label } : null;
}

/**
 * Determines the app-level profile ('readonly' | 'operator' | 'superuser' |
 * 'admin') for the currently authenticated user by reading their Neo4j
 * roles via `SHOW CURRENT USER` (an administration command, so it must run
 * against the `system` database regardless of which database the app
 * otherwise talks to).
 *
 * Profiles, from least to most privileged:
 *   - readonly  : browse only, no writes
 *   - operator  : can create/edit/delete CMDB data via the business
 *                 screens; the Graph Explorer menu itself is hidden
 *   - superuser : everything operator can do, plus Graph Explorer
 *   - admin     : everything superuser can do, plus the "Manage Users" menu
 *
 * The real security boundary is always Neo4j's own role privileges (see
 * cypher/00_security_setup.cypher) - a write rejected by the database stays
 * rejected no matter what this function returns. This only decides what the
 * UI *offers*, so its fallbacks intentionally fail open to 'admin' rather
 * than silently hiding functionality:
 *   - empty roles list (Community Edition has no custom roles) -> admin
 *   - non-empty roles matching a known tier                     -> that tier
 *   - non-empty roles matching no known tier                    -> readonly
 *   - SHOW CURRENT USER unsupported/unavailable                 -> admin
 */
export async function getCurrentUserProfile() {
  if (!driver) throw new Error('Not connected to Neo4j');
  const session = driver.session({ database: 'system', defaultAccessMode: neo4j.session.READ });
  try {
    const result = await session.run('SHOW CURRENT USER YIELD user, roles RETURN user, roles');
    const record = result.records[0];
    if (!record) return { username: null, roles: [], profile: 'admin', detected: false };

    const username = record.get('user');
    const roles = record.get('roles') ?? [];
    if (roles.length === 0) return { username, roles, profile: 'admin', detected: true };

    const tier = matchRoleTier(roles);
    return { username, roles, profile: tier ? tier.profile : 'readonly', detected: true };
  } catch (err) {
    if (isCredentialsExpiredError(err)) throw err;
    return { username: null, roles: [], profile: 'admin', detected: false };
  } finally {
    await session.close();
  }
}

async function runQuery(cypher, params = {}, database) {
  if (!driver) throw new Error('Not connected to Neo4j');
  const session = driver.session({ database, defaultAccessMode: neo4j.session.WRITE });
  try {
    const result = await session.run(cypher, params);
    return result.records;
  } finally {
    await session.close();
  }
}

/** Run arbitrary, user supplied Cypher (used by the Query bar / presets). */
export function runCypher(cypher, params = {}, database) {
  return runQuery(cypher, params, database);
}

/** MATCH (n)-[r]-(m) RETURN n,r,m style query, capped, used for the canvas. */
export function fetchGraph({ cypher, limit = 150 }, database) {
  const query = cypher && cypher.trim().length > 0
    ? cypher
    : `MATCH (n)-[r]-(m) RETURN n, r, m LIMIT $limit`;
  return runQuery(query, { limit: neo4j.int(limit) }, database);
}

export async function createNode({ labels, properties }, database) {
  const safeLabels = labels.map((l) => assertValidIdentifier(l, 'label')).map(backtick).join(':');
  const cypher = `CREATE (n:${safeLabels}) SET n = $properties RETURN n`;
  const records = await runQuery(cypher, { properties }, database);
  return records[0]?.get('n');
}

export async function updateNodeProperties({ elementId, properties, replace = false }, database) {
  const cypher = replace
    ? `MATCH (n) WHERE elementId(n) = $elementId SET n = $properties RETURN n`
    : `MATCH (n) WHERE elementId(n) = $elementId SET n += $properties RETURN n`;
  const records = await runQuery(cypher, { elementId, properties }, database);
  return records[0]?.get('n');
}

/** Ids (from the given candidate set) that already exist for a label - used
 * by CSV import to decide, per row, whether to create a new node or offer
 * to replace/ignore an existing one. */
export async function findExistingIds({ matchLabel, ids }, database) {
  if (ids.length === 0) return [];
  const safeLabel = backtick(assertValidIdentifier(matchLabel, 'label'));
  const cypher = `MATCH (n:${safeLabel}) WHERE n.id IN $ids RETURN n.id AS id`;
  const records = await runQuery(cypher, { ids }, database);
  return records.map((r) => r.get('id'));
}

/** Replaces an existing node's properties, matched by its business `id`
 * property rather than elementId - a CSV row only carries `id`, not a live
 * elementId from a current query result (same reasoning as
 * createRelationshipByBusinessId below). Labels are left untouched, since
 * the matched node already carries the labels for its type. Used by CSV
 * import's "replace existing" mode. */
export async function replaceNodeByBusinessId({ id, properties }, database) {
  const cypher = `MATCH (n {id: $id}) SET n = $properties RETURN n`;
  const records = await runQuery(cypher, { id, properties }, database);
  if (records.length === 0) throw new Error(`No node found with id "${id}"`);
  return records[0].get('n');
}

export async function addLabel({ elementId, label }, database) {
  const safeLabel = backtick(assertValidIdentifier(label, 'label'));
  const cypher = `MATCH (n) WHERE elementId(n) = $elementId SET n:${safeLabel} RETURN n`;
  const records = await runQuery(cypher, { elementId }, database);
  return records[0]?.get('n');
}

export async function deleteNode({ elementId, detach = true }, database) {
  const cypher = detach
    ? `MATCH (n) WHERE elementId(n) = $elementId DETACH DELETE n`
    : `MATCH (n) WHERE elementId(n) = $elementId DELETE n`;
  await runQuery(cypher, { elementId }, database);
}

export async function createRelationship({ fromElementId, toElementId, type, properties = {} }, database) {
  const safeType = backtick(assertValidIdentifier(type, 'relationship type'));
  const cypher = `
    MATCH (a) WHERE elementId(a) = $fromElementId
    MATCH (b) WHERE elementId(b) = $toElementId
    CREATE (a)-[r:${safeType}]->(b)
    SET r = $properties
    RETURN r`;
  const records = await runQuery(cypher, { fromElementId, toElementId, properties }, database);
  return records[0]?.get('r');
}

/** Creates a relationship between two nodes identified by their business
 * `id` property, not elementId - used by CSV/ZIP restore, where the only
 * identifier available from a spreadsheet cell is `id`, not a live
 * elementId from a current query result. Throws if either side can't be
 * matched, since a silent no-op would show up as "restore succeeded" when
 * it didn't. */
export async function createRelationshipByBusinessId({ fromId, toId, type }, database) {
  const safeType = backtick(assertValidIdentifier(type, 'relationship type'));
  const cypher = `
    MATCH (a {id: $fromId})
    MATCH (b {id: $toId})
    CREATE (a)-[r:${safeType}]->(b)
    RETURN r`;
  const records = await runQuery(cypher, { fromId, toId }, database);
  if (records.length === 0) throw new Error(`No node found with id "${fromId}" and/or "${toId}"`);
  return records[0].get('r');
}

export async function updateRelationshipProperties({ elementId, properties, replace = false }, database) {
  const cypher = replace
    ? `MATCH ()-[r]->() WHERE elementId(r) = $elementId SET r = $properties RETURN r`
    : `MATCH ()-[r]->() WHERE elementId(r) = $elementId SET r += $properties RETURN r`;
  const records = await runQuery(cypher, { elementId, properties }, database);
  return records[0]?.get('r');
}

export async function deleteRelationship({ elementId }, database) {
  const cypher = `MATCH ()-[r]->() WHERE elementId(r) = $elementId DELETE r`;
  await runQuery(cypher, { elementId }, database);
}

export async function searchNodes({ term, limit = 25 }, database) {
  const cypher = `
    CALL db.index.fulltext.queryNodes('cmdb_fulltext', $term) YIELD node, score
    RETURN node, score
    ORDER BY score DESC
    LIMIT $limit`;
  return runQuery(cypher, { term: `${term}*`, limit: neo4j.int(limit) }, database);
}

// Lucene query syntax chokes on most punctuation - keep only characters our
// ids/names/titles actually use so a stray `(`, `:`, `"`, etc. typed by a
// user doesn't throw a syntax error instead of just matching nothing.
function sanitizeSearchTerm(term) {
  return (term || '').replace(/[^\w\s-]/g, ' ').trim();
}

/** Search-as-you-type for relationship pickers: fulltext search optionally
 * restricted to a set of labels. Returns raw neo4j Node objects. */
export async function searchNodesForAutocomplete({ term, labels, limit = 8 }, database) {
  if (!driver) throw new Error('Not connected to Neo4j');
  const cleaned = sanitizeSearchTerm(term);
  if (cleaned.length < 2) return [];
  const cypher = labels && labels.length > 0
    ? `CALL db.index.fulltext.queryNodes('cmdb_fulltext', $term) YIELD node, score
       WHERE any(l IN labels(node) WHERE l IN $labels)
       RETURN node, score ORDER BY score DESC LIMIT $limit`
    : `CALL db.index.fulltext.queryNodes('cmdb_fulltext', $term) YIELD node, score
       RETURN node, score ORDER BY score DESC LIMIT $limit`;
  const records = await runQuery(cypher, { term: `${cleaned}*`, labels, limit: neo4j.int(limit) }, database);
  return records.map((r) => r.get('node'));
}

/** All nodes of one label, sorted, for a list screen. */
export function fetchNodesByLabel({ label, sortField = 'id', limit = 1000 }, database) {
  const safeLabel = backtick(assertValidIdentifier(label, 'label'));
  const safeSortField = assertValidIdentifier(sortField, 'sort field');
  const cypher = `MATCH (n:${safeLabel}) RETURN n ORDER BY n.${safeSortField} LIMIT $limit`;
  return runQuery(cypher, { limit: neo4j.int(limit) }, database);
}

/** Relationships where both endpoints carry at least one of the given
 * labels - used by the Backup & Restore screen to export the edges that
 * run directly between a selected set of business-screen types. Labels
 * aren't user input here (always a typeDef.matchLabel from the registry),
 * so no assertValidIdentifier guard is needed - they're passed as a query
 * parameter to `any(l IN labels(n) WHERE l IN $labels)`, not interpolated
 * into the query string. */
export function fetchRelationshipsBetweenLabels({ labels }, database) {
  const cypher = `
    MATCH (a)-[r]->(b)
    WHERE any(l IN labels(a) WHERE l IN $labels) AND any(l IN labels(b) WHERE l IN $labels)
    RETURN type(r) AS relType, a.id AS fromId, b.id AS toId`;
  return runQuery(cypher, { labels }, database);
}

/** A node's direct 1-hop neighborhood, for the dependency graph modal. */
export function fetchNeighborhood(elementId, database, limit = 50) {
  const cypher = `MATCH (n) WHERE elementId(n) = $elementId
    OPTIONAL MATCH (n)-[r]-(m)
    RETURN n, r, m LIMIT $limit`;
  return runQuery(cypher, { elementId, limit: neo4j.int(limit) }, database);
}

/** Distinct neighbor labels one hop from `elementId`, without fetching the
 * actual nodes - used to populate the dependency graph modal's right-click
 * "choose what to expand" menu. Relationship types are never chosen
 * directly; whichever relationships connect to the picked node types are
 * included automatically. */
export function fetchNeighborhoodTypes(elementId, database) {
  const cypher = `MATCH (n) WHERE elementId(n) = $elementId
    OPTIONAL MATCH (n)-[r]-(m)
    RETURN DISTINCT labels(m) AS nodeLabels`;
  return runQuery(cypher, { elementId }, database);
}

/** Same as fetchNeighborhood, but only follows relationships whose other
 * endpoint has at least one label in `labels` - the relationship type
 * itself isn't filtered, it's whatever connects to a matching neighbor.
 * The WHERE sits directly on the OPTIONAL MATCH (not a separate clause), so
 * a node with no neighbors matching the filter still comes back on its own
 * instead of disappearing entirely. */
export function fetchFilteredNeighborhood({ elementId, labels, limit = 50 }, database) {
  const cypher = `MATCH (n) WHERE elementId(n) = $elementId
    OPTIONAL MATCH (n)-[r]-(m)
    WHERE any(l IN labels(m) WHERE l IN $labels)
    RETURN n, r, m LIMIT $limit`;
  return runQuery(cypher, { elementId, labels, limit: neo4j.int(limit) }, database);
}

/** Node(s) currently connected to `elementId` via one relationship type/
 * direction, plus the relationship's own elementId - used to pre-fill and
 * diff an entity form's relationship pickers on edit. */
export function fetchRelated({ elementId, relType, direction }, database) {
  const safeType = backtick(assertValidIdentifier(relType, 'relationship type'));
  const cypher = direction === 'in'
    ? `MATCH (n)<-[r:${safeType}]-(t) WHERE elementId(n) = $elementId RETURN t, elementId(r) AS relId`
    : `MATCH (n)-[r:${safeType}]->(t) WHERE elementId(n) = $elementId RETURN t, elementId(r) AS relId`;
  return runQuery(cypher, { elementId }, database);
}

/** Convert a `<input type="date">` string ('YYYY-MM-DD') into a Neo4j Date
 * temporal value, so form edits stay consistent with the sample data (which
 * uses real `date()`/`datetime()` values, not strings) and keep working with
 * cookbook queries that do temporal arithmetic. */
export function toNeo4jDate(value) {
  if (!value) return null;
  return neo4j.types.Date.fromStandardDate(new Date(`${value}T00:00:00Z`));
}

/** Convert a `<input type="datetime-local">` string into a Neo4j DateTime. */
export function toNeo4jDateTime(value) {
  if (!value) return null;
  return neo4j.types.DateTime.fromStandardDate(new Date(value));
}

export async function fetchAllLabels(database) {
  const records = await runQuery('CALL db.labels() YIELD label RETURN label ORDER BY label', {}, database);
  return records.map((r) => r.get('label'));
}

export async function fetchAllRelationshipTypes(database) {
  const records = await runQuery(
    'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType',
    {},
    database
  );
  return records.map((r) => r.get('relationshipType'));
}

// ---------------------------------------------------------------------
// User management (admin profile only - see cypher/00_security_setup.cypher
// for the USER MANAGEMENT / ROLE MANAGEMENT privileges this requires).
// These are administration commands, always run against the `system`
// database. Unlike labels/relationship types, usernames/role names in
// administration commands CAN be parameterized, so no identifier
// allow-list/backtick-quoting is needed here.
// ---------------------------------------------------------------------

export async function fetchUsers() {
  const records = await runQuery(
    'SHOW USERS YIELD user, roles, suspended RETURN user, roles, suspended ORDER BY user',
    {},
    'system'
  );
  return records.map((r) => ({
    username: r.get('user'),
    roles: r.get('roles'),
    suspended: r.get('suspended')
  }));
}

/** Create a user and grant it exactly one of the app's 4 CMDB roles. */
export async function createUser({ username, password, role }) {
  await runQuery(
    'CREATE USER $username SET PASSWORD $password CHANGE REQUIRED SET STATUS ACTIVE',
    { username, password },
    'system'
  );
  await runQuery('GRANT ROLE $role TO $username', { role, username }, 'system');
}

/** Swap a user's CMDB profile: revoke the previous role (if any) so a user
 * never ends up holding two of the four profiles at once, then grant the
 * new one. */
export async function setUserRole({ username, role, previousRole }) {
  if (previousRole && previousRole !== role) {
    await runQuery('REVOKE ROLE $previousRole FROM $username', { previousRole, username }, 'system');
  }
  await runQuery('GRANT ROLE $role TO $username', { role, username }, 'system');
}

export async function setUserPassword({ username, password }) {
  await runQuery('ALTER USER $username SET PASSWORD $password CHANGE REQUIRED', { username, password }, 'system');
}

export async function deleteUser({ username }) {
  await runQuery('DROP USER $username', { username }, 'system');
}
