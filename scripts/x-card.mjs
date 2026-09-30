// Upload a generated card and attach it to the existing X announcement text.
import { createHmac, randomBytes } from "node:crypto";

const UPLOAD_URL = "https://api.x.com/2/media/upload";
const POST_URL = "https://api.x.com/2/tweets";
const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) =>
  `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function oauthHeader(method, url, credentials, {
  nonce = randomBytes(16).toString("hex"), timestamp = Math.floor(Date.now() / 1000),
} = {}) {
  for (const key of ["key", "secret", "token", "tokenSecret"]) {
    if (!credentials?.[key]) throw new Error(`Missing X credential: ${key}`);
  }
  const params = {
    oauth_consumer_key: credentials.key, oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(timestamp),
    oauth_token: credentials.token, oauth_version: "1.0",
  };
  // JSON bodies are not included in OAuth 1.0a parameter normalization.
  const normalized = Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join("&");
  const base = [method.toUpperCase(), pct(url), pct(normalized)].join("&");
  params.oauth_signature = createHmac("sha1", `${pct(credentials.secret)}&${pct(credentials.tokenSecret)}`)
    .update(base).digest("base64");
  return "OAuth " + Object.keys(params).sort().map((k) => `${pct(k)}="${pct(params[k])}"`).join(", ");
}

export async function postCardToX({ text, png, credentials, fetchImpl = fetch }) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Post text is required");
  if (!Buffer.isBuffer(png) || png.length < 8 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("A generated PNG card is required");
  }
  if (png.length > 5 * 1024 * 1024) throw new Error("PNG card exceeds 5 MiB");
  async function request(url, body) {
    // Never automatically retry uploads or posts: a timeout may follow success.
    const response = await fetchImpl(url, {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { authorization: oauthHeader("POST", url, credentials), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.errors?.length) {
      throw new Error(`X ${url === UPLOAD_URL ? "media upload" : "post"}: ${data.detail || data.title || data.errors?.[0]?.detail || response.status}`);
    }
    return data;
  }
  // X's current OpenAPI supports UserToken (OAuth 1.0a) for this endpoint,
  // including the existing four X_* secrets. PNG is encoded in the JSON body.
  const upload = await request(UPLOAD_URL, { media: png.toString("base64"), media_category: "tweet_image" });
  const mediaId = upload.data?.id;
  if (typeof mediaId !== "string" || !/^\d+$/.test(mediaId)) throw new Error("X upload returned no valid media ID");
  const state = upload.data?.processing_info?.state;
  if (state && state !== "succeeded") throw new Error(`X image is not ready (${state}); no post sent`);
  const post = await request(POST_URL, { text, media: { media_ids: [mediaId] } });
  if (!post.data?.id) throw new Error("X post returned no post ID; verify X before retrying");
  return { postId: post.data.id, mediaId };
}
