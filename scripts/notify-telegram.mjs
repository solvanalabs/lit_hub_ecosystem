#!/usr/bin/env node
// Post newly merged ecosystem projects to a Telegram channel.
//
// Runs from .github/workflows/notify-telegram.yml on every push to main that
// touches ecosystem/**. It diffs the push range for *added* project files and
// sends one message per project. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
// as repository secrets; without them the script logs and exits cleanly.
//
// Manual test: `SLUG=botlyz node scripts/notify-telegram.mjs` (or the
// workflow's "Run workflow" button with a slug) posts that project.

import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
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
  const links = [
    p.url && `<a href="${esc(p.url)}">Website</a>`,
    socialUrl("x", p.twitter) && `<a href="${esc(socialUrl("x", p.twitter))}">X</a>`,
    socialUrl("telegram", p.telegram) && `<a href="${esc(socialUrl("telegram", p.telegram))}">Telegram</a>`,
    /^https?:\/\//i.test(p.discord ?? "") && `<a href="${esc(p.discord)}">Discord</a>`,
    `<a href="${SITE_URL}/ecosystem/${encodeURIComponent(slug)}">Lit Hub page</a>`,
  ].filter(Boolean);
  const tags = [...(p.categories ?? []), ...(p.instances ?? [])].map(esc).join(" · ");
  const status = p.status && p.status !== "Live" ? ` <i>(${esc(p.status === "Not Live" ? "coming soon" : p.status.toLowerCase())})</i>` : "";
  return [
    `🆕 <b>${esc(p.name)}</b> just joined Lit Hub${status}`,
    p.description ? `<i>${esc(p.description)}</i>` : null,
    tags ? tags : null,
    "",
    links.join(" · "),
  ]
    .filter((l) => l !== null)
    .join("\n");
}

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
if (!TOKEN || !CHAT_ID) {
  console.log(`Telegram not configured (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing); would announce: ${slugs.join(", ")}`);
  process.exit(0);
}
let failed = 0;
for (const slug of slugs) {
  try {
    await announce(slug);
  } catch (err) {
    failed++;
    console.error(`failed ${slug}: ${err.message}`);
  }
}
process.exit(failed ? 1 : 0);
