"""The preview routes: who may read a job's bytes, and what comes back.

Everything under a job directory is derived from a PDF nobody vetted, so these
tests are mostly about refusals — no token, another job's file, an entry that is
not in the archive, a typography value that is not a number. The fixture is a
job built by `preview-fixture.mjs`: a two-page PDF and a five-block draft
rendered by `render.mjs`, so the suite needs Node and a built `dist/` but never
Docling.

    ~/.venvs/docling/bin/python -m pytest adapters/pdf/tests/test_service_preview.py
"""

from __future__ import annotations

import importlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

HERE = Path(__file__).resolve().parent
ADAPTER = HERE.parent
SERVICE = ADAPTER / "service"
REPO = ADAPTER.parent.parent
TOKEN = "preview-route-test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}
STEM = "preview-fixture"


def _build_fixture(data: Path) -> str:
    built = subprocess.run(
        ["node", str(HERE / "preview-fixture.mjs"), "--out", str(data), "--struct-dir", str(REPO)],
        capture_output=True,
        text=True,
    )
    if built.returncode != 0:
        pytest.skip(f"the fixture could not be built (is dist/ built?): {built.stderr[-400:]}")
    return built.stdout.strip()


@pytest.fixture(scope="module")
def service(tmp_path_factory):
    data = tmp_path_factory.mktemp("pdf2epub-data")
    job = _build_fixture(data)
    os.environ.update(PDF2EPUB_TOKEN=TOKEN, PDF2EPUB_DATA=str(data), PDF2EPUB_STRUCT_DIR=str(REPO))
    os.environ.pop("PDF2EPUB_ALLOW_ANONYMOUS", None)
    sys.path.insert(0, str(SERVICE))
    app = importlib.reload(importlib.import_module("app")) if "app" in sys.modules else importlib.import_module("app")
    with TestClient(app.app) as client:
        yield client, job, data


@pytest.fixture(scope="module")
def other_job(service):
    """A second finished job, so 'this job's files only' can be tested at all."""
    _, first, data = service
    second = _build_fixture(data / "second")
    moved = data / "ffffffffffffffffffffffffffffffff"
    shutil.move(str(data / "second" / second), str(moved))
    state = json.loads((moved / "job.json").read_text())
    state["id"] = moved.name
    (moved / "job.json").write_text(json.dumps(state))
    assert moved.name != first
    return moved.name


# ------------------------------------------------------------------------ auth

PROTECTED = [
    "/api/jobs/{job}/source.pdf",
    "/api/jobs/{job}/page/1.png",
    "/api/jobs/{job}/blocks",
    "/api/jobs/{job}/epub/paperPro/content.xhtml",
    "/api/jobs/{job}/export/00000000000000000000000000000000",
]


@pytest.mark.parametrize("route", PROTECTED)
def test_routes_refuse_an_unauthenticated_reader(service, route):
    client, job, _ = service
    assert client.get(route.format(job=job)).status_code == 401


def test_export_refuses_an_unauthenticated_writer(service):
    client, job, _ = service
    assert client.post(f"/api/jobs/{job}/export", json={}).status_code == 401


def test_the_preview_page_offers_a_login_rather_than_a_job(service):
    client, job, _ = service
    anonymous = client.get(f"/jobs/{job}/preview")
    assert anonymous.status_code == 401
    assert "token" in anonymous.text.lower()
    # and says nothing about whether that job exists
    assert client.get("/jobs/" + "0" * 32 + "/preview").status_code == 401
    assert client.get(f"/jobs/{job}/preview", headers=AUTH).status_code == 200
    assert client.get("/jobs/" + "0" * 32 + "/preview", headers=AUTH).status_code == 404


def test_the_preview_page_frames_the_rendition_without_scripting_it(service):
    client, job, _ = service
    page = client.get(f"/jobs/{job}/preview", headers=AUTH)
    frames = re.findall(r"<iframe\b[^>]*>", page.text)
    assert len(frames) == 1
    assert re.findall(r'sandbox="([^"]*)"', frames[0]) == ["allow-same-origin"], (
        "the rendition frame must be sandboxed and must not be granted scripts"
    )
    policy = page.headers["content-security-policy"]
    assert "default-src 'none'" in policy and "base-uri 'none'" in policy
    # and the frame document the page builds says so a second time
    assert "default-src 'none'; img-src blob:" in page.text


# -------------------------------------------------------------- content types


def test_the_source_pdf_comes_back_inline_and_inert(service):
    client, job, _ = service
    response = client.get(f"/api/jobs/{job}/source.pdf", headers=AUTH)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith("inline")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]
    assert response.content[:5] == b"%PDF-"


def test_a_source_page_is_a_png(service):
    client, job, _ = service
    response = client.get(f"/api/jobs/{job}/page/2.png", headers=AUTH)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert client.get(f"/api/jobs/{job}/page/2.png", headers=AUTH).content == response.content
    assert client.get(f"/api/jobs/{job}/page/0.png", headers=AUTH).status_code == 404
    assert client.get(f"/api/jobs/{job}/page/99.png", headers=AUTH).status_code == 404


def test_epub_entries_keep_their_own_types(service):
    client, job, _ = service
    expected = {
        "content.xhtml": "application/xhtml+xml",
        "styles.css": "text/css",
        "package.opf": "application/oebps-package+xml",
        "nav.xhtml": "application/xhtml+xml",
    }
    for entry, media_type in expected.items():
        response = client.get(f"/api/jobs/{job}/epub/paperPro/{entry}", headers=AUTH)
        assert response.status_code == 200, entry
        assert response.headers["content-type"].split(";")[0] == media_type
        assert response.headers["x-content-type-options"] == "nosniff"
        assert "sandbox" in response.headers["content-security-policy"]


# ------------------------------------------------------------------- refusals


@pytest.mark.parametrize(
    "entry",
    [
        "../../job.json",
        "..%2f..%2fjob.json",
        "images/../../../job.json",
        "mimetype",  # a real archive entry, but outside EPUB/ and with no type
        "nothing-here.xhtml",
        "content.xhtml.bak",
        "/etc/passwd",
    ],
)
def test_an_entry_outside_the_archive_is_not_served(service, entry):
    client, job, _ = service
    assert client.get(f"/api/jobs/{job}/epub/paperPro/{entry}", headers=AUTH).status_code in (307, 404)


def test_a_job_serves_only_its_own_profiles(service, other_job):
    client, job, _ = service
    assert client.get(f"/api/jobs/{job}/epub/mobile/content.xhtml", headers=AUTH).status_code == 404
    assert client.get(f"/api/jobs/{job}/epub/../{other_job}/content.xhtml", headers=AUTH).status_code in (307, 404)


def test_another_job_is_a_different_document(service, other_job):
    """Two jobs, two struct documents: neither route crosses over."""
    client, job, _ = service
    mine = client.get(f"/api/jobs/{job}/blocks", headers=AUTH)
    theirs = client.get(f"/api/jobs/{other_job}/blocks", headers=AUTH)
    assert mine.status_code == theirs.status_code == 200
    assert client.get(f"/api/jobs/{other_job}/export/{'0' * 32}", headers=AUTH).status_code == 404


@pytest.mark.parametrize("job_id", ["not-a-job", "0" * 31, "../etc", "0" * 32])
def test_an_unknown_job_is_a_404(service, job_id):
    client, _, _ = service
    assert client.get(f"/api/jobs/{job_id}/blocks", headers=AUTH).status_code in (307, 404)


def test_an_unfinished_job_has_nothing_to_preview(service):
    client, job, data = service
    root = data / "0" * 0 if False else data / ("a" * 32)
    root.mkdir()
    (root / "job.json").write_text(json.dumps({"id": root.name, "stem": "x", "status": "running"}))
    assert client.get(f"/api/jobs/{root.name}/blocks", headers=AUTH).status_code == 404
    assert client.get(f"/jobs/{root.name}/preview", headers=AUTH).status_code == 404
    shutil.rmtree(root)


# --------------------------------------------------------------------- blocks


def test_blocks_carry_the_ids_the_epub_already_uses(service):
    client, job, _ = service
    mapped = client.get(f"/api/jobs/{job}/blocks", headers=AUTH).json()
    assert mapped["pageCount"] == 2
    assert [page["page"] for page in mapped["pages"]] == [1, 2]
    by_id = {block["id"]: block for block in mapped["blocks"]}
    assert set(by_id) == {"b-0001-heading", "b-0002-paragraph", "b-0003-furniture", "b-0004-heading", "b-0005-paragraph"}
    assert by_id["b-0004-heading"]["page"] == 2
    box = by_id["b-0004-heading"]["boxes"][0]
    assert box["page"] == 2 and 0 <= box["x"] <= 1 and 0 <= box["y"] <= 1
    # the same ids the rendition carries, so the sync needs no renumbering; the
    # map also lists furniture, which the renderer leaves out of the rendition,
    # so nothing may assume every mapped block can be found in it
    xhtml = client.get(f"/api/jobs/{job}/epub/paperPro/content.xhtml", headers=AUTH).text
    for block_id, block in by_id.items():
        present = f'data-struct-id="{block_id}"' in xhtml
        assert present == (block["kind"] != "furniture"), block_id


# --------------------------------------------------------------------- export


def test_an_export_with_no_settings_is_the_epub_the_job_already_made(service):
    client, job, data = service
    made = client.post(f"/api/jobs/{job}/export", json={"profile": "paperPro"}, headers=AUTH)
    assert made.status_code == 201
    body = made.json()
    assert body["typography"] == {}
    downloaded = client.get(body["url"], headers=AUTH)
    assert downloaded.headers["content-type"] == "application/epub+zip"
    original = (data / job / "work" / STEM / f"{STEM}-paperpro.epub").read_bytes()
    assert downloaded.content == original


def test_an_export_with_settings_carries_them_in_the_stylesheet(service, tmp_path):
    client, job, _ = service
    made = client.post(
        f"/api/jobs/{job}/export",
        json={"profile": "paperProMove", "typography": {"font": "sans", "fontSizePx": 21, "lineHeight": 1.9, "marginEm": 1.2}},
        headers=AUTH,
    )
    assert made.status_code == 201
    body = made.json()
    assert body["epubcheck"]["available"] in (True, False)
    if body["epubcheck"]["available"]:
        assert body["epubcheck"]["errors"] == 0
    exported = tmp_path / "exported.epub"
    exported.write_bytes(client.get(body["url"], headers=AUTH).content)
    with zipfile.ZipFile(exported) as bundle:
        css = bundle.read("EPUB/styles.css").decode()
    assert "font-size: 21px;" in css
    assert "line-height: 1.9;" in css
    assert "padding: 0 1.2em;" in css
    assert "Helvetica" in css


@pytest.mark.parametrize(
    "typography",
    [
        {"font": "comic sans"},
        {"font": "Georgia; } body { background: url(http://example.invalid/x) }"},
        {"font": ["sans"]},  # not a string at all
        {"font": {"$ne": None}},
        {"fontSizePx": 400},
        {"fontSizePx": "22"},
        {"fontSizePx": True},
        {"fontSizePx": 10**400},  # JSON integers have no width limit
        {"lineHeight": 40},
        {"marginEm": -3},
    ],
)
def test_an_export_refuses_typography_it_cannot_bound(service, typography):
    client, job, _ = service
    assert client.post(f"/api/jobs/{job}/export", json={"typography": typography}, headers=AUTH).status_code == 400


def test_an_export_refuses_an_unknown_profile(service):
    client, job, _ = service
    assert client.post(f"/api/jobs/{job}/export", json={"profile": "kindle"}, headers=AUTH).status_code == 400


# --------------------------------------------------- what a hostile PDF costs


def test_a_page_with_an_absurd_box_still_costs_one_page(service, tmp_path):
    """A PDF page box has no upper bound in the format. It decides which side
    to scale, never the resolution, so the raster stays the same size."""
    client, job, data = service
    huge_id = "d" * 32
    huge = data / huge_id
    shutil.copytree(data / job, huge)
    shutil.rmtree(huge / "preview-pages", ignore_errors=True)
    # a 200-inch square page: at 110 dpi that would be 22000 x 22000 pixels
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400] /Contents 4 0 R >>",
        b"<< /Length 33 >>\nstream\n0 0 1 rg 10 10 14000 14000 re f\nendstream",
    ]
    pdf = b"%PDF-1.4\n"
    offsets = []
    for index, body in enumerate(objects):
        offsets.append(len(pdf))
        pdf += b"%d 0 obj\n" % (index + 1) + body + b"\nendobj\n"
    startxref = len(pdf)
    pdf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    pdf += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    pdf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, startxref)
    (huge / f"{STEM}.pdf").write_bytes(pdf)
    state = json.loads((huge / "job.json").read_text())
    state["id"] = huge_id
    state["pages"] = 1
    (huge / "job.json").write_text(json.dumps(state))
    # the sealed document still claims the old page geometry, so this also
    # covers the path where job.json and the document disagree
    shutil.rmtree(huge / "work" / STEM, ignore_errors=True)
    (huge / "work" / STEM).mkdir(parents=True)

    try:
        started = time.monotonic()
        response = client.get(f"/api/jobs/{huge_id}/page/1.png", headers=AUTH)
        assert response.status_code == 200
        assert time.monotonic() - started < 20, "an unbounded raster takes half a minute"
        width, height = struct.unpack(">II", response.content[16:24])
        assert max(width, height) <= 2200, f"{width}x{height} is not a bounded raster"
        assert len(response.content) < 4 * 1024 * 1024
    finally:
        shutil.rmtree(huge, ignore_errors=True)


def test_an_ordinary_page_keeps_the_size_it_had(service):
    """The cap must not quietly shrink a normal page: US Letter at 110 dpi."""
    client, job, _ = service
    response = client.get(f"/api/jobs/{job}/page/1.png", headers=AUTH)
    width, height = struct.unpack(">II", response.content[16:24])
    assert (width, height) == (935, 1210), f"{width}x{height}"


# ------------------------------------------- a job that predates this feature


def test_a_job_written_before_the_preview_existed_still_previews(service, tmp_path_factory):
    """job.json as the converter wrote it months ago: no page count, no profile
    on each file, no stem. Everything the preview needs comes off disk."""
    client, job, data = service
    legacy_id = "b" * 32
    legacy = data / legacy_id
    shutil.copytree(data / job, legacy)
    state = json.loads((legacy / "job.json").read_text())
    state["id"] = legacy_id
    state.pop("pages", None)
    state.pop("stem", None)
    for file in state["files"]:
        file.pop("profile", None)
        file.pop("label", None)
    (legacy / "job.json").write_text(json.dumps(state))
    shutil.rmtree(legacy / "preview-pages", ignore_errors=True)

    try:
        blocks = client.get(f"/api/jobs/{legacy_id}/blocks", headers=AUTH)
        assert blocks.status_code == 200
        assert blocks.json()["pageCount"] == 2
        assert client.get(f"/api/jobs/{legacy_id}/page/2.png", headers=AUTH).status_code == 200
        assert client.get(f"/api/jobs/{legacy_id}/source.pdf", headers=AUTH).status_code == 200
        entry = client.get(f"/api/jobs/{legacy_id}/epub/paperProMove/content.xhtml", headers=AUTH)
        assert entry.status_code == 200
        assert client.get(f"/jobs/{legacy_id}/preview", headers=AUTH).status_code == 200
        made = client.post(f"/api/jobs/{legacy_id}/export", json={"typography": {"fontSizePx": 19}}, headers=AUTH)
        assert made.status_code == 201, made.text
        assert made.json()["typography"] == {"fontSizePx": 19}
    finally:
        shutil.rmtree(legacy, ignore_errors=True)


def test_a_page_raster_does_not_need_to_write_to_the_job(service, tmp_path_factory):
    """A read-only job directory still serves pages, just uncached."""
    client, job, data = service
    frozen_id = "c" * 32
    frozen = data / frozen_id
    shutil.copytree(data / job, frozen)
    shutil.rmtree(frozen / "preview-pages", ignore_errors=True)
    frozen.chmod(0o555)
    try:
        response = client.get(f"/api/jobs/{frozen_id}/page/1.png", headers=AUTH)
        assert response.status_code == 200
        assert response.content[:8] == b"\x89PNG\r\n\x1a\n"
        assert not (frozen / "preview-pages").exists()
    finally:
        frozen.chmod(0o755)
        shutil.rmtree(frozen, ignore_errors=True)
