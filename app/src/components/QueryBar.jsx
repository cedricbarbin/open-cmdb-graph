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
  }
];

export default function QueryBar({ onRun, running }) {
  const [cypher, setCypher] = useState(PRESET_QUERIES[0].cypher);

  function runCurrent() {
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
      <button type="button" onClick={runCurrent} disabled={running}>
        {running ? 'Running…' : 'Run'}
      </button>
    </div>
  );
}
