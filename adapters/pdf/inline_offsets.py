"""Convert adapter-native Python inline offsets at the Struct emission boundary.

The adapter constructs spans against Python ``str`` code points.  Struct's
TypeScript codec and renderer address JavaScript strings, whose offsets are
UTF-16 code units.  Call :func:`convert_inline_offsets` exactly once, after
all adapter recovery passes have finished changing inline ranges and before a
draft is handed to ``render.mjs``.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any


def _utf16_boundaries(text: str) -> list[int]:
    """Map each Python code-point boundary in ``text`` to a UTF-16 boundary."""
    boundaries = [0]
    offset = 0
    for character in text:
        offset += 2 if ord(character) > 0xFFFF else 1
        boundaries.append(offset)
    return boundaries


def _containers(blocks: Iterable[dict[str, Any]]) -> list[tuple[str, dict[str, Any]]]:
    containers: list[tuple[str, dict[str, Any]]] = []
    for block_index, block in enumerate(blocks):
        path = f"blocks[{block_index}]"
        containers.append((path, block))
        table = block.get("table")
        if not isinstance(table, dict):
            continue
        cells = table.get("cells", [])
        if not isinstance(cells, list):
            raise ValueError(f"{path}.table.cells must be a list")
        for cell_index, cell in enumerate(cells):
            if not isinstance(cell, dict):
                raise ValueError(f"{path}.table.cells[{cell_index}] must be an object")
            containers.append((f"{path}.table.cells[{cell_index}]", cell))
    return containers


def _validated_updates(blocks: Iterable[dict[str, Any]]) -> list[tuple[dict[str, Any], int, int]]:
    updates: list[tuple[dict[str, Any], int, int]] = []
    for path, container in _containers(blocks):
        text = container.get("text")
        if not isinstance(text, str):
            raise ValueError(f"{path}.text must be a string")
        inline = container.get("inline")
        if not isinstance(inline, list):
            raise ValueError(f"{path}.inline must be a list")
        boundaries = _utf16_boundaries(text)
        for run_index, run in enumerate(inline):
            run_path = f"{path}.inline[{run_index}]"
            if not isinstance(run, dict):
                raise ValueError(f"{run_path} must be an object")
            start, end = run.get("start"), run.get("end")
            if isinstance(start, bool) or not isinstance(start, int):
                raise ValueError(f"{run_path}.start must be an integer Python offset")
            if isinstance(end, bool) or not isinstance(end, int):
                raise ValueError(f"{run_path}.end must be an integer Python offset")
            if start < 0 or end < start:
                raise ValueError(f"{run_path} has an invalid Python range ({start}, {end})")
            if end >= len(boundaries):
                raise ValueError(f"{run_path}.end exceeds text length ({len(text)})")
            updates.append((run, boundaries[start], boundaries[end]))
    return updates


def convert_inline_offsets(blocks: Iterable[dict[str, Any]]) -> None:
    """Mutate block and table-cell ranges from Python offsets to UTF-16 once.

    Validation completes before any run is modified, so malformed adapter
    output fails without leaving a partially converted draft behind.
    """
    updates = _validated_updates(blocks)
    for run, start, end in updates:
        run["start"] = start
        run["end"] = end
