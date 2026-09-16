"""Column-order repair, arbitrated by the PDF's own text layer.

What belongs here: deciding, for one page, that the order Docling returned is
wrong and printing the page's prose in a different one. Nothing else in the
adapter may reorder blocks on the strength of a reading heuristic; the only
other reorder is the front-matter hoist in `rules_ruled_boxes.py`, which is
triggered by the PDF's drawn rules.

The evidence is in `reading_order.py`: the same page read by poppler's text
layer and by a two-column band model, neither of which can see Docling's
answer. A page is repaired only when both of them give the *same* order and
Docling gives a different one, and when nothing about the page makes either
opinion unsafe (see `compare_page`'s faults). Over the four corpora — 156
papers, 3,400 pages — that fires on 17 pages, sixteen of them pages the layout
model had walked back up a column, which a column being read downward settles
without appeal to either arbiter.

Floats keep their places. The repair permutes the prose blocks among the slots
they already occupy, so a block the walk has already typed as a figure, a
table, a caption or a note never moves relative to the page's other furniture:
reordering floats against prose is out of scope, and neither arbiter has an
opinion there worth trusting. A caption the layout model typed as a paragraph
is prose to this pass, and moves with the prose.
"""

from __future__ import annotations

from reading_order import compare_document


class ReadingOrderRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _measure_reading_order(self) -> list[dict]:
        if not self.page_layout:
            return []
        return compare_document(self.blocks, self.page_layout)

    def _repair_column_order(self) -> None:
        """Print each page's prose in the order its text layer and its geometry
        agree on, where they agree and Docling does not."""
        for page in self._measure_reading_order():
            if not page["confident"]:
                continue
            slots = [index for index, block in enumerate(self.blocks) if block.get("page") == page["page"]]
            # `doclingOrder` and `textOrder` index the page's own block list;
            # the prose blocks stay in the slots they hold, reshuffled.
            held = sorted(slots[position] for position in page["doclingOrder"])
            wanted = [self.blocks[slots[position]] for position in page["textOrder"]]
            for index, block in zip(held, wanted):
                self.blocks[index] = block
            self.report.reading_order_pages_repaired += 1
            self.report.reading_order_blocks_moved += len(page["displaced"])
            self.report.reading_order_repairs.append({
                "page": page["page"], "blocks": page["blocks"], "moved": len(page["displaced"]),
                "inversions": page["inversions"], "maxDisplacement": page["maxDisplacement"],
                "moves": [{"gap": d["gap"], "kind": d["kind"], "text": d["text"][:60]} for d in page["displaced"]],
            })

    def _report_reading_order(self) -> None:
        """Measure again, after every pass, and keep what is still in doubt.

        This is the counter `evaluate.py` reads: a page both arbiters agree
        about and the output still contradicts. It is zero on all four corpora,
        and it is not zero by construction — a later pass that reordered a page
        back, or a repair that did not take, lands here.
        """
        residual = 0
        disagree = 0
        compared = 0
        for page in self._measure_reading_order():
            compared += 1
            if page["inversions"]:
                disagree += 1
            if page["confident"]:
                residual += 1
                self._diagnostic(
                    "warning",
                    "layout",  # one of the codec's diagnostic categories
                    "Page order contradicts the text layer",
                    f"page {page['page']}: the text layer and the page geometry agree on an order "
                    f"the output does not follow ({page['inversions']} inverted block pairs)",
                    None,
                    page=page["page"],
                )
        self.report.reading_order_pages_compared = compared
        self.report.reading_order_pages_disagree = disagree
        self.report.reading_order_unrepaired = residual
