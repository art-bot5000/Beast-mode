# ── Stage 1: build/minify the frontend ───────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /build
COPY package.json ./
RUN npm install

# The app is a single large HTML file plus the service worker, manifest, icons,
# and the model-dropdown helper. (Unlike stckrm there are no separate JS modules
# to minify on the frontend — the app logic lives inside the HTML.)
COPY beast-mode-mech-my-ride-v4.html sw.js manifest.json ./
COPY icon192.png icon512.png ./

RUN mkdir -p public && \
    npx html-minifier-terser beast-mode-mech-my-ride-v4.html \
      --collapse-whitespace --remove-comments \
      --remove-redundant-attributes --remove-script-type-attributes \
      --remove-tag-whitespace --minify-css true --minify-js true \
      -o public/index.html && \
    cp sw.js public/sw.js && \
    cp manifest.json public/manifest.json && \
    cp icon192.png public/icon192.png && \
    cp icon512.png public/icon512.png

# ── Stage 2: Deno runtime + Caddy (Brotli build) ─────────────────────────────
FROM denoland/deno:2.3.1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && \
    apt-get clean && rm -rf /var/lib/apt/lists/* && \
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=amd64&p=github.com/ueffel/caddy-brotli" \
      -o /usr/local/bin/caddy && \
    chmod +x /usr/local/bin/caddy
WORKDIR /app
COPY --from=builder /build/public/ ./public/

# Backend: the Deno entrypoint plus the provider modules we built.
# (main.ts imports the auth/account logic mirrored from stckrm + the
#  generate/models routes that call into providers/.)
COPY main.ts deno.json ./
COPY providers/ ./providers/
COPY routes/ ./routes/
RUN deno cache --unstable-kv --unstable-cron main.ts

COPY start.sh /app/start.sh
COPY Caddyfile /app/Caddyfile
RUN chmod +x /app/start.sh
EXPOSE 8080
CMD ["/app/start.sh"]
