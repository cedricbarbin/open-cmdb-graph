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
