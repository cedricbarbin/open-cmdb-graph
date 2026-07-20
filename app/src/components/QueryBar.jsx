import React, { useState } from 'react';

export const PRESET_QUERIES = [
  { label: 'Whole graph (capped)', cypher: 'MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 150' },
  {
    label: 'Datacenter topology (Paris)',
    cypher: `MATCH (loc:Location {id:'loc-dc-par1'})<-[:LOCATED_IN]-(physical:Server)
OPTIONAL MATCH (vm:Server:Virtual)-[:HOSTED_ON]->(physical)
OPTIONAL MATCH (vm)<-[:RUNS_ON]-(ctr:Container)<-[:DEPLOYED_ON]-(app:Application)
RETURN loc, physical, vm, ctr, app`
  },
  {
    label: 'Application dependency graph',
    cypher: `MATCH path = (app:Application {id:'app-webportal'})-[:DEPENDS_ON*1..5]->(dep:Application)
RETURN path`
  },
  {
    label: 'Open incidents + impacted resources',
    cypher: `MATCH (i:Incident) WHERE i.status IN ['open','investigating']
OPTIONAL MATCH (i)-[r:IMPACTS]->(affected)
RETURN i, r, affected`
  },
  {
    label: 'Tickets, assignees & related incidents',
    cypher: `MATCH (t:Ticket)
OPTIONAL MATCH (t)-[r1:TRACKS]->(i:Incident)
OPTIONAL MATCH (t)-[r2:ASSIGNED_TO]->(p:Person)
RETURN t, r1, i, r2, p`
  },
  {
    label: 'Teams, people & owned applications',
    cypher: `MATCH (team:Team)
OPTIONAL MATCH (team)<-[r1:MEMBER_OF]-(p:Person)
OPTIONAL MATCH (team)-[r2:OWNS]->(a:Application)
RETURN team, r1, p, r2, a`
  },
  {
    label: 'Vendors, contracts & covered servers',
    cypher: `MATCH (v:Vendor)
OPTIONAL MATCH (v)<-[r1:SUPPLIED_BY]-(s:Server)
OPTIONAL MATCH (v)<-[r2:PROVIDED_BY]-(c:Contract)-[r3:COVERED_BY]-(s2:Server)
RETURN v, r1, s, r2, c, r3, s2`
  },
  {
    label: 'Network interfaces & IP addresses',
    cypher: `MATCH (s:Server:Physical)-[r1:HAS_INTERFACE]->(nic:NetworkInterface)-[r2:HAS_IP]->(ip:IPAddress)
RETURN s, r1, nic, r2, ip`
  },
  {
    label: 'Change requests, approvals & linked tickets',
    cypher: `MATCH (c:ChangeRequest)
OPTIONAL MATCH (c)-[r1:CONCERNS]->(res)
OPTIONAL MATCH (c)-[r2:REQUESTED_BY]->(req:Person)
OPTIONAL MATCH (c)-[r3:APPROVED_BY]->(app:Person)
OPTIONAL MATCH (t:Ticket)-[r4:RELATES_TO]->(c)
RETURN c, r1, res, r2, req, r3, app, r4, t`
  },
  {
    label: 'Environments & SLAs',
    cypher: `MATCH (e:Environment)<-[r:IN_ENVIRONMENT]-(res)
RETURN e AS n1, r AS rel, res AS n2
UNION
MATCH (a:Application)-[r:HAS_SLA]->(sla:SLA)
RETURN a AS n1, r AS rel, sla AS n2`
  },
  {
    label: 'Data assets, ownership & classification',
    cypher: `MATCH (a:Application)-[r1:OWNS_DATA]->(d:Data)
OPTIONAL MATCH (a2:Application)-[r2:CONSUMES_DATA]->(d)
OPTIONAL MATCH (d)-[r3:CLASSIFIED_AS]->(cat:DataCategory)
RETURN a, r1, d, r2, a2, r3, cat`
  }
];

// Client-side heuristic only, for a fast "this will probably be rejected"
// hint - the real enforcement is Neo4j's own role privileges, which reject
// writes from a read-only role no matter what this regex thinks.
const WRITE_KEYWORD_RE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP)\b/i;

export default function QueryBar({ onRun, running, readOnly }) {
  const [cypher, setCypher] = useState(PRESET_QUERIES[0].cypher);
  const looksLikeWrite = readOnly && WRITE_KEYWORD_RE.test(cypher);

  function runCurrent() {
    if (looksLikeWrite) return;
    onRun(cypher);
  }

  function handlePreset(e) {
    const preset = PRESET_QUERIES.find((p) => p.label === e.target.value);
    if (preset) {
      setCypher(preset.cypher);
      onRun(preset.cypher);
    }
  }

  return (
    <div className="query-bar">
      <div className="query-bar-input">
        <select onChange={handlePreset} defaultValue={PRESET_QUERIES[0].label}>
          {PRESET_QUERIES.map((p) => (
            <option key={p.label} value={p.label}>{p.label}</option>
          ))}
        </select>
        <textarea
          rows={2}
          value={cypher}
          onChange={(e) => setCypher(e.target.value)}
          spellCheck={false}
        />
        <button type="button" onClick={runCurrent} disabled={running || looksLikeWrite}>
          {running ? 'Running…' : 'Run'}
        </button>
      </div>
      {looksLikeWrite && (
        <p className="query-bar-warning">
          Read-only profile — this looks like a write query and will be rejected by Neo4j.
        </p>
      )}
    </div>
  );
}
