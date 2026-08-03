# Open CMDB Graph — ontology

This directory doesn't affect the React app (`app/`) or the Cypher schema/
sample data (`cypher/`) at all — it's independent, optional tooling for
spinning up a conversational AI agent over the *same* Open CMDB Graph data
model, using [`create-context-graph`](https://create-context-graph.dev/), a
Neo4j Labs project that is **not part of this repository**.

## What is create-context-graph?

`create-context-graph` takes a YAML ontology definition (entity types,
relationships, document templates, decision traces, agent tools, a system
prompt, …) and scaffolds a working demo: it loads/synthesizes data into a
Neo4j database matching that ontology, then generates an AI agent project
that can chat over the resulting knowledge graph.

It's a separate, independently maintained tool — for what it does, how to
install it, and its full CLI reference, go to the source:

- GitHub: <https://github.com/neo4j-labs/create-context-graph/blob/main/README.md>
- Website: <https://create-context-graph.dev/>

## Files in this directory

- **`_base.yaml`** — the shared POLE+O foundation (Person, Organization,
  Location, Event, Object) that every `create-context-graph` ontology
  extends. Copied from `create-context-graph`'s own examples, not specific
  to this project.
- **`software-engineering.yaml`** — `create-context-graph`'s own reference
  example ontology (repositories, issues, PRs, deployments, services,
  incidents). Kept here for comparison only; the app doesn't use it.
- **`cmdb.yaml`** — **this project's own ontology.** It extends `_base.yaml`
  with Open CMDB Graph's actual data model: all 41 entity types across the
  10 categories in `app/src/lib/nodeTypes.js` (Locations, Compute,
  Applications & Data, Application Capabilities, Network & Assets,
  Monitoring, IT Master Data, Organization, Finance, ITSM), the full
  relationship schema from
  `cypher/01_constraints_and_indexes.cypher`/`cypher/02_sample_data.cypher`,
  plus CMDB-specific document templates, decision traces, demo scenarios,
  Cypher-backed agent tools, and a system prompt for a CMDB-aware assistant.
  Every entity, property, and relationship in it mirrors the real schema
  1:1 (same labels, same property names, same relationship types), and
  `visualization.node_colors` reuses the exact palette from
  `app/src/lib/graphModel.js`, so a graph generated from this ontology
  renders with the same colors as this app's own Graph Explorer.

## Launching it

Install `create-context-graph` per its own README linked above, then from
inside this `ontology/` directory:

```bash
create-context-graph open-cmdb-graph-chatbot \
  --ontology-file ./cmdb.yaml \
  --framework claude-agent-sdk \
  --demo-data \
  --neo4j-uri neo4j://localhost:7687 \
  --neo4j-username neo4j \
  --neo4j-password password
```

Add `--reset-database` if you want a clean slate instead of layering
demo data onto whatever's already in that Neo4j database (e.g. the app's
own `cypher/02_sample_data.cypher` sample dataset):

```bash
create-context-graph open-cmdb-graph-chatbot \
  --ontology-file ./cmdb.yaml \
  --framework claude-agent-sdk \
  --demo-data \
  --reset-database \
  --neo4j-uri neo4j://localhost:7687 \
  --neo4j-username neo4j \
  --neo4j-password password
```

What each flag means here:

| Flag | Meaning |
|---|---|
| `open-cmdb-graph-chatbot` | Name of the generated agent project (its own directory, separate from this repo) |
| `--ontology-file ./cmdb.yaml` | Points at this project's ontology — relative to wherever you run the command, so either run it from inside `ontology/` as shown, or adjust the path (e.g. `./ontology/cmdb.yaml` from the repo root) |
| `--framework claude-agent-sdk` | Scaffolds the generated chat agent on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk) |
| `--demo-data` | Synthesizes demo data (documents, decision traces) from `cmdb.yaml` into the target Neo4j database |
| `--reset-database` | Optional — wipes the target database first instead of merging into whatever's already there |
| `--neo4j-uri` / `--neo4j-username` / `--neo4j-password` | Same connection details you'd use for `cypher-shell` or the app's own **Sign in** form (see the main [README](../README.md#2-load-the-schema-and-sample-data)) |

Since `cmdb.yaml` reuses this project's real labels and relationship types,
pointing `create-context-graph` at the **same** database the app uses will
layer its synthesized demo data (documents, decision traces, and whatever
entities `--demo-data` generates) right on top of the existing sample
dataset rather than conflicting with it — use `--reset-database` instead if
that's not what you want.
