"""Contract tests for authenticated, sandboxed EPUB preview resources."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from fastapi.testclient import TestClient


class PreviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {
            "PDF2EPUB_DATA": cls.temp.name,
            "PDF2EPUB_TOKEN": "preview-test-token",
            "PDF2EPUB_ALLOW_ANONYMOUS": "0",
        }):
            spec = importlib.util.spec_from_file_location(
                "preview_service_test_app", Path(__file__).with_name("app.py")
            )
            cls.module = importlib.util.module_from_spec(spec)
            import sys
            sys.modules[spec.name] = cls.module
            spec.loader.exec_module(cls.module)
        # Do not enter TestClient's lifespan: conversion workers are unrelated.
        cls.job = "a" * 32
        cls.name = "paper-paperpro.epub"
        root = Path(cls.temp.name) / cls.job
        output = root / "work" / "paper"
        output.mkdir(parents=True)
        (root / "job.json").write_text(json.dumps({
            "stem": "paper", "storedName": "paper.pdf", "status": "done", "files": [{"name": cls.name}],
        }))
        (root / "paper.pdf").write_bytes(b"%PDF-1.7\npreview source\n")
        with zipfile.ZipFile(output / cls.name, "w") as archive:
            archive.writestr("EPUB/content.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml"><body>Preview text</body></html>')
            archive.writestr("EPUB/styles.css", "body { color: black; }")
            archive.writestr("EPUB/images/figure.png", b"\x89PNG\r\n\x1a\n")
            archive.writestr("secret.txt", "outside EPUB")
            archive.writestr("EPUB/../secret.txt", "traversal")
            archive.writestr("EPUB/script.js", "alert('unsafe')")
        (output / "unlisted.epub").write_bytes((output / cls.name).read_bytes())

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.client = TestClient(self.module.app)
        self.addCleanup(self.client.close)

    def fetch(self, member, name=None, authenticated=True):
        headers = {"Authorization": "Bearer preview-test-token"} if authenticated else {}
        return self.client.get(
            f"/api/jobs/{self.job}/preview/{name or self.name}/{member}",
            headers=headers,
        )

    def test_xhtml_preview_has_script_free_sandbox(self):
        response = self.fetch("content.xhtml")
        self.assertEqual(response.status_code, 200)
        self.assertIn("Preview text", response.text)
        self.assertEqual(response.headers["content-type"].split(";")[0], "text/html")
        policy = response.headers["content-security-policy"]
        self.assertIn("sandbox allow-same-origin", policy)
        self.assertNotIn("allow-scripts", policy)
        self.assertIn("default-src 'none'", policy)
        self.assertIn("script-src 'none'", policy)
        self.assertEqual(response.headers.get("x-content-type-options"), "nosniff")

    def test_relative_styles_and_images(self):
        response = self.fetch("styles.css")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/css"))
        self.assertEqual(response.text, "body { color: black; }")
        response = self.fetch("images/figure.png")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("image/png"))
        self.assertEqual(response.content, b"\x89PNG\r\n\x1a\n")

    def test_requires_authentication(self):
        self.assertEqual(self.fetch("content.xhtml", authenticated=False).status_code, 401)

    def test_cookie_auth_supports_iframe_navigation(self):
        response = self.client.get(
            f"/api/jobs/{self.job}/preview/{self.name}/content.xhtml",
            cookies={"pdf2epub_token": "preview-test-token"},
        )
        self.assertEqual(response.status_code, 200)

    def test_missing_and_unlisted_files(self):
        for member, name in [("missing.xhtml", self.name), ("content.xhtml", "unlisted.epub")]:
            with self.subTest(member=member, name=name):
                self.assertEqual(self.fetch(member, name).status_code, 404)

    def test_traversal_and_outside_archive_root_are_denied(self):
        for member in ["%2e%2e/secret.txt", "images/%2e%2e/%2e%2e/secret.txt", "%2fsecret.txt", "images%5c..%5csecret.txt", "secret.txt"]:
            with self.subTest(member=member):
                self.assertEqual(self.fetch(member).status_code, 404)

    def test_scripts_cannot_be_served(self):
        self.assertEqual(self.fetch("script.js").status_code, 404)

    def test_browser_session_bootstraps_from_supported_credentials(self):
        credentials = [
            {"params": {"token": "preview-test-token"}},
            {"headers": {"Authorization": "Bearer preview-test-token"}},
            {"headers": {"X-Auth-Token": "preview-test-token"}},
        ]
        for options in credentials:
            with self.subTest(options=options):
                client = TestClient(self.module.app)
                self.addCleanup(client.close)
                response = client.get(f"/compare/{self.job}", **options)
                self.assertEqual(response.status_code, 200)
                cookie = response.headers.get("set-cookie", "").lower()
                self.assertIn("pdf2epub_token=", cookie)
                self.assertIn("httponly", cookie)
                self.assertIn("samesite=lax", cookie)
                self.assertEqual(client.get(f"/api/jobs/{self.job}/source.pdf").status_code, 200)
                self.assertEqual(client.get(f"/api/jobs/{self.job}/preview/{self.name}/content.xhtml").status_code, 200)
                client.close()

    def test_root_query_token_bootstraps_cookie(self):
        client = TestClient(self.module.app)
        try:
            response = client.get("/", params={"token": "preview-test-token"})
            self.assertEqual(response.status_code, 200)
            self.assertIn("pdf2epub_token", response.headers.get("set-cookie", ""))
            self.assertEqual(client.get(f"/api/jobs/{self.job}/source.pdf").status_code, 200)
        finally:
            client.close()

    def test_source_pdf_is_private_inline_and_authenticated(self):
        url = f"/api/jobs/{self.job}/source.pdf"
        self.assertEqual(self.client.get(url).status_code, 401)
        response = self.client.get(url, headers={"Authorization": "Bearer preview-test-token"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"%PDF-1.7\npreview source\n")
        self.assertTrue(response.headers["content-type"].startswith("application/pdf"))
        self.assertTrue(response.headers["content-disposition"].startswith("inline"))
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertIn("private", response.headers["cache-control"])
        self.assertIn("no-store", response.headers["cache-control"])

    def test_source_pdf_missing_or_unknown_job(self):
        missing_job = "b" * 32
        root = Path(self.temp.name) / missing_job
        root.mkdir(exist_ok=True)
        (root / "job.json").write_text(json.dumps({"storedName": "missing.pdf"}))
        for job in [missing_job, "c" * 32, "invalid"]:
            with self.subTest(job=job):
                response = self.client.get(
                    f"/api/jobs/{job}/source.pdf",
                    headers={"Authorization": "Bearer preview-test-token"},
                )
                self.assertEqual(response.status_code, 404)

    def test_compare_page_requires_auth_and_existing_job(self):
        self.assertEqual(self.client.get(f"/compare/{self.job}").status_code, 401)
        headers = {"Authorization": "Bearer preview-test-token"}
        response = self.client.get(f"/compare/{self.job}", headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.headers["content-type"].startswith("text/html"))
        for job in ["c" * 32, "invalid"]:
            with self.subTest(job=job):
                self.assertEqual(self.client.get(f"/compare/{job}", headers=headers).status_code, 404)


if __name__ == "__main__":
    unittest.main()
