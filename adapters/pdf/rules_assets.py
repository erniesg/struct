"""Raster assets: crops from the original PDF and PNG asset records.

What belongs here: cutting a crop from the source raster (`_page_image`, never
Docling's masked page image), encoding it as an asset, the ink tests that
refuse a blank crop, and per-row pixel statistics of a page strip.
"""

from __future__ import annotations

import base64
import hashlib
import io

from source_raster import SourceRasterError


class AssetRules:
    """`StructAdapter` mixin (see pdf2struct.py): state lives on the adapter and is read through `self`."""

    def _asset(self, kind: str, base: str, pil_image, item) -> str | None:
        if pil_image is None:
            return None
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG", optimize=True)
        data = buffer.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        asset_id = self._id(f"asset-{base}")
        self.assets.append(
            {
                "id": asset_id,
                "kind": kind,
                "href": f"images/{base}-{digest[:12]}.png",
                "mediaType": "image/png",
                "sha256": digest,
                "width": int(pil_image.width),
                "height": int(pil_image.height),
                "bytes": base64.b64encode(data).decode("ascii"),
                "sourceObjectIds": [self._source_id(item)],
                "evidence": self._evidence(item),
                "fallback": "asset",
            }
        )
        return asset_id

    def _asset_from_image(self, kind: str, base: str, pil_image, evidence: dict, source_ids: list[str]) -> str | None:
        if pil_image is None or pil_image.width < 8 or pil_image.height < 8:
            return None
        buffer = io.BytesIO()
        pil_image.save(buffer, format="PNG", optimize=True)
        data = buffer.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        asset_id = self._id(f"asset-{base}")
        self.assets.append(
            {
                "id": asset_id,
                "kind": kind,
                "href": f"images/{base}-{digest[:12]}.png",
                "mediaType": "image/png",
                "sha256": digest,
                "width": int(pil_image.width),
                "height": int(pil_image.height),
                "bytes": base64.b64encode(data).decode("ascii"),
                "sourceObjectIds": list(source_ids),
                # its own lists: caption boxes later added to the block are not the crop's
                "evidence": {**evidence, "boxes": [dict(box) for box in evidence.get("boxes", [])], "pages": list(evidence.get("pages", [])), "signals": list(evidence.get("signals", [])), "sourceIds": list(source_ids)},
                "fallback": "source-region",
            }
        )
        return asset_id

    def _page_image(self, page: int | None):
        source_raster = getattr(self, "source_raster", None)
        if page is None:
            return None
        if source_raster is None:
            raise SourceRasterError("source raster is required for a recovery crop")
        # Recovery crops must use the original PDF. SourceRaster errors
        # propagate so a masked Docling image can never be substituted.
        return source_raster.page_image(page)

    def _crop_asset(self, kind: str, base: str, page: int, x0: float, y0: float, x1: float, y1: float, evidence: dict, source_ids: list[str], require_ink: bool = False) -> str | None:
        image = self._page_image(page)
        if image is None:
            return None
        width, height = image.size
        crop = image.crop((int(x0 * width), int(y0 * height), int(x1 * width), int(y1 * height)))
        if require_ink and not self._has_ink(crop):
            return None
        return self._asset_from_image(kind, base, crop, evidence, source_ids)

    @staticmethod
    def _has_ink(image) -> bool:
        """True when a crop carries content: dark pixels on at least a
        seventh of its rows, so a blank band or a lone rule is refused."""
        try:
            grey = image.convert("L")
            width, height = grey.size
            if width < 8 or height < 8:
                return False
            step = max(1, height // 200)
            inked_rows = 0
            sampled = 0
            pixels = grey.load()
            for y in range(0, height, step):
                sampled += 1
                dark = sum(1 for x in range(0, width, max(1, width // 300)) if pixels[x, y] < 160)
                if dark >= 2:
                    inked_rows += 1
            return sampled > 0 and inked_rows / sampled >= 0.15
        except Exception:
            return True

    def _pixel_rows(self, page: int, x0: float, x1: float):
        """Per-row ink and background fractions of a column strip of the page
        image: (dark_fraction, nonwhite_fraction, image_height)."""
        image = self._page_image(page)
        if image is None:
            return None
        try:
            import numpy as np
        except ImportError:  # pragma: no cover
            return None
        width, height = image.size
        px0, px1 = max(0, int(x0 * width)), min(width, int(x1 * width))
        if px1 - px0 < 20:
            return None
        strip = np.asarray(image.convert("L"))[:, px0:px1]
        # a frame edge is a thin line of any grey (anti-aliased at 2x); a shaded
        # box is a run of rows tinted just off white
        dark = (strip < 236).mean(axis=1)
        nonwhite = (strip < 250).mean(axis=1)
        return dark, nonwhite, height
