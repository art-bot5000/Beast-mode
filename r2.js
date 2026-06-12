// providers/r2.js
//
// Re-hosts generated images to Cloudflare R2 so saved library entries don't
// break when Runware's temporary image URLs expire.
//
// Flow: backend fetches the bytes from Runware's URL, PUTs them to R2 with a
// hand-rolled AWS SigV4 signature (same approach stckrm uses for its R2
// backups), and returns a durable public URL.
//
// Required env (Fly secrets):
//   R2_ACCOUNT_ID        - Cloudflare account id (part of the endpoint host)
//   R2_ACCESS_KEY_ID     - R2 access key
//   R2_SECRET_ACCESS_KEY - R2 secret key
//   R2_BUCKET            - bucket name
//   R2_PUBLIC_BASE       - public URL base for the bucket (custom domain or
//                          r2.dev URL), e.g. https://img.yourdomain.com
//                          The returned image URL is `${R2_PUBLIC_BASE}/${key}`.
//
// If R2 is not configured, rehosting is SKIPPED and the original Runware URL is
// used (graceful fallback — generation still works, images just aren't durable).

const enc = new TextEncoder();

function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const publicBase = process.env.R2_PUBLIC_BASE;
  if (!accountId || !accessKey || !secretKey || !bucket || !publicBase) return null;
  return { accountId, accessKey, secretKey, bucket, publicBase };
}

/** True if R2 rehosting is available. */
export function r2Enabled() {
  return r2Config() !== null;
}

// ── SigV4 helpers ─────────────────────────────────────────────────────────────
async function sha256Hex(data) {
  const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

async function signingKey(secret, date, region, service) {
  let k = await hmac(enc.encode('AWS4' + secret), date);
  k = await hmac(k, region);
  k = await hmac(k, service);
  k = await hmac(k, 'aws4_request');
  return k;
}

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fetch an image from a (Runware) URL and store it in R2.
 * @param {string} sourceUrl  The image URL returned by the provider.
 * @param {string} key        Object key in the bucket, e.g. "gen/2026/abc.jpg".
 * @returns {Promise<string>} The durable public URL.
 */
export async function rehostToR2(sourceUrl, key) {
  const cfg = r2Config();
  if (!cfg) throw new Error('R2 not configured');

  // 1) Fetch the bytes.
  const srcRes = await fetch(sourceUrl);
  if (!srcRes.ok) throw new Error(`Failed to fetch source image: HTTP ${srcRes.status}`);
  const bytes = new Uint8Array(await srcRes.arrayBuffer());
  const contentType = srcRes.headers.get('content-type') || 'image/jpeg';

  // Delegate the signing + upload to the bytes path (single implementation).
  return rehostBytesToR2(bytes, contentType, key);
}

/**
 * Upload bytes you ALREADY hold to R2 — no fetch, no re-encode. This is the
 * memory-efficient path for providers that return inline image bytes (the
 * direct Gemini adapter): the base64 is decoded to a Uint8Array ONCE by the
 * caller and handed straight here, instead of being wrapped in a data: URI and
 * re-parsed by fetch() (which kept several MB-scale copies alive at once and
 * OOM-killed a 256mb machine on 4K images).
 *
 * @param {Uint8Array} bytes
 * @param {string} contentType  e.g. "image/png"
 * @param {string} key          R2 object key
 * @returns {Promise<string>}   durable public URL
 */
export async function rehostBytesToR2(bytes, contentType, key) {
  const cfg = r2Config();
  if (!cfg) throw new Error('R2 not configured');
  contentType = contentType || 'image/jpeg';

  // Build a signed PUT to R2's S3 API.
  const region = 'auto';
  const service = 's3';
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const endpoint = `https://${host}/${cfg.bucket}/${key}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = await sha256Hex(bytes);
  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'PUT',
    `/${cfg.bucket}/${key}`,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const key1 = await signingKey(cfg.secretKey, dateStamp, region, service);
  const signature = hex(await hmac(key1, stringToSign));
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const putRes = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      'Authorization': authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'Content-Type': contentType,
    },
    body: bytes,
  });
  if (!putRes.ok) {
    const txt = await putRes.text().catch(() => '');
    throw new Error(`R2 PUT failed: HTTP ${putRes.status} ${txt.slice(0, 120)}`);
  }

  return `${cfg.publicBase.replace(/\/$/, '')}/${key}`;
}

// ── List / delete / trim (FIFO retention) ────────────────────────────────────
// Signs a request with an optional canonical query string (needed for
// ListObjectsV2). Query keys+values must be URL-encoded and sorted by key.

async function signedR2Fetch(method, pathAfterHost, queryPairs, bodyBytes) {
  const cfg = r2Config();
  if (!cfg) throw new Error('R2 not configured');
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;

  const sortedQuery = (queryPairs || [])
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = await sha256Hex(bodyBytes || '');

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, pathAfterHost, sortedQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');

  const region = 'auto', service = 's3';
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  const sk = await signingKey(cfg.secretKey, dateStamp, region, service);
  const signature = hex(await hmac(sk, stringToSign));

  const url = `https://${host}${pathAfterHost}${sortedQuery ? '?' + sortedQuery : ''}`;
  return fetch(url, {
    method,
    headers: {
      'Authorization': `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    },
    body: bodyBytes,
  });
}

/** List object keys under a prefix, with last-modified timestamps. */
export async function listR2(prefix) {
  const cfg = r2Config();
  if (!cfg) throw new Error('R2 not configured');
  const res = await signedR2Fetch('GET', `/${cfg.bucket}`, [
    ['list-type', '2'],
    ['prefix', prefix],
  ]);
  if (!res.ok) throw new Error(`R2 list failed: HTTP ${res.status}`);
  const xml = await res.text();
  // Parse <Contents><Key>..</Key><LastModified>..</LastModified>...</Contents>
  const out = [];
  const re = /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<\/Contents>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({ key: m[1], lastModified: new Date(m[2]).getTime() });
  }
  return out;
}

/** Delete a single object. */
export async function deleteFromR2(key) {
  const cfg = r2Config();
  if (!cfg) throw new Error('R2 not configured');
  const res = await signedR2Fetch('DELETE', `/${cfg.bucket}/${key}`);
  // 204 = deleted; 404 = already gone (fine either way)
  if (!res.ok && res.status !== 404) throw new Error(`R2 delete failed: HTTP ${res.status}`);
}

/**
 * FIFO retention: keep only the newest `keep` objects under a prefix, delete
 * the rest (oldest first). Designed to be fire-and-forget after each upload.
 */
export async function trimR2ToNewest(prefix, keep) {
  const items = await listR2(prefix);
  if (items.length <= keep) return 0;
  items.sort((a, b) => b.lastModified - a.lastModified); // newest first
  const toDelete = items.slice(keep);
  for (const item of toDelete) {
    try { await deleteFromR2(item.key); } catch { /* best-effort */ }
  }
  return toDelete.length;
}

// ── Presigned URLs (SigV4 query-string auth) ─────────────────────────────────
// Used for the zero-knowledge thumbnail lane: the BROWSER PUTs encrypted bytes
// straight to R2 and GETs them back, so plaintext never touches our server or
// Cloudflare. The server only signs the URL (secrets stay here), it never sees
// the ciphertext body. Payload hash is UNSIGNED-PAYLOAD: the body is opaque to
// the signer by design. Only `host` is signed, matching presigned-URL rules.
async function presignR2(method, key, expiresSec) {
  const cfg = r2Config();
  if (!cfg) throw new Error('R2 not configured');
  const region = 'auto', service = 's3';
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${cfg.bucket}/${key}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const q = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKey}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSec || 300)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = q
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const sk = await signingKey(cfg.secretKey, dateStamp, region, service);
  const signature = hex(await hmac(sk, stringToSign));
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Presigned PUT URL — browser uploads encrypted thumbnail bytes directly. */
export async function presignR2Put(key, expiresSec = 300) {
  return presignR2('PUT', key, expiresSec);
}

/** Presigned GET URL — browser downloads encrypted thumbnail bytes directly. */
export async function presignR2Get(key, expiresSec = 300) {
  return presignR2('GET', key, expiresSec);
}
