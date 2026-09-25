#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ua2cypher — turn understand-anything graphs (.ua/knowledge-graph.json and
.ua/domain-graph.json) into Cypher that loads them into the Open CMDB Graph
Neo4j model (ontology/cmdb.yaml).

Mapping summary (ontology labels/relationships are reused 1:1; anything marked
"enrichment" is an extra label or relationship type that lives next to them):

  knowledge-graph.json                     -> Neo4j
  ------------------------------------------------------------------------------
  project                                  -> (:Application) MERGE by id, ON CREATE only
                                              (:Repository)  MERGE by id, ON CREATE only
                                              (Application)-[:SOURCE_REPOSITORY]->(Repository)
  node type file/document/service/         -> (:SourceFile {path, language, description, ...})
            pipeline/schema/resource          (Repository)-[:CONTAINS_FILE]->(SourceFile)
  node type config                         -> (:SettingFile), (Application)-[:HAS_SETTING_FILE]->
  node type function                       -> (:Algorithm {generatedBy:'ai-generated', confidence, extractedAt})
                                              (Application)-[:HAS_ALGORITHM]->, (Algorithm)-[:DEFINED_IN]->(SourceFile)
  node type class                          -> (:DataStructure) enrichment, -[:DEFINED_IN]->(SourceFile)
  node type table                          -> (:Data {type:'database'}), OWNS_DATA / CONSUMES_DATA
  node type endpoint                       -> (:Endpoint {method, path, protocol}), HAS_ENDPOINT, DEFINED_IN
  file nodes that look like UI screens     -> (:Form) in addition to the SourceFile, HAS_FORM, DEFINED_IN
  node type module / concept               -> (:Module) / (:Concept) enrichment
  edge contains (file -> symbol)           -> (symbol)-[:DEFINED_IN]->(SourceFile)
  edge imports                             -> [:IMPORTS] enrichment (SourceFile -> SourceFile)
  edge calls                               -> [:CALLS] enrichment
  other edge types                         -> UPPER_SNAKE_CASE relationship of the same name
  layers                                   -> (:CodeLayer) enrichment, (SourceFile)-[:IN_LAYER]->
  tour                                     -> (:TourStep) enrichment, (Application)-[:HAS_TOUR_STEP]->, -[:INSPECTS]->(SourceFile)

  domain-graph.json                        -> Neo4j
  ------------------------------------------------------------------------------
  node type domain                         -> (:BusinessDomain) MERGE by name, (Application)-[:IN_BUSINESS_DOMAIN]->
  node type flow                           -> (:Function {category: <domain name>}), (Application)-[:HAS_FUNCTION]->
                                              (Function)-[:IN_BUSINESS_DOMAIN]->(BusinessDomain)
  flow.domainMeta.entryPoint               -> (:Endpoint), (Function)-[:REALIZED_BY]->(Endpoint), HAS_ENDPOINT
  node type step                           -> (:FlowStep) enrichment, (Function)-[:HAS_STEP {order}]->
                                              (FlowStep)-[:DEFINED_IN]->(SourceFile)
  step line range overlapping an Algorithm -> (Function)-[:REALIZED_BY]->(Algorithm), (FlowStep)-[:IMPLEMENTED_BY]->(Algorithm)
  step file                                -> (Function)-[:DEFINED_IN]->(SourceFile)
  edge cross_domain                        -> (BusinessDomain)-[:DEPENDS_ON {description, weight}]->(BusinessDomain)

Every generated node (except a pre-existing Application/Repository) carries
origin:'understand-anything', appId:<application id> and uaId:<original id>,
so a whole import can be removed again with --purge.

No third-party dependency is needed to generate Cypher. --load needs the
`neo4j` Python driver.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import OrderedDict, defaultdict
from datetime import datetime, timezone

ORIGIN = "understand-anything"

FILE_LEVEL_TYPES = {"file", "document", "service", "pipeline", "schema", "resource"}
ENRICHMENT_LABELS = {"DataStructure", "Module", "Concept", "CodeLayer", "TourStep", "FlowStep"}
HTTP_METHODS = {"GET", "POST", "PUT", "DELETE", "PATCH"}
COMPLEXITY_MAP = {"simple": "low", "moderate": "medium", "complex": "high",
                  "low": "low", "medium": "medium", "high": "high"}
CONFIG_FORMATS = {".yaml": "yaml", ".yml": "yaml", ".json": "json", ".xml": "xml", ".ini": "ini",
                  ".properties": "properties", ".env": "env", ".toml": "toml", ".cfg": "ini"}
UI_LANGUAGES = {"html", "jsx", "tsx", "vue", "svelte", "dspf", "displayfile", "xaml", "razor"}
UI_TAGS = {"ui", "form", "component", "view", "screen", "page", "display-file", "dspf", "template"}


# ----------------------------------------------------------------------------- helpers
def slug(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9]+", "-", str(s)).strip("-").lower()
    return re.sub(r"-{2,}", "-", s) or "x"


def cy_str(s: str) -> str:
    s = str(s).replace("\\", "\\\\").replace("'", "\\'").replace("\r", "").replace("\n", "\\n").replace("\t", "\\t")
    return f"'{s}'"


def cy_val(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(cy_val(x) for x in v) + "]"
    if isinstance(v, dict):
        return cy_map(v)
    if isinstance(v, CypherExpr):
        return v.text
    return cy_str(v)


class CypherExpr:
    """Raw Cypher expression (e.g. datetime('...'))."""
    def __init__(self, text: str):
        self.text = text


def cy_map(d: dict) -> str:
    items = [(k, v) for k, v in d.items() if v is not None and v != [] and v != ""]
    return "{" + ", ".join(f"{k}: {cy_val(v)}" for k, v in items) + "}"


def chunks(seq, n):
    seq = list(seq)
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def line_range(node):
    lr = node.get("lineRange")
    if isinstance(lr, (list, tuple)) and len(lr) == 2:
        try:
            return int(lr[0]), int(lr[1])
        except (TypeError, ValueError):
            return None
    return None


def overlaps(a, b):
    return a and b and a[0] <= b[1] and b[0] <= a[1]


# ----------------------------------------------------------------------------- graph builder
class GraphBuilder:
    def __init__(self, app_id, app_name, repo_id, repo_url, branch, confidence, strict, batch):
        self.app_id = app_id
        self.key = slug(re.sub(r"^app-", "", app_id))   # short key used inside generated ids
        self.app_name = app_name
        self.repo_id = repo_id
        self.repo_url = repo_url
        self.branch = branch
        self.confidence = confidence
        self.strict = strict
        self.batch = batch
        self.nodes: "OrderedDict[str, dict]" = OrderedDict()      # id -> {label, merge_key, props}
        self.rels: "OrderedDict[tuple, dict]" = OrderedDict()     # (s, t, type) -> props
        self.ua_index: dict[str, str] = {}                        # ua id -> neo4j id
        self.label_of: dict[str, str] = {}                        # neo4j id -> label
        self.extracted_at = None
        self.stats = defaultdict(int)
        self.warnings: list[str] = []

    # --- primitives
    def add_node(self, label, nid, props, ua_id=None, merge_key="id"):
        if self.strict and label in ENRICHMENT_LABELS:
            return None
        base = {"id": nid, "origin": ORIGIN, "appId": self.app_id}
        if ua_id:
            base["uaId"] = ua_id
            self.ua_index[ua_id] = nid
        if self.extracted_at:
            base["extractedAt"] = CypherExpr(f"datetime({cy_str(self.extracted_at)})")
        props = {**base, **{k: v for k, v in props.items() if v is not None}}
        if nid in self.nodes:
            self.nodes[nid]["props"].update(props)
        else:
            self.nodes[nid] = {"label": label, "merge_key": merge_key, "props": props}
        self.label_of[nid] = label
        return nid

    def add_rel(self, s, t, rtype, props=None):
        if not s or not t or s == t:
            return
        if s not in self.nodes or t not in self.nodes:
            return
        key = (s, t, rtype)
        if key in self.rels:
            if props:
                self.rels[key].update({k: v for k, v in props.items() if v is not None})
        else:
            self.rels[key] = {k: v for k, v in (props or {}).items() if v is not None}

    # --- knowledge graph
    def load_knowledge(self, kg: dict):
        project = kg.get("project", {})
        self.extracted_at = project.get("analyzedAt") or datetime.now(timezone.utc).isoformat()
        name = self.app_name or project.get("name") or self.app_id
        self.project = {
            "name": name,
            "description": project.get("description"),
            "languages": project.get("languages") or [],
            "frameworks": project.get("frameworks") or [],
            "commit": project.get("gitCommitHash"),
            "analyzedAt": project.get("analyzedAt"),
            "graphVersion": kg.get("version"),
        }
        # Application + Repository are emitted separately (ON CREATE semantics)
        self.nodes[self.app_id] = {"label": "Application", "merge_key": "id", "props": {"id": self.app_id}, "special": "app"}
        self.label_of[self.app_id] = "Application"
        self.nodes[self.repo_id] = {"label": "Repository", "merge_key": "id", "props": {"id": self.repo_id}, "special": "repo"}
        self.label_of[self.repo_id] = "Repository"
        self.add_rel(self.app_id, self.repo_id, "SOURCE_REPOSITORY")

        layer_of_file = {}
        for layer in kg.get("layers") or []:
            for nid in layer.get("nodeIds") or []:
                layer_of_file[nid] = layer.get("name")

        nodes = kg.get("nodes") or []
        # pass 1: file-level nodes
        for n in nodes:
            t = n.get("type")
            if t in FILE_LEVEL_TYPES:
                self._source_file(n, layer_of_file.get(n["id"]))
            elif t == "config":
                self._setting_file(n)
            elif t == "table":
                self._data(n)
            elif t == "endpoint":
                self._endpoint_from_kg(n)
            elif t in ("module", "concept"):
                self.add_node(t.capitalize(), f"{t}-{self.key}-{slug(n.get('name'))}",
                              {"name": n.get("name"), "description": n.get("summary"), "tags": n.get("tags")}, n["id"])
        # pass 2: symbols
        for n in nodes:
            t = n.get("type")
            if t == "function":
                self._algorithm(n)
            elif t == "class":
                self._data_structure(n)
        # symbols -> files (DEFINED_IN) from filePath even when no contains edge exists
        for n in nodes:
            if n.get("type") in ("function", "class") and n.get("filePath"):
                sid = self.ua_index.get(n["id"])
                fid = self.ua_index.get(self._file_ua_id(n["filePath"], nodes))
                if sid and fid:
                    self.add_rel(sid, fid, "DEFINED_IN")
        # edges
        for e in kg.get("edges") or []:
            self._kg_edge(e)
        # layers
        for layer in kg.get("layers") or []:
            lid = self.add_node("CodeLayer", f"layer-{self.key}-{slug(layer.get('name') or layer.get('id'))}",
                                {"name": layer.get("name"), "description": layer.get("description")}, layer.get("id"))
            if not lid:
                continue
            self.add_rel(self.app_id, lid, "HAS_LAYER")
            for nid in layer.get("nodeIds") or []:
                self.add_rel(self.ua_index.get(nid), lid, "IN_LAYER")
        # tour
        for step in kg.get("tour") or []:
            order = step.get("order")
            tid = self.add_node("TourStep", f"tour-{self.key}-{order}",
                                {"name": step.get("title"), "order": order, "description": step.get("description"),
                                 "languageLesson": step.get("languageLesson")})
            if not tid:
                continue
            self.add_rel(self.app_id, tid, "HAS_TOUR_STEP", {"order": order})
            for nid in step.get("nodeIds") or []:
                self.add_rel(tid, self.ua_index.get(nid), "INSPECTS")
        self.stats["kg_nodes"] = len(nodes)
        self.stats["kg_edges"] = len(kg.get("edges") or [])

    def _file_ua_id(self, path, nodes):
        for prefix in ("file", "config", "document", "service", "pipeline", "schema", "resource"):
            cand = f"{prefix}:{path}"
            if cand in self.ua_index:
                return cand
        return None

    def _file_id(self, path):
        return f"src-{self.key}-{slug(path)}"

    def _source_file(self, n, layer_name=None):
        path = n.get("filePath") or n.get("name")
        fid = self.add_node("SourceFile", self._file_id(path), {
            "path": path, "name": n.get("name"), "language": n.get("language"),
            "description": n.get("summary"), "fileCategory": n.get("fileCategory") or n.get("type"),
            "tags": n.get("tags"), "complexity": n.get("complexity"), "notes": n.get("languageNotes"),
        }, n["id"])
        self.add_rel(self.repo_id, fid, "CONTAINS_FILE")
        # UI-looking files are also exposed as Forms (ontology: Application -HAS_FORM-> Form -DEFINED_IN-> SourceFile)
        tags = {str(t).lower() for t in (n.get("tags") or [])}
        lang = str(n.get("language") or "").lower()
        if n.get("fileCategory") == "markup" or lang in UI_LANGUAGES or (tags & UI_TAGS):
            form_id = self.add_node("Form", f"form-{self.key}-{slug(path)}", {
                "name": n.get("name"), "description": n.get("summary"), "module": layer_name, "path": path,
            })
            self.add_rel(self.app_id, form_id, "HAS_FORM")
            self.add_rel(form_id, fid, "DEFINED_IN")
        return fid

    def _setting_file(self, n):
        path = n.get("filePath") or n.get("name")
        ext = os.path.splitext(path)[1].lower()
        cid = self.add_node("SettingFile", f"cfg-{self.key}-{slug(path)}", {
            "name": n.get("name") or os.path.basename(path), "path": path, "format": CONFIG_FORMATS.get(ext),
            "description": n.get("summary"), "tags": n.get("tags"),
        }, n["id"])
        self.add_rel(self.app_id, cid, "HAS_SETTING_FILE")
        self.add_rel(self.repo_id, cid, "CONTAINS_FILE")  # enrichment: keeps config files reachable from the repo
        return cid

    def _data(self, n):
        did = self.add_node("Data", f"data-{self.key}-{slug(n.get('filePath', ''))}-{slug(n.get('name'))}", {
            "name": n.get("name"), "description": n.get("summary"), "type": "database", "path": n.get("filePath"),
            "tags": n.get("tags"),
        }, n["id"])
        return did

    def _endpoint_from_kg(self, n):
        name = n.get("name") or ""
        method, path = None, None
        m = re.match(r"^\s*([A-Z]+)\s+(\S+)", name)
        if m and m.group(1) in HTTP_METHODS:
            method, path = m.group(1), m.group(2)
        eid = self.add_node("Endpoint", f"ep-{self.key}-{slug(n.get('filePath', ''))}-{slug(name)}", {
            "name": name, "description": n.get("summary"), "method": method, "path": path,
            "protocol": "REST" if method else None, "tags": n.get("tags"),
        }, n["id"])
        self.add_rel(self.app_id, eid, "HAS_ENDPOINT")
        return eid

    def _algorithm(self, n):
        lr = line_range(n)
        aid = self.add_node("Algorithm", f"algo-{self.key}-{slug(n.get('filePath', ''))}-{slug(n.get('name'))}", {
            "name": n.get("name"), "description": n.get("summary"),
            "complexity": COMPLEXITY_MAP.get(str(n.get("complexity") or "").lower()),
            "generatedBy": "ai-generated", "confidence": self.confidence,
            "path": n.get("filePath"), "lineStart": lr[0] if lr else None, "lineEnd": lr[1] if lr else None,
            "tags": n.get("tags"), "notes": n.get("languageNotes"),
        }, n["id"])
        self.add_rel(self.app_id, aid, "HAS_ALGORITHM")
        return aid

    def _data_structure(self, n):
        lr = line_range(n)
        return self.add_node("DataStructure", f"ds-{self.key}-{slug(n.get('filePath', ''))}-{slug(n.get('name'))}", {
            "name": n.get("name"), "description": n.get("summary"), "complexity": n.get("complexity"),
            "path": n.get("filePath"), "lineStart": lr[0] if lr else None, "lineEnd": lr[1] if lr else None,
            "tags": n.get("tags"), "notes": n.get("languageNotes"),
        }, n["id"])

    def _kg_edge(self, e):
        s, t, et = self.ua_index.get(e.get("source")), self.ua_index.get(e.get("target")), str(e.get("type") or "")
        if not s or not t:
            return
        props = {"weight": e.get("weight"), "direction": e.get("direction"), "uaType": et}
        ls, lt = self.label_of.get(s), self.label_of.get(t)
        if et == "contains":
            if ls in ("SourceFile", "SettingFile") and lt in ("Algorithm", "DataStructure", "Endpoint", "Form"):
                self.add_rel(t, s, "DEFINED_IN")
            else:
                self.add_rel(s, t, "CONTAINS", props)
        elif et == "imports":
            self.add_rel(s, t, "IMPORTS", props)
        elif et == "calls":
            self.add_rel(s, t, "CALLS", props)
        elif et == "reads_from" and lt == "Data":
            self.add_rel(s, t, "READS_FROM", props)
            self.add_rel(self.app_id, t, "CONSUMES_DATA")
        elif et == "writes_to" and lt == "Data":
            self.add_rel(s, t, "WRITES_TO", props)
            self.add_rel(self.app_id, t, "OWNS_DATA")
        elif et == "related":
            self.add_rel(s, t, "RELATED_TO", props)
        else:
            self.add_rel(s, t, re.sub(r"[^A-Z0-9]+", "_", et.upper()).strip("_") or "RELATED_TO", props)

    # --- domain graph
    def load_domain(self, dg: dict):
        if not self.extracted_at:
            self.extracted_at = (dg.get("project") or {}).get("analyzedAt")
        nodes = dg.get("nodes") or []
        edges = dg.get("edges") or []
        domain_of_flow = {}
        for e in edges:
            if e.get("type") == "contains_flow":
                domain_of_flow[e["target"]] = e["source"]
        by_id = {n["id"]: n for n in nodes}
        algos = [self.nodes[i] for i in self.nodes if self.nodes[i]["label"] == "Algorithm"]

        for n in nodes:
            if n.get("type") != "domain":
                continue
            meta = n.get("domainMeta") or {}
            did = self.add_node("BusinessDomain", f"bd-{self.key}-{slug(n.get('name'))}", {
                "name": n.get("name"), "description": n.get("summary"), "tags": n.get("tags"),
                "complexity": n.get("complexity"), "entities": meta.get("entities"),
                "businessRules": meta.get("businessRules"), "crossDomainInteractions": meta.get("crossDomainInteractions"),
            }, n["id"], merge_key="name")
            self.add_rel(self.app_id, did, "IN_BUSINESS_DOMAIN")

        for n in nodes:
            if n.get("type") != "flow":
                continue
            meta = n.get("domainMeta") or {}
            dom = by_id.get(domain_of_flow.get(n["id"]), {})
            fid = self.add_node("Function", f"func-{self.key}-{slug(n.get('name'))}", {
                "name": n.get("name"), "description": n.get("summary"), "category": dom.get("name"),
                "tags": n.get("tags"), "complexity": n.get("complexity"),
                "entryPoint": meta.get("entryPoint"), "entryType": meta.get("entryType"),
            }, n["id"])
            self.add_rel(self.app_id, fid, "HAS_FUNCTION")
            if dom:
                self.add_rel(fid, self.ua_index.get(dom["id"]), "IN_BUSINESS_DOMAIN")
            if meta.get("entryPoint"):
                entry_type = str(meta.get("entryType") or "").lower()
                prog = next((t for t in re.findall(r"[A-Za-z][A-Za-z0-9_./-]{2,}", meta["entryPoint"])
                             if t.upper() not in ("CALL", "CALLP", "CALLB", "EXSR", "POST", "GET", "PUT", "PATCH", "DELETE")), None)
                eid = self.add_node("Endpoint", f"ep-{self.key}-{slug(n.get('name'))}", {
                    "name": meta["entryPoint"], "description": f"Entry point of business function '{n.get('name')}'",
                    "protocol": "REST" if entry_type == "http" else None, "entryType": entry_type or None,
                    "path": prog,
                })
                self.add_rel(self.app_id, eid, "HAS_ENDPOINT")
                self.add_rel(fid, eid, "REALIZED_BY")

        step_order = defaultdict(int)
        for e in sorted((e for e in edges if e.get("type") == "flow_step"), key=lambda e: (e["source"], e.get("weight") or 0)):
            step_order[e["source"]] += 1
            flow, step = by_id.get(e["source"]), by_id.get(e["target"])
            if not flow or not step:
                continue
            fid = self.ua_index.get(flow["id"])
            lr = line_range(step)
            sid = self.add_node("FlowStep", f"step-{self.key}-{slug(flow.get('name'))}-{slug(step.get('name'))}", {
                "name": step.get("name"), "description": step.get("summary"), "order": step_order[e["source"]],
                "weight": e.get("weight"), "path": step.get("filePath"), "lineStart": lr[0] if lr else None,
                "lineEnd": lr[1] if lr else None, "tags": step.get("tags"), "complexity": step.get("complexity"),
            }, step["id"])
            if sid:
                self.add_rel(fid, sid, "HAS_STEP", {"order": step_order[e["source"]], "weight": e.get("weight")})
            path = step.get("filePath")
            if path:
                file_id = self._file_id(path)
                if file_id in self.nodes:
                    self.add_rel(fid, file_id, "DEFINED_IN")
                    if sid:
                        self.add_rel(sid, file_id, "DEFINED_IN")
                else:
                    self.warnings.append(f"step '{step.get('name')}' references unknown file '{path}'")
                for a in algos:
                    ap = a["props"]
                    if ap.get("path") == path and lr and overlaps(lr, (ap.get("lineStart"), ap.get("lineEnd")) if ap.get("lineStart") else None):
                        self.add_rel(fid, ap["id"], "REALIZED_BY")
                        if sid:
                            self.add_rel(sid, ap["id"], "IMPLEMENTED_BY")

        for e in edges:
            if e.get("type") == "cross_domain":
                self.add_rel(self.ua_index.get(e["source"]), self.ua_index.get(e["target"]), "DEPENDS_ON",
                             {"description": e.get("description"), "weight": e.get("weight")})
        self.stats["dg_nodes"] = len(nodes)
        self.stats["dg_edges"] = len(edges)

    # --- output
    def statements(self, purge=False, schema=False):
        out = []
        p = getattr(self, "project", {"name": self.app_name or self.app_id})
        if schema:
            out.append("// ---- schema for enrichment labels (ontology labels are covered by 01_constraints_and_indexes.cypher)")
            for label in sorted(ENRICHMENT_LABELS):
                if self.strict:
                    break
                out.append(f"CREATE CONSTRAINT {label.lower()}_id_unique IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE;")
            out.append("CREATE INDEX ua_origin_app_idx IF NOT EXISTS FOR (n:SourceFile) ON (n.appId);")
        if purge:
            out.append(f"// ---- remove a previous import of this application (the Application node is kept; a Repository created by ua2cypher is recreated)")
            out.append(f"MATCH (n {{origin: {cy_str(ORIGIN)}, appId: {cy_str(self.app_id)}}}) DETACH DELETE n;")

        # Application / Repository (never overwrite hand-maintained properties)
        out.append("// ---- Application & Repository")
        out.append(
            f"MERGE (a:Application {{id: {cy_str(self.app_id)}}})\n"
            f"ON CREATE SET a.name = {cy_str(p.get('name'))}, a.description = {cy_val(p.get('description'))}\n"
            f"SET a.uaProject = {cy_str(p.get('name'))}, a.uaLanguages = {cy_val(p.get('languages') or [])}, "
            f"a.uaFrameworks = {cy_val(p.get('frameworks') or [])}, a.uaCommit = {cy_val(p.get('commit'))}, "
            f"a.uaAnalyzedAt = {cy_val(p.get('analyzedAt'))}, a.uaGraphVersion = {cy_val(p.get('graphVersion'))};")
        repo_props = {"name": p.get("name"), "description": p.get("description"), "vcsType": "git",
                      "url": self.repo_url, "defaultBranch": self.branch, "origin": ORIGIN, "appId": self.app_id}
        out.append(
            f"MERGE (r:Repository {{id: {cy_str(self.repo_id)}}})\n"
            f"ON CREATE SET r += {cy_map(repo_props)};")

        # nodes grouped by label
        by_label = defaultdict(list)
        for nid, n in self.nodes.items():
            if n.get("special"):
                continue
            by_label[(n["label"], n["merge_key"])].append(n["props"])
        for (label, key), rows in by_label.items():
            out.append(f"// ---- {label} ({len(rows)})")
            for batch in chunks(rows, self.batch):
                body = ",\n  ".join(cy_map(r) for r in batch)
                if key == "id":
                    out.append(f"UNWIND [\n  {body}\n] AS row\nMERGE (n:{label} {{id: row.id}})\nSET n += row;")
                else:
                    out.append(f"UNWIND [\n  {body}\n] AS row\nMERGE (n:{label} {{{key}: row.{key}}})\n"
                               f"ON CREATE SET n.id = row.id\nSET n += row;")

        # relationships grouped by (source label, target label, type)
        by_rel = defaultdict(list)
        for (s, t, rtype), props in self.rels.items():
            by_rel[(self.label_of[s], self.label_of[t], rtype)].append({"s": s, "t": t, "p": props})
        for (ls, lt, rtype), rows in by_rel.items():
            out.append(f"// ---- ({ls})-[:{rtype}]->({lt}) ({len(rows)})")
            for batch in chunks(rows, self.batch):
                body = ",\n  ".join(cy_map({"s": r["s"], "t": r["t"], "p": r["p"] or None}) for r in batch)
                out.append(
                    f"UNWIND [\n  {body}\n] AS row\n"
                    f"MATCH (s:{ls} {{id: row.s}}), (t:{lt} {{id: row.t}})\n"
                    f"MERGE (s)-[r:{rtype}]->(t)\n"
                    f"SET r += coalesce(row.p, {{}});")
        return out

    def summary(self):
        labels = defaultdict(int)
        for n in self.nodes.values():
            labels[n["label"]] += 1
        rels = defaultdict(int)
        for (s, t, rtype) in self.rels:
            rels[rtype] += 1
        return {"nodes": dict(labels), "relationships": dict(rels), "input": dict(self.stats), "warnings": self.warnings}


# ----------------------------------------------------------------------------- CLI
def resolve_inputs(args):
    ua_dir = args.ua_dir
    if ua_dir and os.path.isdir(ua_dir) and not os.path.basename(os.path.normpath(ua_dir)).startswith("."):
        for cand in (".ua", ".understand-anything"):
            if os.path.isdir(os.path.join(ua_dir, cand)):
                ua_dir = os.path.join(ua_dir, cand)
                break
    kg = args.knowledge_graph or (os.path.join(ua_dir, "knowledge-graph.json") if ua_dir else None)
    dg = args.domain_graph or (os.path.join(ua_dir, "domain-graph.json") if ua_dir else None)
    return kg, dg


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ua2cypher", description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="Example:\n  ua2cypher.py ./.ua --app-id app-tg -o tg.cypher --schema --purge")
    ap.add_argument("ua_dir", nargs="?", default=".", help="project directory or its .ua/ data directory (default: .)")
    ap.add_argument("--knowledge-graph", help="explicit path to knowledge-graph.json")
    ap.add_argument("--domain-graph", help="explicit path to domain-graph.json")
    ap.add_argument("--no-domain", action="store_true", help="ignore domain-graph.json even if present")
    ap.add_argument("--app-id", help="Application.id to attach to (default: app-<project slug>); an existing node is reused")
    ap.add_argument("--app-name", help="Application.name when the node has to be created")
    ap.add_argument("--repo-id", help="Repository.id (default: repo-<project slug>)")
    ap.add_argument("--repo-url", help="Repository.url when the node has to be created")
    ap.add_argument("--branch", default="main", help="Repository.defaultBranch (default: main)")
    ap.add_argument("--confidence", type=float, default=0.8, help="Algorithm.confidence for AI-extracted symbols (default: 0.8)")
    ap.add_argument("--strict", action="store_true", help="emit only ontology labels (drop DataStructure, FlowStep, CodeLayer, TourStep, Module, Concept)")
    ap.add_argument("--schema", action="store_true", help="prepend constraints for the enrichment labels")
    ap.add_argument("--purge", action="store_true", help="prepend a statement deleting a previous import of this application")
    ap.add_argument("--batch-size", type=int, default=500, help="rows per UNWIND statement (default: 500)")
    ap.add_argument("-o", "--output", help="write Cypher to this file (default: stdout)")
    ap.add_argument("--summary", action="store_true", help="print a JSON summary of generated nodes/relationships to stderr")
    ap.add_argument("--load", action="store_true", help="also execute the statements against Neo4j (needs the neo4j driver)")
    ap.add_argument("--uri", default=os.environ.get("NEO4J_URI", "neo4j://localhost:7687"))
    ap.add_argument("--user", default=os.environ.get("NEO4J_USER", "neo4j"))
    ap.add_argument("--password", default=os.environ.get("NEO4J_PASSWORD"))
    ap.add_argument("--database", default=os.environ.get("NEO4J_DATABASE", "neo4j"))
    args = ap.parse_args(argv)

    kg_path, dg_path = resolve_inputs(args)
    if not kg_path or not os.path.isfile(kg_path):
        ap.error(f"knowledge-graph.json not found (looked at {kg_path}); run /understand first or pass --knowledge-graph")
    kg = load_json(kg_path)
    dg = None
    if not args.no_domain and dg_path and os.path.isfile(dg_path):
        dg = load_json(dg_path)

    project_name = (kg.get("project") or {}).get("name") or "project"
    app_id = args.app_id or f"app-{slug(project_name)}"
    repo_id = args.repo_id or f"repo-{slug(project_name)}"
    b = GraphBuilder(app_id, args.app_name, repo_id, args.repo_url, args.branch, args.confidence, args.strict, args.batch_size)
    b.load_knowledge(kg)
    if dg:
        b.load_domain(dg)

    stmts = b.statements(purge=args.purge, schema=args.schema)
    header = (f"// Generated by ua2cypher from {os.path.abspath(kg_path)}"
              + (f" and {os.path.abspath(dg_path)}" if dg else "")
              + f"\n// Application id: {app_id} — idempotent (MERGE on id); rerun with --purge to replace a previous import.\n")
    text = header + "\n\n".join(stmts) + "\n"
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
    else:
        sys.stdout.write(text)

    summ = b.summary()
    if args.summary or args.output:
        sys.stderr.write(json.dumps(summ, indent=2, ensure_ascii=False) + "\n")

    if args.load:
        try:
            from neo4j import GraphDatabase
        except ImportError:
            sys.exit("--load needs the neo4j Python driver: pip install neo4j")
        if not args.password:
            sys.exit("--load needs --password (or NEO4J_PASSWORD)")
        with GraphDatabase.driver(args.uri, auth=(args.user, args.password)) as driver:
            driver.verify_connectivity()
            with driver.session(database=args.database) as session:
                for i, stmt in enumerate(stmts, 1):
                    if stmt.lstrip().startswith("//") and ";" not in stmt:
                        continue
                    for single in [s.strip() for s in stmt.split(";\n") if s.strip()]:
                        single = single.rstrip(";")
                        session.run(single).consume()
                sys.stderr.write(f"loaded {len(stmts)} statement blocks into {args.database} at {args.uri}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
