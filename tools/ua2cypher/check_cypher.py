#!/usr/bin/env python3
"""Offline structural sanity check for a generated .cypher file (no Neo4j needed).

Splits the file into statements, strips string literals, and verifies that every
statement has balanced {}, [], (), no stray quote and at least one clause keyword.
It is not a Cypher parser: run the file through cypher-shell/EXPLAIN for a real check.
"""
import re
import sys

STRING = re.compile(r"'(?:\\.|[^'\\])*'")


def main(path):
    txt = open(path, encoding="utf-8").read()
    raw = re.split(r";\s*\n", txt)
    stmts = []
    for s in raw:
        body = "\n".join(l for l in s.splitlines() if not l.strip().startswith("//"))
        if body.strip():
            stmts.append(body)
    problems = 0
    for i, body in enumerate(stmts, 1):
        stripped = STRING.sub("''", body)
        if stripped.replace("''", "").count("'"):
            print(f"stmt {i}: unbalanced quote"); problems += 1
        for o, c in ("{}", "[]", "()"):
            if stripped.count(o) != stripped.count(c):
                print(f"stmt {i}: unbalanced {o}{c}: {stripped[:100]!r}"); problems += 1
        if not re.search(r"\b(MERGE|MATCH|CREATE|UNWIND)\b", stripped):
            print(f"stmt {i}: no clause keyword: {stripped[:100]!r}"); problems += 1
    print(f"{path}: {len(stmts)} statements, {problems} problems, {len(txt)} bytes")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
