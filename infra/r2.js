'use strict';
/**
 * infra/r2.js — zero-dependency Cloudflare R2 (S3-compatible) client.
 *
 * WHY hand-rolled: the whole app is zero-npm-dependency and the Dockerfile does
 * not run `npm install`. Pulling in @aws-sdk/client-s3 would change the build and
 * add a large transitive tree. R2's S3 API only needs AWS Signature V4, which we
 * can produce with node:crypto (HMAC-SHA256 + SHA-256). ~1 file, no deps.
 *
 * Enabled only when all of these env vars are set (otherwise the app keeps using
 * local disk exactly as before — safe to deploy before you configure R2):
 *   R2_ACCOUNT_ID          e.g. 1a2b3c...           (Cloudflare account id)
 *   R2_ACCESS_KEY_ID       R2 API token access key
 *   R2_SECRET_ACCESS_KEY   R2 API token secret
 *   R2_BUCKET              bucket name, e.g. kd-uploads
 * Optional:
 *   R2_ENDPOINT            override host (default https://<account>.r2.cloudflarestorage.com)
 *
 * The bucket stays PRIVATE. Reads are proxied by our own server (see server.js),
 * so passports/ID documents are never publicly reachable.
 */
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const REGION  = 'auto';           // R2 ignores region but SigV4 needs a value
const SERVICE = 's3';
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

function cfg() {
  const {
    R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT,
  } = process.env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null;
  const endpoint = (R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  return {
    accountId: R2_ACCOUNT_ID,
    accessKey: R2_ACCESS_KEY_ID,
    secretKey: R2_SECRET_ACCESS_KEY,
    bucket:    R2_BUCKET,
    endpoint,
    host: new URL(endpoint).host,
  };
}

function isEnabled() { return !!cfg(); }

/* ── SigV4 primitives ── */
function sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function hmac(key, data) { return crypto.createHmac('sha256', key).update(data, 'utf8').digest(); }

// AWS-style percent-encoding. Unreserved chars stay literal; '/' kept only when
// encodeSlash is false (path segments). Everything else → %XX (uppercase hex).
function awsUriEncode(str, encodeSlash) {
  let out = '';
  for (const ch of Buffer.from(String(str), 'utf8')) {
    const c = String.fromCharCode(ch);
    if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) ||
        (ch >= 0x30 && ch <= 0x39) || c === '-' || c === '_' || c === '.' || c === '~') {
      out += c;
    } else if (c === '/' && !encodeSlash) {
      out += '/';
    } else {
      out += '%' + ch.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/**
 * Build the Authorization header (+ the signed x-amz-* headers) for a request.
 * Exposed so it can be unit-tested against the published AWS SigV4 test vector.
 */
function signV4({ method, host, canonicalUri, query = {}, headers, payloadHash, accessKey, secretKey, amzDate, region = REGION, service = SERVICE }) {
  const dateStamp = amzDate.slice(0, 8);

  // Canonical query string — keys & values URI-encoded, sorted by key.
  const canonicalQuery = Object.keys(query).sort().map(k =>
    awsUriEncode(k, true) + '=' + awsUriEncode(query[k], true)).join('&');

  // Canonical headers — lowercased names, trimmed values, sorted, trailing \n each.
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = String(headers[k]).trim();
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map(n => n + ':' + lower[n] + '\n').join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate    = hmac('AWS4' + secretKey, dateStamp);
  const kRegion  = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { authorization, signedHeaders, signature };
}

/* ── R2 object operations ── */
function amzNow() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

async function r2Request(method, key, { body = null, contentType } = {}) {
  const c = cfg();
  if (!c) throw new Error('R2 not configured');

  const payloadHash = body != null ? sha256hex(body) : EMPTY_SHA256;
  const amzDate = amzNow();
  // Path-style: /<bucket>/<key>. Encode each segment but keep the slashes.
  const canonicalUri = '/' + awsUriEncode(c.bucket, true) + '/' + awsUriEncode(key, false);

  const signedInput = {
    host: c.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const { authorization } = signV4({
    method, host: c.host, canonicalUri, headers: signedInput, payloadHash,
    accessKey: c.accessKey, secretKey: c.secretKey, amzDate,
  });

  const outHeaders = { ...signedInput, authorization };
  if (contentType) outHeaders['content-type'] = contentType;   // sent unsigned (not in SignedHeaders)

  const res = await fetch(c.endpoint + canonicalUri, { method, headers: outHeaders, body });
  return res;
}

/** Upload a Buffer. Throws on non-2xx. */
async function put(key, buffer, contentType) {
  const res = await r2Request('PUT', key, { body: buffer, contentType });
  if (!res.ok) throw new Error(`R2 PUT ${key} → ${res.status} ${await res.text().catch(() => '')}`);
  return true;
}

/** GET → object with headers + ONE-SHOT body readers. A fetch body can only be
 *  consumed once, so call EITHER stream() OR buffer(), not both. */
async function get(key) {
  const res = await r2Request('GET', key);
  return {
    ok: res.ok, status: res.status,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    contentLength: res.headers.get('content-length'),
    etag: res.headers.get('etag'),
    hasBody: !!(res.ok && res.body),
    stream() { return res.body ? Readable.fromWeb(res.body) : null; },
    async buffer() { return Buffer.from(await res.arrayBuffer()); },
  };
}

/** HEAD → { exists, size }. */
async function head(key) {
  const res = await r2Request('HEAD', key);
  return { exists: res.ok, size: Number(res.headers.get('content-length') || 0), status: res.status };
}

/** DELETE. Treats 404 as success (already gone). */
async function del(key) {
  const res = await r2Request('DELETE', key);
  if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} → ${res.status}`);
  return true;
}

/**
 * Self-check the signer against AWS's published SigV4 example (get-vanilla):
 *   GET https://example.amazonaws.com/  (service, region below), no query,
 *   expected signature is a fixed constant. Proves the HMAC chain + canonical
 *   request are correct WITHOUT needing real credentials. Returns true/false.
 */
function selfTestSigner() {
  const { authorization } = signV4({
    method: 'GET',
    host: 'example.amazonaws.com',
    canonicalUri: '/',
    query: {},
    headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
    payloadHash: EMPTY_SHA256,
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    amzDate: '20150830T123600Z',
    region: 'us-east-1',
    service: 'service',
  });
  // Expected from the AWS SigV4 test suite (get-vanilla.authz).
  const expected = 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
    'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31';
  return { ok: authorization === expected, got: authorization, expected };
}

module.exports = { isEnabled, cfg, put, get, head, del, signV4, awsUriEncode, selfTestSigner };
