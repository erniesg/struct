#!/usr/bin/env bash
# Install (or update) the pdf2epub staging service on a host that already has
# nginx, certbot and the docling venv. Idempotent: safe to re-run after a pull.
#
#   PDF2EPUB_TOKEN=<secret> ./deploy.sh [hostname]
#
# Without a hostname the service is installed loopback-only and reached over an
# ssh tunnel; with one, nginx terminates TLS for it on that name.
set -euo pipefail

HOST="${1:-}"
PORT="${PDF2EPUB_PORT:-8010}"
REPO="${PDF2EPUB_REPO:-$HOME/code/erniesg/struct}"
VENV="${PDF2EPUB_VENV:-$HOME/.venvs/docling}"
DATA="${PDF2EPUB_DATA:-$HOME/.local/state/pdf2epub}"
HERE="$REPO/adapters/pdf/service"

[[ -n "${PDF2EPUB_TOKEN:-}" ]] || { echo "set PDF2EPUB_TOKEN to a shared secret" >&2; exit 2; }
[[ -x "$VENV/bin/uvicorn" ]] || { echo "no uvicorn in $VENV" >&2; exit 2; }
[[ -d "$REPO/dist" ]] || { echo "build the package first: (cd $REPO && npm ci && npm run build)" >&2; exit 2; }

mkdir -p "$DATA" "$HOME/.cache/docling"

sudo mkdir -p /etc/pdf2epub
sudo tee /etc/pdf2epub/pdf2epub.env >/dev/null <<ENV
PDF2EPUB_TOKEN=$PDF2EPUB_TOKEN
PDF2EPUB_DATA=$DATA
PDF2EPUB_MAX_BYTES=${PDF2EPUB_MAX_BYTES:-41943040}
PDF2EPUB_MAX_PAGES=${PDF2EPUB_MAX_PAGES:-400}
PDF2EPUB_TIMEOUT=${PDF2EPUB_TIMEOUT:-5400}
PDF2EPUB_QUEUE_LIMIT=${PDF2EPUB_QUEUE_LIMIT:-20}
PDF2EPUB_RETENTION_HOURS=${PDF2EPUB_RETENTION_HOURS:-72}
PDF2EPUB_PYTHON=$VENV/bin/python
PDF2EPUB_STRUCT_DIR=$REPO
ENV
sudo chmod 640 /etc/pdf2epub/pdf2epub.env
sudo chown root:root /etc/pdf2epub/pdf2epub.env

sed -e "s#/home/ubuntu/code/erniesg/struct#$REPO#g" \
    -e "s#/home/ubuntu/.venvs/docling#$VENV#g" \
    -e "s#/home/ubuntu/.local/state/pdf2epub#$DATA#g" \
    -e "s#--port 8010#--port $PORT#" \
    "$HERE/pdf2epub.service" | sudo tee /etc/systemd/system/pdf2epub.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now pdf2epub.service
sudo systemctl restart pdf2epub.service

for _ in $(seq 1 30); do
  sleep 1
  curl -fsS -m 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
done
curl -fsS -m 5 "http://127.0.0.1:$PORT/health" || { sudo journalctl -u pdf2epub -n 40 --no-pager; exit 1; }
echo

if [[ -z "$HOST" ]]; then
  echo "installed loopback-only on 127.0.0.1:$PORT"
  echo "reach it with:  ssh -N -L $PORT:127.0.0.1:$PORT <this host>   then open http://127.0.0.1:$PORT"
  exit 0
fi

# one shared rate-limit zone, declared once in the http block
if ! grep -qs "zone=pdf2epub" /etc/nginx/conf.d/pdf2epub-limits.conf; then
  echo 'limit_req_zone $binary_remote_addr zone=pdf2epub:10m rate=30r/m;' |
    sudo tee /etc/nginx/conf.d/pdf2epub-limits.conf >/dev/null
fi

if [[ ! -d /etc/letsencrypt/live/$HOST ]]; then
  sudo certbot certonly --nginx -d "$HOST" --non-interactive --agree-tos \
    -m "${PDF2EPUB_EMAIL:-hello@ernie.sg}"
fi

sed -e "s/PDF2EPUB_HOST/$HOST/g" -e "s#127.0.0.1:8010#127.0.0.1:$PORT#g" \
    "$HERE/nginx.conf" | sudo tee /etc/nginx/sites-available/pdf2epub >/dev/null
sudo ln -sf /etc/nginx/sites-available/pdf2epub /etc/nginx/sites-enabled/pdf2epub
sudo nginx -t
sudo systemctl reload nginx

echo
echo "pdf2epub is up at https://$HOST  (token-gated)"
curl -fsS -m 10 "https://$HOST/health"
echo
