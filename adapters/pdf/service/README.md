# service: a private HTTP front for `adapters/pdf`

Upload a PDF, get one EPUB per device profile and the spec-052 reader criteria
for that paper. The service is a queue and a file store around `pdf2epub.py` —
it changes nothing about the conversion, so a paper converted here and a paper
converted at the command line produce byte-identical EPUBs.

```
POST /api/jobs            multipart: file=<pdf>, profiles=paperPro,paperProMove  → 202 {id}
GET  /api/jobs            recent jobs, newest first
GET  /api/jobs/{id}       state, per-criterion verdicts, download names
GET  /api/jobs/{id}/log   the converter's own output
GET  /api/jobs/{id}/report the full evaluation report
GET  /api/jobs/{id}/file/{name}  the EPUB
DELETE /api/jobs/{id}     drop a finished job and its PDF
GET  /health              unauthenticated liveness + the current limits
GET  /                    the browser UI
```

and, for a finished job, the preview:

```
GET  /jobs/{id}/preview          the PDF beside its rendition (the login form, 401, without a token)
GET  /api/jobs/{id}/source.pdf   the uploaded PDF, inline
GET  /api/jobs/{id}/page/{n}.png one source page, rastered by poppler and cached
GET  /api/jobs/{id}/blocks       block id → source page and normalised evidence boxes
GET  /api/jobs/{id}/epub/{profile}/{entry}  one entry out of that profile's EPUB
POST /api/jobs/{id}/export       {profile, typography} → re-render + EPUBCheck  → 201
GET  /api/jobs/{id}/export/{eid} the exported EPUB
```

Every route except `/health` needs the token, as `Authorization: Bearer …`,
`X-Auth-Token:`, `?token=`, or the cookie the login form sets.

## What it does about untrusted input

The pipeline reads arbitrary PDFs with pypdf, pdftotext and Docling, so the
service assumes the upload is hostile:

- a shared token gates every route, and nginx rate-limits in front of it;
- uploads are rejected over `PDF2EPUB_MAX_BYTES` (40 MB) while streaming, before
  anything is parsed, and over `PDF2EPUB_MAX_PAGES` (400) after a header check;
- one job runs at a time, in a subprocess, under `PDF2EPUB_TIMEOUT`;
- the systemd unit runs with `ProtectSystem=full`, `ProtectHome=read-only`, a
  memory ceiling and a writable path list of exactly three directories;
- jobs and their PDFs are deleted after `PDF2EPUB_RETENTION_HOURS` (72), and a
  successful job drops its Docling page images immediately — they are half the
  footprint and nothing downstream reads them once the EPUBs exist.

It is still a service that parses attacker-controlled files. Keep the token
private, and do not put it behind a hostname you would hand out.

### …and about showing it back to you

The preview puts markup derived from that PDF on a page that holds the token,
so the rendition is treated as hostile all the way through:

- it renders in an iframe whose sandbox is `allow-same-origin` and nothing
  else. Without `allow-scripts` the document cannot execute anything — no
  `<script>`, no inline handler, no `javascript:` URL. `allow-same-origin`
  grants the *parent* reach into the frame, which is what lets a font-size
  change be a `<style>` rewrite with no request; it grants the frame nothing,
  because the frame cannot run code. The pair that is dangerous,
  `allow-scripts allow-same-origin`, is exactly the pair that is refused;
- the frame document carries `default-src 'none'; img-src blob:` of its own,
  and inherits the page's policy on top of that (a `srcdoc` document must
  satisfy both), so no script source exists and no subresource can leave;
- the markup is rebuilt from an element and attribute allowlist before it is
  handed over, and images and fonts enter as `blob:` URLs the page fetched
  with its own credentials — the frame never issues a request;
- every route that hands back a job's derived bytes sends `nosniff` and
  `Content-Security-Policy: default-src 'none'; sandbox`, so navigating a
  browser straight at EPUB XHTML gets an opaque origin with scripting off
  rather than a script at the token's origin;
- the source page is rastered here by poppler and shown as a PNG, so no PDF
  engine parses the upload in the reviewer's browser.

Typography is four `render.mjs` parameters — a font chosen by name from stacks
that file owns, and three bounded numbers — never a stylesheet a caller
supplies. Passing none of them, or passing the profile's own defaults, renders
the same bytes the job already produced.

## Run it locally

```bash
source ~/.venvs/docling/bin/activate
cd adapters/pdf/service
PDF2EPUB_TOKEN=$(openssl rand -hex 16) PDF2EPUB_DATA=/tmp/pdf2epub \
  uvicorn app:app --host 127.0.0.1 --port 8899
```

`PDF2EPUB_ALLOW_ANONYMOUS=1` drops the token for a loopback-only dev run;
without either variable the service refuses to start.

## Deploy it

`deploy.sh` writes the env file, installs the systemd unit, and — when given a
hostname — issues a certificate and installs the nginx site. It needs the venv,
a built `dist/`, nginx and certbot already on the host.

```bash
# loopback only, reached over an ssh tunnel
PDF2EPUB_TOKEN=… ./deploy.sh

# behind TLS on a hostname
PDF2EPUB_TOKEN=… ./deploy.sh pdf2epub.129-150-32-215.sslip.io
```

To update after a pull: `git pull && sudo systemctl restart pdf2epub`.
Rebuild `dist/` as well if anything under `src/` changed.

## Tests

The preview's tests need Node, a built `dist/` and poppler, but never Docling:
the fixture writes its own two-page PDF and its own draft.

```bash
~/.venvs/docling/bin/python -m pytest adapters/pdf/tests/test_service_preview.py
node adapters/pdf/tests/preview.playwright.mjs --playwright-root <dir with node_modules/playwright>
```

The Playwright run also drives a service that is already up, which is how a
deployment is checked against a job that finished before it:

```bash
PDF2EPUB_TOKEN=… node adapters/pdf/tests/preview.playwright.mjs \
  --base https://… --job <id> --shots ./shots
```

## Environment

| variable | default | meaning |
| --- | --- | --- |
| `PDF2EPUB_TOKEN` | — | shared secret; required unless `PDF2EPUB_ALLOW_ANONYMOUS=1` |
| `PDF2EPUB_DATA` | `./data` | one directory per job |
| `PDF2EPUB_MAX_BYTES` | 41943040 | upload ceiling, enforced while streaming |
| `PDF2EPUB_MAX_PAGES` | 400 | page ceiling, checked before Docling runs |
| `PDF2EPUB_TIMEOUT` | 3600 | wall clock for one conversion |
| `PDF2EPUB_QUEUE_LIMIT` | 20 | queued jobs before uploads are refused |
| `PDF2EPUB_RETENTION_HOURS` | 72 | when finished jobs are swept |
| `PDF2EPUB_KEEP_INTERMEDIATES` | unset | keep the Docling JSON and page images after a successful job (they dominate a job's footprint) |
| `PDF2EPUB_PYTHON` | this interpreter | the venv that has Docling |
| `PDF2EPUB_STRUCT_DIR` | — | passed to `render.mjs` as `--struct-dir` |
| `PDF2EPUB_PREVIEW_DPI` | 110 | resolution the preview rasters a source page at (36–300) |
| `PDF2EPUB_EXPORT_TIMEOUT` | 600 | wall clock for one export re-render |
| `PDF2EPUB_EXPORT_KEEP` | 12 | exports kept per job before the oldest are dropped |

## What to expect

The first pass over a paper spends almost all its time in Docling: about two
minutes on Apple silicon, several times that on a CPU-only host. Everything
after extraction is about 13 s for a normal paper. One job runs at a time, so a
second upload waits.
