/**
 * Cloudflare R2 read client — fetches order PDFs that bail-watch
 * already saved to the `sharadmcp` bucket. We do NOT write here.
 *
 * Keys follow bail-watch's convention:
 *   case-types/{slug}/{CNR}/manifest.json
 *   case-types/{slug}/{CNR}/order-{N}.pdf
 *   case-types/{slug}/{CNR}/case.json
 */

const { S3Client, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const ENDPOINT  = process.env.R2_ENDPOINT;
const BUCKET    = process.env.R2_BUCKET || 'sharadmcp';
const KEY_ID    = process.env.R2_ACCESS_KEY_ID;
const SECRET    = process.env.R2_SECRET_ACCESS_KEY;

let _client = null;
function client() {
  if (_client) return _client;
  if (!ENDPOINT || !KEY_ID || !SECRET) {
    throw new Error('R2 credentials missing — set R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY');
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: ENDPOINT,
    credentials: { accessKeyId: KEY_ID, secretAccessKey: SECRET }
  });
  return _client;
}

// Fetch an object as a Buffer. Used for OCR + Datalab submission.
async function getObjectBuffer(key) {
  const c = client();
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const res = await c.send(cmd);
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return {
    buffer: Buffer.concat(chunks),
    contentType: res.ContentType,
    contentLength: res.ContentLength,
    lastModified: res.LastModified
  };
}

// Fetch an object as JSON. Used to read case.json / manifest.json.
async function getObjectJson(key) {
  const { buffer } = await getObjectBuffer(key);
  return JSON.parse(buffer.toString('utf8'));
}

// Generate a time-limited presigned URL the frontend can use to
// download a PDF directly from R2 (no proxying through our server).
async function presignDownloadUrl(key, { expiresIn = 3600 } = {}) {
  const c = client();
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(c, cmd, { expiresIn });
}

// Quick existence + size probe.
async function head(key) {
  try {
    const c = client();
    const cmd = new HeadObjectCommand({ Bucket: BUCKET, Key: key });
    const res = await c.send(cmd);
    return { exists: true, bytes: res.ContentLength, contentType: res.ContentType };
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return { exists: false };
    throw e;
  }
}

// Resolve a manifest for a (slug, cnr) — returns the list of order
// PDFs available in R2 for this case.
async function getCaseManifest(slug, cnr) {
  const key = `case-types/${slug}/${cnr}/manifest.json`;
  try {
    return await getObjectJson(key);
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

// Same for case.json (the parsed metadata bail-watch stored).
async function getCaseJson(slug, cnr) {
  const key = `case-types/${slug}/${cnr}/case.json`;
  try {
    return await getObjectJson(key);
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

module.exports = {
  getObjectBuffer,
  getObjectJson,
  presignDownloadUrl,
  head,
  getCaseManifest,
  getCaseJson,
  BUCKET
};
