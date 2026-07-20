import neo4j from 'neo4j-driver';

// Colour + caption-field priority per label. Falls back to a neutral grey
// and to id/first-string-property when a label isn't listed here.
export const LABEL_STYLE = {
  Datacenter:  { color: '#7C4DFF', captionFields: ['name'] },
  CloudRegion: { color: '#B388FF', captionFields: ['name'] },
  Location:    { color: '#9575CD', captionFields: ['name'] },
  Physical:    { color: '#FF7043', captionFields: ['hostname'] },
  Virtual:     { color: '#FFA726', captionFields: ['hostname'] },
  Server:      { color: '#FB8C00', captionFields: ['hostname'] },
  Container:   { color: '#26A69A', captionFields: ['name'] },
  Application: { color: '#42A5F5', captionFields: ['name'] },
  Team:        { color: '#8D6E63', captionFields: ['name'] },
  Person:      { color: '#66BB6A', captionFields: ['name'] },
  Incident:    { color: '#EF5350', captionFields: ['title'] },
  Ticket:      { color: '#EC407A', captionFields: ['title'] }
};

const DEFAULT_STYLE = { color: '#90A4AE', captionFields: ['name', 'title', 'hostname', 'id'] };

export function styleForLabels(labels = []) {
  // Prefer the most specific label found (last one that has a style entry).
  for (let i = labels.length - 1; i >= 0; i -= 1) {
    if (LABEL_STYLE[labels[i]]) return LABEL_STYLE[labels[i]];
  }
  return DEFAULT_STYLE;
}

function captionFor(labels, properties) {
  const style = styleForLabels(labels);
  for (const field of style.captionFields) {
    if (properties[field]) return String(properties[field]);
  }
  return properties.id ? String(properties.id) : labels.join(':');
}

function toPlainProperties(properties) {
  const out = {};
  for (const [key, value] of Object.entries(properties)) {
    if (neo4j.isInt(value)) {
      out[key] = value.toNumber();
    } else if (value && typeof value === 'object' && typeof value.toString === 'function' && value.constructor?.name?.match(/Date|Time|DateTime|Duration/)) {
      out[key] = value.toString();
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Converts neo4j-driver Record[] (containing Node/Relationship values in
 * any field) into deduplicated NVL-ready { nodes, relationships } arrays. */
export function recordsToGraph(records) {
  const nodes = new Map();
  const relationships = new Map();

  for (const record of records) {
    for (const key of record.keys) {
      const value = record.get(key);
      collectEntity(value, nodes, relationships);
    }
  }

  return {
    nodes: Array.from(nodes.values()),
    relationships: Array.from(relationships.values())
  };
}

function collectEntity(value, nodes, relationships) {
  if (value === null || value === undefined) return;

  if (Array.isArray(value)) {
    value.forEach((v) => collectEntity(v, nodes, relationships));
    return;
  }

  if (isNeo4jNode(value)) {
    if (!nodes.has(value.elementId)) {
      const properties = toPlainProperties(value.properties);
      nodes.set(value.elementId, {
        id: value.elementId,
        labels: value.labels,
        properties,
        captions: [{ value: captionFor(value.labels, properties) }],
        color: styleForLabels(value.labels).color
      });
    }
    return;
  }

  if (isNeo4jRelationship(value)) {
    if (!relationships.has(value.elementId)) {
      relationships.set(value.elementId, {
        id: value.elementId,
        from: value.startNodeElementId,
        to: value.endNodeElementId,
        type: value.type,
        properties: toPlainProperties(value.properties),
        captions: [{ value: value.type }]
      });
    }
    return;
  }

  if (isNeo4jPath(value)) {
    value.segments.forEach((segment) => {
      collectEntity(segment.start, nodes, relationships);
      collectEntity(segment.relationship, nodes, relationships);
      collectEntity(segment.end, nodes, relationships);
    });
  }
}

function isNeo4jNode(value) {
  return value && typeof value === 'object' && Array.isArray(value.labels) && value.elementId && value.properties && !value.type;
}

function isNeo4jRelationship(value) {
  return value && typeof value === 'object' && typeof value.type === 'string' && value.startNodeElementId && value.endNodeElementId;
}

function isNeo4jPath(value) {
  return value && typeof value === 'object' && Array.isArray(value.segments);
}

export function labelPalette() {
  return LABEL_STYLE;
}
