# ua2cypher — load understand-anything graphs into Open CMDB Graph

`ua2cypher.py` reads the two JSON graphs that the
[understand-anything](https://github.com/Egonex-AI/Understand-Anything) plugin
writes into a project's `.ua/` directory — `knowledge-graph.json` (files,
functions, classes, calls, layers, tour) and `domain-graph.json` (business
domains, flows, steps) — and emits idempotent Cypher that stores them in the
data model of this repository (`ontology/cmdb.yaml`, `cypher/01_constraints_and_indexes.cypher`).

It reuses the ontology's **Application / Repository / SourceFile / Function /
Algorithm / Endpoint / Form / SettingFile / BusinessDomain / Data** labels and
their relationship types 1:1, and adds a handful of clearly marked
*enrichment* labels for what the ontology has no home for (data structures,
flow steps, code layers, tour steps). Python 3.9+, no dependency; `--load`
needs `pip install neo4j`.

## Usage

```bash
# from the analysed project (uses ./.ua/knowledge-graph.json and ./.ua/domain-graph.json)
python tools/ua2cypher/ua2cypher.py /path/to/project -o project.cypher --schema --purge

# attach to an Application that already exists in the CMDB
python tools/ua2cypher/ua2cypher.py /path/to/project --app-id app-orderapi --repo-id repo-orderapi \
    --repo-url https://git.example.com/ecommerce/order-api -o orderapi.cypher

# generate and load in one go
python tools/ua2cypher/ua2cypher.py /path/to/project --schema --purge --load \
    --uri neo4j://localhost:7687 --user neo4j --password '<password>'

# then, or instead:
cypher-shell -a neo4j://localhost:7687 -u neo4j -p '<password>' -f project.cypher
python tools/ua2cypher/check_cypher.py project.cypher   # offline structural check
```

Options:

| Option | Meaning |
|---|---|
| `ua_dir` | project directory or its `.ua/` (legacy `.understand-anything/`) directory; default `.` |
| `--knowledge-graph`, `--domain-graph` | explicit file paths; `--no-domain` ignores the domain graph |
| `--app-id`, `--app-name` | `Application.id` to attach to (default `app-<project slug>`). An existing node is reused: its own properties are never overwritten, only `ua*` provenance properties are set |
| `--repo-id`, `--repo-url`, `--branch` | same for the `Repository` node |
| `--confidence` | `Algorithm.confidence` recorded on every AI-extracted symbol (default `0.8`) |
| `--strict` | only ontology labels: drops `DataStructure`, `FlowStep`, `CodeLayer`, `TourStep`, `Module`, `Concept` and their relationships |
| `--schema` | prepend `CREATE CONSTRAINT … IF NOT EXISTS` for the enrichment labels (ontology labels are already covered by `cypher/01_constraints_and_indexes.cypher`) |
| `--purge` | prepend `MATCH (n {origin:'understand-anything', appId:…}) DETACH DELETE n` so a re-import replaces the previous one (the `Application` node itself is kept) |
| `--batch-size` | rows per `UNWIND` statement (default 500) |
| `-o`, `--summary` | output file; JSON summary of generated nodes/relationships on stderr |
| `--load`, `--uri`, `--user`, `--password`, `--database` | execute the statements with the `neo4j` Python driver (also read from `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`) |

Every generated node carries `origin: 'understand-anything'`, `appId`, `uaId`
(the original understand-anything node id) and `extractedAt` (the graph's
`analyzedAt`). Ids are deterministic (`src-<app>-<path>`, `algo-<app>-<path>-<name>`,
`func-<app>-<flow>`, …) so the output is safe to re-run (`MERGE` on `id`).

## Mapping

### knowledge-graph.json

| understand-anything | Neo4j (ontology) | Notes |
|---|---|---|
| `project` | `(:Application)`, `(:Repository)`, `(Application)-[:SOURCE_REPOSITORY]->(Repository)` | `MERGE` by id with `ON CREATE SET` for name/description/url; provenance in `uaProject`, `uaLanguages`, `uaFrameworks`, `uaCommit`, `uaAnalyzedAt` |
| node `file`, `document`, `service`, `pipeline`, `schema`, `resource` | `(:SourceFile {path, language, description})` + `name`, `fileCategory`, `tags`, `complexity`, `notes` | `(Repository)-[:CONTAINS_FILE]->(SourceFile)` |
| node `config` | `(:SettingFile {name, path, format, description})` | `(Application)-[:HAS_SETTING_FILE]->`, plus `CONTAINS_FILE` from the repository (enrichment) |
| node `function` | `(:Algorithm {name, description, complexity, generatedBy:'ai-generated', confidence, extractedAt})` + `path`, `lineStart`, `lineEnd`, `tags`, `notes` | `(Application)-[:HAS_ALGORITHM]->`, `(Algorithm)-[:DEFINED_IN]->(SourceFile)`; complexity `simple/moderate/complex` → `low/medium/high` |
| node `class` | `(:DataStructure)` *enrichment* | `-[:DEFINED_IN]->(SourceFile)`; dropped with `--strict` |
| node `table` | `(:Data {type:'database'})` | `reads_from` → `(Application)-[:CONSUMES_DATA]->`, `writes_to` → `(Application)-[:OWNS_DATA]->`, plus `READS_FROM` / `WRITES_TO` from the reading node |
| node `endpoint` | `(:Endpoint {name, method, path, protocol})` | method/path parsed from names like `GET /api/orders`; `(Application)-[:HAS_ENDPOINT]->` |
| file that looks like a UI screen (`fileCategory: markup`, html/jsx/tsx/vue/svelte/dspf, or ui/form/component/view/screen/page tags) | `(:Form {name, description, module})` in addition to its `SourceFile` | `(Application)-[:HAS_FORM]->`, `(Form)-[:DEFINED_IN]->(SourceFile)`; `module` = the file's layer |
| node `module`, `concept` | `(:Module)`, `(:Concept)` *enrichment* | |
| edge `contains` (file → symbol) | `(symbol)-[:DEFINED_IN]->(SourceFile)` | direction reversed to match the ontology |
| edge `imports` | `[:IMPORTS {weight, direction}]` *enrichment* | |
| edge `calls` | `[:CALLS {weight, direction}]` *enrichment* | Algorithm/SourceFile/DataStructure endpoints |
| any other edge type | `UPPER_SNAKE_CASE` of the same name (`TESTED_BY`, `INHERITS`, `CONFIGURES`, …) | `related` → `RELATED_TO` |
| `layers` | `(:CodeLayer)` *enrichment* | `(Application)-[:HAS_LAYER]->`, `(SourceFile)-[:IN_LAYER]->` |
| `tour` | `(:TourStep {order, name, description, languageLesson})` *enrichment* | `(Application)-[:HAS_TOUR_STEP {order}]->`, `(TourStep)-[:INSPECTS]->(SourceFile)` |

### domain-graph.json

| understand-anything | Neo4j (ontology) | Notes |
|---|---|---|
| node `domain` | `(:BusinessDomain {name, description})` + `tags`, `entities`, `businessRules`, `crossDomainInteractions` | `MERGE` **by name** (the ontology makes `BusinessDomain.name` unique), `(Application)-[:IN_BUSINESS_DOMAIN]->` |
| node `flow` | `(:Function {name, description, category})` + `entryPoint`, `entryType`, `tags`, `complexity` | `category` = domain name; `(Application)-[:HAS_FUNCTION]->`, `(Function)-[:IN_BUSINESS_DOMAIN]->(BusinessDomain)` (enrichment on an ontology type) |
| `flow.domainMeta.entryPoint` | `(:Endpoint {name, path, protocol, entryType})` | `protocol: 'REST'` only for `entryType: http`; `(Function)-[:REALIZED_BY]->(Endpoint)`, `(Application)-[:HAS_ENDPOINT]->` |
| node `step` | `(:FlowStep {order, weight, path, lineStart, lineEnd})` *enrichment* | `(Function)-[:HAS_STEP {order, weight}]->`, `(FlowStep)-[:DEFINED_IN]->(SourceFile)` |
| step file | `(Function)-[:DEFINED_IN]->(SourceFile)` | one per distinct file among the flow's steps |
| step line range overlapping an `Algorithm` of the same file | `(Function)-[:REALIZED_BY]->(Algorithm)`, `(FlowStep)-[:IMPLEMENTED_BY]->(Algorithm)` | this is the join between the two graphs |
| edge `cross_domain` | `(BusinessDomain)-[:DEPENDS_ON {description, weight}]->(BusinessDomain)` | reuses the ontology's `DEPENDS_ON` type on a new label pair |

### What this gives you in the CMDB

- The three-level split described in the README (business `Function` →
  software artifacts `Algorithm`/`Endpoint`/`Form` → `SourceFile` in a
  `Repository`) is populated automatically, with `Algorithm.generatedBy =
  'ai-generated'` and a confidence score, which is exactly the provenance
  the ontology reserved for an AI source-code parser.
- `Application -[:IN_BUSINESS_DOMAIN]-> BusinessDomain` is emitted for every
  domain of the analysed project; the app's Application form only edits one
  business domain per application, so pick the primary one there if needed.
- Example queries once loaded:

```cypher
// business functions of an application, with the code that realizes them
MATCH (a:Application {id:'app-tg-20260821'})-[:HAS_FUNCTION]->(f:Function)-[:REALIZED_BY]->(x)
RETURN f.name, labels(x)[0] AS kind, x.name, x.path ORDER BY f.name;

// which source files a business domain touches
MATCH (b:BusinessDomain)<-[:IN_BUSINESS_DOMAIN]-(f:Function)-[:DEFINED_IN]->(s:SourceFile)
RETURN b.name, collect(DISTINCT s.path) AS files;

// call graph between programs
MATCH (s:SourceFile)-[:IMPORTS]->(t:SourceFile) WHERE s.appId = 'app-tg-20260821'
RETURN s.name, t.name;
```
