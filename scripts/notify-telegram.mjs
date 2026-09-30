#!/usr/bin/env node
// Announce newly merged ecosystem projects on Telegram and X.
//
// Runs from .github/workflows/notify-telegram.yml on every push to main that
// touches ecosystem/**. It diffs the push range for *added* project files and
// posts one message per project to each configured channel:
//   Telegram: TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
//   X:        X_API_KEY + X_API_SECRET + X_ACCESS_TOKEN + X_ACCESS_SECRET
//             (OAuth 1.0a user context for the @lighter_hub account)
// A channel whose secrets are missing is skipped with a log line.
//
// Manual test: the workflow's "Run workflow" button with a slug, or locally
// `SLUG=botlyz node scripts/notify-telegram.mjs`.

import { createHmac, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const X = {
  key: process.env.X_API_KEY,
  secret: process.env.X_API_SECRET,
  token: process.env.X_ACCESS_TOKEN,
  tokenSecret: process.env.X_ACCESS_SECRET,
};
const X_ENABLED = Boolean(X.key && X.secret && X.token && X.tokenSecret);
const TELEGRAM_ENABLED = Boolean(TOKEN && CHAT_ID);
const SITE_URL = (process.env.SITE_URL || "https://lit-hub.org").replace(/\/$/, "");
const REPO = process.env.GITHUB_REPOSITORY || "techcobain/lit_hub_ecosystem";
const AFTER = process.env.AFTER || "HEAD";
const BEFORE = process.env.BEFORE || "";
const ZERO = "0000000000000000000000000000000000000000";

function addedSlugs() {
  if (process.env.SLUG) return process.env.SLUG.split(",").map((s) => s.trim()).filter(Boolean);
  if (!BEFORE || BEFORE === ZERO) {
    console.log("No previous commit in this push (new branch or force push); nothing to announce.");
    return [];
  }
  const out = execSync(`git diff --name-only --diff-filter=A ${BEFORE} ${AFTER} -- 'ecosystem/*.json'`, {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((f) => path.basename(f, ".json"));
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function socialUrl(kind, value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, "");
  if (kind === "x") return `https://x.com/${handle}`;
  if (kind === "telegram") return `https://t.me/${handle}`;
  return null;
}

function logoUrl(project) {
  const logo = String(project.logo ?? "");
  if (!logo.startsWith("/logos/")) return null;
  // Telegram's sendPhoto accepts raster images only.
  if (!/\.(png|jpe?g|webp|gif)$/i.test(logo)) return null;
  return `https://raw.githubusercontent.com/${REPO}/${AFTER}/public${logo}`;
}

function buildMessage(slug, p) {
  const pageUrl = `${SITE_URL}/ecosystem/${encodeURIComponent(slug)}`;
  const links = [
    p.url && `<a href="${esc(p.url)}">Website</a>`,
    socialUrl("x", p.twitter) && `<a href="${esc(socialUrl("x", p.twitter))}">𝕏</a>`,
    socialUrl("telegram", p.telegram) && `<a href="${esc(socialUrl("telegram", p.telegram))}">Telegram</a>`,
    /^https?:\/\//i.test(p.discord ?? "") && `<a href="${esc(p.discord)}">Discord</a>`,
    `<a href="${pageUrl}">lit-hub page</a>`,
  ].filter(Boolean);
  const categories = p.categories ?? [];
  const status =
    p.status && p.status !== "Live"
      ? ` <i>(${esc(p.status === "Not Live" ? "coming soon" : p.status.toLowerCase())})</i>`
      : "";
  return [
    `🆕 <b>${esc(p.name)}</b> just joined <a href="${SITE_URL}">lit-hub.org</a>${status}`,
    "",
    p.description ? `<b>Description</b>: <i>${esc(p.description)}</i>` : null,
    categories.length
      ? `<b>${categories.length === 1 ? "Category" : "Categories"}</b>: ${categories.map(esc).join(", ")}`
      : null,
    "",
    links.join(" · "),
  ]
    .filter((l) => l !== null)
    .join("\n");
}

// --- X ---

const X_LIMIT = 280;
const X_URL_WEIGHT = 23; // every URL counts as 23 characters on X

function xHandle(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  const m = v.match(/^(?:https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\/)?@?([A-Za-z0-9_]{1,15})\/?$/);
  return m ? `@${m[1]}` : null;
}

function xLength(text) {
  return text.replace(/https?:\/\/\S+/g, "x".repeat(X_URL_WEIGHT)).length;
}

// Plain text (X has no formatting): who joined, and their one-liner. The
// project's own handle is mentioned when known so they see it.
function buildPost(slug, p) {
  const handle = xHandle(p.twitter);
  const pageUrl = `${SITE_URL}/ecosystem/${encodeURIComponent(slug)}`;
  const head = `🆕 ${p.name}${handle ? ` (${handle})` : ""} just joined @lighter_hub`;
  const compose = (description) =>
    [head, description ? `\n${description}` : null, `\n${pageUrl}`].filter(Boolean).join("\n");
  let description = String(p.description ?? "").trim();
  let text = compose(description);
  while (xLength(text) > X_LIMIT && description.length > 20) {
    description = description.slice(0, description.length - 10).trimEnd() + "…";
    text = compose(description);
  }
  return text;
}

function pct(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// OAuth 1.0a HMAC-SHA1 header for a JSON POST (only the oauth params are signed).
function oauthHeader(method, url) {
  const params = {
    oauth_consumer_key: X.key,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: X.token,
    oauth_version: "1.0",
  };
  const base = [
    method.toUpperCase(),
    pct(url),
    pct(Object.keys(params).sort().map((k) => `${pct(k)}=${pct(params[k])}`).join("&")),
  ].join("&");
  const signingKey = `${pct(X.secret)}&${pct(X.tokenSecret)}`;
  params.oauth_signature = createHmac("sha1", signingKey).update(base).digest("base64");
  return "OAuth " + Object.keys(params).sort().map((k) => `${pct(k)}="${pct(params[k])}"`).join(", ");
}

async function postToX(slug, project) {
  const text = buildPost(slug, project);
  const url = "https://api.x.com/2/tweets";
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: oauthHeader("POST", url), "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.detail || data.title || (data.errors && data.errors[0]?.message) || res.status;
    throw new Error(`X: ${detail}`);
  }
  console.log(`posted ${slug} on X (id ${data.data?.id})`);
}

// --- Telegram ---

async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data;
}

async function announce(slug) {
  const file = path.join(ROOT, "ecosystem", `${slug}.json`);
  if (!existsSync(file)) {
    console.warn(`skip ${slug}: no such project file`);
    return;
  }
  const project = JSON.parse(readFileSync(file, "utf8"));
  const text = buildMessage(slug, project);
  const photo = logoUrl(project);
  try {
    if (photo) {
      await tg("sendPhoto", { chat_id: CHAT_ID, photo, caption: text, parse_mode: "HTML" });
    } else {
      await tg("sendMessage", { chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: false });
    }
    console.log(`announced ${slug}`);
  } catch (err) {
    // A rejected photo (odd size, unreachable) shouldn't lose the announcement.
    if (photo) {
      console.warn(`photo failed for ${slug} (${err.message}); sending text only`);
      await tg("sendMessage", { chat_id: CHAT_ID, text, parse_mode: "HTML" });
      console.log(`announced ${slug} (text)`);
    } else {
      throw err;
    }
  }
}

const slugs = addedSlugs();
if (slugs.length === 0) {
  console.log("No new projects in this push.");
  process.exit(0);
}
if (!TELEGRAM_ENABLED) console.log("Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing); skipping.");
if (!X_ENABLED) console.log("X not configured (X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_SECRET missing); skipping.");
if (!TELEGRAM_ENABLED && !X_ENABLED) {
  console.log(`Would announce: ${slugs.join(", ")}`);
  process.exit(0);
}
let failed = 0;
for (const slug of slugs) {
  const file = path.join(ROOT, "ecosystem", `${slug}.json`);
  if (!existsSync(file)) {
    console.warn(`skip ${slug}: no such project file`);
    continue;
  }
  if (TELEGRAM_ENABLED) {
    try {
      await announce(slug);
    } catch (err) {
      failed++;
      console.error(`Telegram failed for ${slug}: ${err.message}`);
    }
  }
  if (X_ENABLED) {
    try {
      await postToX(slug, JSON.parse(readFileSync(file, "utf8")));
    } catch (err) {
      failed++;
      console.error(`X failed for ${slug}: ${err.message}`);
    }
  }
}
process.exit(failed ? 1 : 0);
