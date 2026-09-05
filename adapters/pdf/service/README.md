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

## What to expect

The first pass over a paper spends almost all its time in Docling: about two
minutes on Apple silicon, several times that on a CPU-only host. Everything
after extraction is about 13 s for a normal paper. One job runs at a time, so a
second upload waits.
