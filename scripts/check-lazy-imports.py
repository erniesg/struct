#!/usr/bin/env python3
"""The adapter declares docling, and so torch, as a runtime dependency, but
imports it lazily so the tests never reach it. That is what keeps CI to a
light install; a module-level import would erode it silently, so it fails."""
import ast
import pathlib
import sys

HEAVY = {"docling", "torch", "transformers", "docling_parse"}

found = []
for path in sorted(pathlib.Path("adapters/pdf").glob("*.py")):
    for node in ast.parse(path.read_text()).body:
        if not isinstance(node, (ast.Import, ast.ImportFrom)):
            continue
        names = [node.module] if isinstance(node, ast.ImportFrom) and node.module else [alias.name for alias in node.names]
        found += [f"{path.name}:{node.lineno}: {name}" for name in names if name and name.split(".")[0] in HEAVY]

if found:
    print("a heavy dependency is imported at module level:", *found, sep="\n  ")
    sys.exit(1)
print(f"clean: {len(list(pathlib.Path('adapters/pdf').glob('*.py')))} modules, every heavy dependency imported lazily")
