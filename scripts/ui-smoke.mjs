// Dev helper: open the plan screen in headless Chromium, load a saved plan into
// localStorage, and report console errors + a screenshot.
// Usage: node scripts/ui-smoke.mjs [http://localhost:3001] [plan-out.json]
// Needs playwright; we borrow the copy installed in ../project-workbench if present.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const base = process.argv.find((a) => a.startsWith("http")) || "http://localhost:3001";
const planFile = process.argv.find((a) => a.endsWith(".json")) || "plan-out.json";

const candidates = [
  path.resolve("node_modules/playwright"),
  path.resolve("../project-workbench/node_modules/playwright"),
];
const pwPath = candidates.find((p) => fs.existsSync(path.join(p, "package.json")));
if (!pwPath) { console.error("playwright not found"); process.exit(2); }
const { chromium } = createRequire(path.join(pwPath, "package.json"))(pwPath);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errors.push(`${m.type()}: ${m.text()}`); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

await page.goto(base + "/", { waitUntil: "networkidle" });
console.log("title:", await page.title());

if (fs.existsSync(planFile)) {
  const it = JSON.parse(fs.readFileSync(planFile, "utf8"));
  await page.evaluate((json) => localStorage.setItem("tourguide.itinerary.v1", json), JSON.stringify(it));
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  console.log("stop cards:", await page.locator(".stop").count());
  console.log("status bar:", await page.locator("#status-bar").textContent());
  console.log("markers:", await page.locator(".marker-num").count());
  console.log("dropped rows:", await page.locator("#dropped-list li").count());
}
await page.screenshot({ path: "ui-smoke.png", fullPage: false });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.screenshot({ path: "ui-smoke-phone.png", fullPage: false });

console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no console errors");
await browser.close();
