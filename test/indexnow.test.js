import { test } from "node:test";
import assert from "node:assert/strict";
import { submit, stats } from "../server/lib/indexnow.js";
import { config } from "../server/config.js";

test("submit posts the host, key, key location and de-duplicated same-host URLs", async () => {
  config.indexNowKey = "abc123";
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { status: 202 }; };
  const status = await submit(["https://deodapper.com/routes/r_1/x", "https://deodapper.com/routes/r_1/x", "https://evil.example/", "not a url"], { fetchImpl });
  assert.equal(status, 202);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { host: "deodapper.com", key: "abc123", keyLocation: "https://deodapper.com/abc123.txt", urlList: ["https://deodapper.com/routes/r_1/x"] });
  assert.equal(stats().submitted, 1);
  assert.equal(stats().lastError, null);
});

test("off without a key; network failures are swallowed and recorded", async () => {
  config.indexNowKey = "";
  assert.equal(await submit(["https://deodapper.com/"], { fetchImpl: async () => { throw new Error("should not be called"); } }), null);
  config.indexNowKey = "abc123";
  assert.equal(await submit(["https://deodapper.com/"], { fetchImpl: async () => { throw new Error("offline"); } }), null);
  assert.equal(stats().lastError, "offline");
  assert.equal(await submit(["https://deodapper.com/"], { fetchImpl: async () => ({ status: 422 }) }), 422);
  assert.match(stats().lastError, /422/);
});
