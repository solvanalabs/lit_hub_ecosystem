import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCardRenderer, readProject, validateSlug } from "../scripts/render-announcement.mjs";
import { postCardToX } from "../scripts/x-card.mjs";
import { buildPost, runAnnouncements } from "../scripts/notify-telegram.mjs";

let renderer, temp, example;
before(async () => {
  temp = await mkdtemp(path.join(tmpdir(), "lit-hub-card-test-"));
  renderer = await createCardRenderer();
  example = await renderer.render(await readProject("telegram-wallet"), path.join(temp, "telegram.png"));
});
after(async () => {
  await renderer?.close();
  if (temp) await rm(temp, { recursive: true, force: true });
});

test("JSON project name and original PNG produce a 1600x900 two-line card", () => {
  assert.equal(example.png.readUInt32BE(16), 1600);
  assert.equal(example.png.readUInt32BE(20), 900);
  assert.equal(example.layout.name, "Telegram Wallet");
  assert.equal(example.layout.fontSize, "144px");
  assert.ok(example.layout.title.height > 250);
  assert.ok(example.layout.title.y + example.layout.title.height < example.layout.tagline.y);
  assert.equal(example.fallbackLogo, false);
});

test("same inputs render identical PNGs", async () => {
  const again = await renderer.render(await readProject("telegram-wallet"), path.join(temp, "again.png"));
  assert.deepEqual(again.png, example.png);
});

for (const slug of ["insilico-terminal", "infinex", "defillama", "oka-finance", "lighter-mcp-by-senya"]) {
  test(`catalog logo format and name fit: ${slug}`, async () => {
    const p = await readProject(slug);
    const { layout, fallbackLogo } = await renderer.render(p, path.join(temp, `${slug}.png`));
    assert.equal(layout.name, p.name);
    assert.equal(fallbackLogo, !p.logo);
    assert.ok(layout.title.x + layout.title.width < layout.logo.x);
    assert.ok(layout.tagline.y + layout.tagline.height < 785);
  });
}

test("long project names shrink without clipping; markup stays literal", async () => {
  const name = 'A Very Long Project <img src=x> & Research Infrastructure';
  const result = await renderer.render({ name, logo: "" }, path.join(temp, "long.png"));
  assert.equal(result.layout.name, name);
  assert.ok(parseFloat(result.layout.fontSize) < 144);
  assert.ok(result.layout.tagline.y + result.layout.tagline.height < 785);
  assert.equal(result.fallbackLogo, true);
});

test("rejects invalid slug, empty name and missing or nonlocal configured logos", async () => {
  assert.throws(() => validateSlug("../../etc/passwd"), /Invalid project slug/);
  await assert.rejects(renderer.render({ name: " " }, path.join(temp, "bad.png")), /Project name/);
  await assert.rejects(renderer.render({ name: "Test", logo: "https://example.com/logo.png" }, path.join(temp, "bad.png")), /local/);
  await assert.rejects(renderer.render({ name: "Test", logo: "/logos/does-not-exist.png" }, path.join(temp, "bad.png")), /ENOENT/);
});

const credentials = { key: "test-key", secret: "test-secret", token: "test-token", tokenSecret: "test-token-secret" };
const response = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});

test("X uploads the actual PNG then attaches its returned ID to the unchanged text", async () => {
  const calls = [];
  const result = await postCardToX({ text: "Existing announcement text", png: example.png, credentials,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response({ data: { id: calls.length === 1 ? "1234567891234567890" : "999" } });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.x.com/2/media/upload");
  assert.equal(calls[0].body.media_category, "tweet_image");
  assert.deepEqual(Buffer.from(calls[0].body.media, "base64"), example.png);
  assert.match(calls[0].options.headers.authorization, /^OAuth .*oauth_signature=/);
  assert.equal(calls[1].url, "https://api.x.com/2/tweets");
  assert.deepEqual(calls[1].body, { text: "Existing announcement text", media: { media_ids: ["1234567891234567890"] } });
  assert.deepEqual(result, { postId: "999", mediaId: "1234567891234567890" });
});

for (const [label, data, status] of [
  ["permission denied", { detail: "Forbidden" }, 403],
  ["missing media ID", { data: {} }, 200],
  ["pending image", { data: { id: "123", processing_info: { state: "pending" } } }, 200],
  ["partial API error", { data: { id: "123" }, errors: [{ detail: "Rejected" }] }, 200],
]) {
  test(`no text-only post when upload returns ${label}`, async () => {
    let calls = 0;
    await assert.rejects(postCardToX({ text: "Test", png: example.png, credentials,
      fetchImpl: async () => { calls++; return response(data, status); },
    }));
    assert.equal(calls, 1);
  });
}

test("no automatic retry after ambiguous post timeout", async () => {
  let calls = 0;
  await assert.rejects(postCardToX({ text: "Test", png: example.png, credentials,
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return response({ data: { id: "123" } });
      throw new Error("Request timed out");
    },
  }), /timed out/);
  assert.equal(calls, 2);
});

test("missing credentials or invalid PNG cannot make a request", async () => {
  const fetchImpl = async () => assert.fail("must not send a request");
  await assert.rejects(postCardToX({ text: "Test", png: example.png, credentials: {}, fetchImpl }), /Missing X credential/);
  await assert.rejects(postCardToX({ text: "Test", png: Buffer.from("bad"), credentials, fetchImpl }), /PNG/);
});

test("full notifier dry run renders JSON-based cards and text without contacting either channel", async () => {
  const outputDir = path.join(temp, "dry-run");
  const code = await runAnnouncements({
    slugs: ["telegram-wallet"], dryRun: true, xEnabled: true, telegramEnabled: true,
    credentials, outputDir, fetchImpl: async () => assert.fail("dry run must not contact X or Telegram"),
  });
  assert.equal(code, 0);
  const png = await readFile(path.join(outputDir, "telegram-wallet.png"));
  assert.deepEqual(png, example.png);
  const project = await readProject("telegram-wallet");
  assert.equal(await readFile(path.join(outputDir, "telegram-wallet.txt"), "utf8"), buildPost("telegram-wallet", project) + "\n");
});

test("full notifier renders each project and attaches its own media ID, using one browser", async () => {
  const calls = [];
  let created = 0, closed = 0;
  const outputDir = path.join(temp, "notifier");
  const code = await runAnnouncements({
    slugs: ["telegram-wallet", "vooi", "telegram-wallet"], dryRun: false,
    xEnabled: true, telegramEnabled: false, credentials, outputDir,
    rendererFactory: async () => {
      created++;
      const instance = await createCardRenderer();
      return { render: instance.render, close: async () => { closed++; await instance.close(); } };
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return response({ data: { id: String(calls.length) } });
    },
  });
  assert.equal(code, 0);
  assert.equal(created, 1);
  assert.equal(closed, 1);
  assert.equal(calls.length, 4);
  for (const [index, slug] of ["telegram-wallet", "vooi"].entries()) {
    const upload = calls[index * 2];
    assert.deepEqual(Buffer.from(upload.body.media, "base64"), await readFile(path.join(outputDir, `${slug}.png`)));
    assert.deepEqual(calls[index * 2 + 1].body, {
      text: buildPost(slug, await readProject(slug)), media: { media_ids: [String(index * 2 + 1)] },
    });
  }
  assert.notEqual(calls[0].body.media, calls[2].body.media);
});

test("full notifier fails without posting when rendering fails and still closes the browser", async () => {
  let closed = false;
  const code = await runAnnouncements({
    slugs: ["telegram-wallet"], dryRun: false, xEnabled: true, telegramEnabled: false,
    credentials, outputDir: path.join(temp, "failure"),
    rendererFactory: async () => ({
      render: async () => { throw new Error("Corrupt logo"); },
      close: async () => { closed = true; },
    }),
    fetchImpl: async () => assert.fail("must not post without a card"),
  });
  assert.equal(code, 1);
  assert.equal(closed, true);
});

test("unconfigured channels and empty batches do not launch a browser or publish", async () => {
  const options = {
    dryRun: false, xEnabled: false, telegramEnabled: false,
    rendererFactory: async () => assert.fail("no browser needed"),
    fetchImpl: async () => assert.fail("no network needed"),
  };
  assert.equal(await runAnnouncements({ ...options, slugs: ["telegram-wallet"] }), 0);
  assert.equal(await runAnnouncements({ ...options, slugs: [] }), 0);
});
