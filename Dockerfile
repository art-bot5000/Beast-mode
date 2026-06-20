# ── Stage 1: build/minify the frontend ───────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /build
COPY package.json ./
RUN npm install

# The app is a single large HTML file plus the service worker, manifest, icons,
# and the model-dropdown helper. (Unlike stckrm there are no separate JS modules
# to minify on the frontend — the app logic lives inside the HTML.)
COPY app.html app.css admin.html sw.js manifest.json bm-auth-crypto.js ./
COPY icon192.png icon512.png ./

# Inline app.css into the <!-- BUILD:INLINE-CSS app.css --> placeholder, wrapping
# it in a single <style> block, THEN minify. Shipped artifact is a self-contained
# index.html (CSS is split only at authoring time). Done in Node (always present
# in the builder image) to avoid sed-escaping pitfalls with CSS content.
RUN mkdir -p public && \
    node -e "const fs=require('fs');const html=fs.readFileSync('app.html','utf8');const css=fs.readFileSync('app.css','utf8');if(!html.includes('<!-- BUILD:INLINE-CSS app.css -->')){console.error('CSS placeholder missing in app.html');process.exit(1);}fs.writeFileSync('app.inlined.html',html.replace('<!-- BUILD:INLINE-CSS app.css -->','<style>\n'+css+'\n</style>'));" && \
    npx html-minifier-terser app.inlined.html \
      --collapse-whitespace --remove-comments \
      --remove-redundant-attributes \
      --remove-tag-whitespace --minify-css true --minify-js true \
      -o public/index.html && \
    cp sw.js public/sw.js && \
    cp admin.html public/admin.html && \
    cp manifest.json public/manifest.json && \
    cp bm-auth-crypto.js public/bm-auth-crypto.js && \
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
COPY main.ts auth.ts oauth.ts email.ts admin.ts tokens.ts jobs.ts webauthn-verify.ts data-store.ts kv-store.ts deno.json ./
COPY index.js runware.js google.js catalog.js r2.js pricing.js ./
RUN deno cache --unstable-kv --unstable-cron main.ts

COPY start.sh /app/start.sh
COPY Caddyfile /app/Caddyfile
RUN chmod +x /app/start.sh
EXPOSE 8080
CMD ["/app/start.sh"]
