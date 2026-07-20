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

const ADMIN_ROLE_HINTS = ['cmdb_admin', 'admin', 'architect', 'publisher'];
const READONLY_ROLE_HINTS = ['cmdb_readonly', 'reader'];

/**
 * Determines the app-level profile ('admin' | 'readonly') for the currently
 * authenticated user by reading their Neo4j roles via `SHOW CURRENT USER`
 * (an administration command, so it must run against the `system` database
 * regardless of which database the app otherwise talks to).
 *
 * The real security boundary is always Neo4j's own role privileges (see
 * cypher/00_security_setup.cypher) - a write rejected by the database stays
 * rejected no matter what this function returns. This only decides what the
 * UI *offers*, so its fallbacks intentionally fail open to 'admin' rather
 * than silently hiding functionality:
 *   - roles known to be read-only (cmdb_readonly, reader)      -> readonly
 *   - roles known to be admin-ish (cmdb_admin, admin, ...)     -> admin
 *   - empty roles list (Community Edition has no custom roles) -> admin
 *   - unrecognized non-empty roles                             -> readonly
 *   - SHOW CURRENT USER unsupported/unavailable                -> admin
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
    const lowerRoles = roles.map((r) => String(r).toLowerCase());

    let profile;
    if (lowerRoles.length === 0) {
      profile = 'admin';
    } else if (lowerRoles.some((r) => ADMIN_ROLE_HINTS.includes(r))) {
      profile = 'admin';
    } else if (lowerRoles.some((r) => READONLY_ROLE_HINTS.includes(r))) {
      profile = 'readonly';
    } else {
      profile = 'readonly';
    }
    return { username, roles, profile, detected: true };
  } catch {
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

/** A node's direct 1-hop neighborhood, for the dependency graph modal. */
export function fetchNeighborhood(elementId, database, limit = 50) {
  const cypher = `MATCH (n) WHERE elementId(n) = $elementId
    OPTIONAL MATCH (n)-[r]-(m)
    RETURN n, r, m LIMIT $limit`;
  return runQuery(cypher, { elementId, limit: neo4j.int(limit) }, database);
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
