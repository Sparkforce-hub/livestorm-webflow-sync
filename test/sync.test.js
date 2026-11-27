// Offline test: fakes Livestorm + Webflow with an in-memory fetch.
// Run: npm test   (no tokens or network needed)
import assert from "node:assert/strict";

process.env.LIVESTORM_API_TOKEN = "test";
process.env.WEBFLOW_TOKEN = "test";
process.env.WEBFLOW_COLLECTION_ID = "COL";
process.env.CRON_SECRET = "cron-secret";
process.env.LIVESTORM_WEBHOOK_SECRET = "hook-secret";

const now = Math.floor(Date.now() / 1000);
const DAY = 86400;
const lsEvents = [
  { id: "ev-aaaaaaaa-1", type: "events", attributes: { title: "Future webinar", description: "<p onclick=\"x()\">Hello&nbsp;<strong>world</strong></p><script>alert(1)</script>", status: "published" } },
  { id: "ev-bbbbbbbb-2", type: "events", attributes: { title: "No sessions yet", description: "", status: "published" } },
  { id: "ev-cccccccc-3", type: "events", attributes: { title: "Draft one", status: "draft" } },
];
const lsSessions = {
  "ev-aaaaaaaa-1": [
    { attributes: { status: "past", estimated_started_at: now - 10 * DAY } },
    { attributes: { status: "upcoming", estimated_started_at: now + 3 * DAY } },
    { attributes: { status: "upcoming", estimated_started_at: now + 9 * DAY } },
  ],
  "ev-bbbbbbbb-2": [],
};
let wfItems = [];
let calls = [];
let nextId = 1;

function reply(status, body) {
  return new Response(body == null ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || "GET";
  calls.push(`${method} ${u.host}${u.pathname}`);
  assert.ok(!/\s/.test(url), `URL must not contain whitespace: ${url}`);
  if (u.host === "api.livestorm.co") {
    const m = u.pathname.match(/^\/v1\/events(?:\/([^/]+))?(\/sessions)?$/);
    if (m && !m[1]) return reply(200, { data: lsEvents, meta: { page_count: 1 } });
    if (m && m[2]) return reply(200, { data: lsSessions[m[1]] || [], meta: { page_count: 1 } });
    if (m) { const e = lsEvents.find((x) => x.id === m[1]); return e ? reply(200, { data: e }) : reply(404, {}); }
  }
  if (u.host === "api.webflow.com") {
    if (u.pathname === "/v2/collections/COL/items" && method === "GET") {
      const off = Number(u.searchParams.get("offset"));
      return reply(200, { items: wfItems.slice(off, off + 100), pagination: { total: wfItems.length } });
    }
    if (u.pathname === "/v2/collections/COL/items/live" && method === "POST") {
      const body = JSON.parse(opts.body);
      const item = { id: `wf${nextId++}`, fieldData: body.fieldData };
      wfItems.push(item);
      return reply(202, item);
    }
    if (u.pathname === "/v2/collections/COL/items/live" && method === "PATCH") {
      for (const it of JSON.parse(opts.body).items) {
        const cur = wfItems.find((x) => x.id === it.id);
        Object.assign(cur.fieldData, it.fieldData);
      }
      return reply(200, {});
    }
  }
  throw new Error(`unexpected request ${method} ${url}`);
};

const { default: syncAll } = await import("../api/sync-all.js");
const { default: webhook } = await import("../api/livestorm-webhook.js");

function mockRes() {
  const r = { statusCode: 0, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}
const cronReq = (auth) => ({ method: "GET", headers: auth ? { authorization: auth } : {} });

// 1. auth
let res = mockRes(); await syncAll(cronReq(), res);
assert.equal(res.statusCode, 401, "no secret → 401");
res = mockRes(); await syncAll(cronReq("Bearer wrong"), res);
assert.equal(res.statusCode, 401, "wrong secret → 401");

// 2. first run creates two, skips the draft
res = mockRes(); await syncAll(cronReq("Bearer cron-secret"), res);
assert.equal(res.statusCode, 200, JSON.stringify(res.body));
assert.deepEqual([res.body.created, res.body.updated, res.body.skipped], [2, 0, 1]);
const future = wfItems.find((i) => i.fieldData.name === "Future webinar");
assert.equal(future.fieldData["webinar-embedded-form"], "ev-aaaaaaaa-1");
assert.equal(future.fieldData["date-and-time"], new Date((now + 3 * DAY) * 1000).toISOString(), "next upcoming session date");
assert.equal(future.fieldData["webinar-description"], "<p>Hello&nbsp;<strong>world</strong></p>", "formatting kept, script and handlers dropped");
assert.equal(future.fieldData["webinar---summary"], "Hello world");
assert.equal(future.fieldData["webinar-heading-2"], "<h1>Future webinar</h1>");
assert.equal(future.fieldData.status, "03319a09047e67cbd26a293509624855", "status Upcoming");
assert.equal(future.fieldData.slug, "future-webinar");
const noDate = wfItems.find((i) => i.fieldData.name === "No sessions yet");
assert.ok(!("date-and-time" in noDate.fieldData), "no fake +7 day date");

// 3. second run: nothing changes, no duplicates
res = mockRes(); await syncAll(cronReq("Bearer cron-secret"), res);
assert.deepEqual([res.body.created, res.body.updated, res.body.unchanged], [0, 0, 2]);
assert.equal(wfItems.length, 2, "no duplicates on re-run");

// 4. Webflow owns the content: edits made in Webflow survive a Livestorm rename
future.fieldData["webinar-heading-2"] = "<h1>Future <strong>webinar</strong></h1>";
future.fieldData["webinar-form-title"] = "Future webinar | SparkForce";
future.fieldData["webinar---summary"] = "";
lsEvents[0].attributes.title = "Future webinar (renamed)";
res = mockRes(); await syncAll(cronReq("Bearer cron-secret"), res);
assert.equal(res.body.updated, 1, "only the empty summary is filled");
assert.equal(future.fieldData.name, "Future webinar", "name not overwritten");
assert.equal(future.fieldData["webinar-heading-2"], "<h1>Future <strong>webinar</strong></h1>", "styled heading kept");
assert.equal(future.fieldData["webinar-form-title"], "Future webinar | SparkForce");
assert.equal(future.fieldData["webinar---summary"], "Hello world", "empty field filled");
assert.equal(future.fieldData.slug, "future-webinar", "slug unchanged");

// 4b. Livestorm owns the schedule: a moved session updates the date
lsSessions["ev-aaaaaaaa-1"][1].attributes.estimated_started_at = now + 4 * DAY;
res = mockRes(); await syncAll(cronReq("Bearer cron-secret"), res);
assert.equal(res.body.updated, 1);
assert.equal(future.fieldData["date-and-time"], new Date((now + 4 * DAY) * 1000).toISOString());

// 4c. A settled past webinar flips to On demand without a sessions lookup
wfItems.push({ id: "wf-old", fieldData: { name: "Old one", slug: "old-one", "webinar-embedded-form": "ev-eeeeeeee-5",
  "date-and-time": new Date((now - 30 * DAY) * 1000).toISOString(), status: "03319a09047e67cbd26a293509624855", "webinar-heading-2": "<h1>Old</h1>" } });
lsEvents.push({ id: "ev-eeeeeeee-5", type: "events", attributes: { title: "Old one", status: "published" } });
calls = [];
res = mockRes(); await syncAll(cronReq("Bearer cron-secret"), res);
assert.equal(wfItems.find((i) => i.id === "wf-old").fieldData.status, "fab10897748c6f4490a1d751d65e4dab", "status On demand");
assert.ok(!calls.some((c) => c.includes("ev-eeeeeeee-5/sessions")), "no sessions lookup for settled items");

// 5. webhook: auth, ignore, then sync a single event re-read from the API
res = mockRes(); await webhook({ method: "POST", query: {}, body: {} }, res);
assert.equal(res.statusCode, 401);
res = mockRes(); await webhook({ method: "POST", query: { key: "hook-secret" }, body: { meta: { event: "attendee.registered" } } }, res);
assert.equal(res.body.ignored, "attendee.registered");
lsEvents.push({ id: "ev-dddddddd-4", type: "events", attributes: { title: "Brand new", status: "published" } });
lsSessions["ev-dddddddd-4"] = [{ attributes: { status: "upcoming", estimated_started_at: now + DAY } }];
res = mockRes();
await webhook({ method: "POST", query: { key: "hook-secret" }, body: { meta: { event: "event.published" }, data: { type: "events", id: "ev-dddddddd-4", attributes: { title: "FORGED TITLE" } } } }, res);
assert.equal(res.body.action, "created");
assert.ok(wfItems.some((i) => i.fieldData.name === "Brand new"), "content comes from the API, not the payload");
assert.ok(!wfItems.some((i) => i.fieldData.name === "FORGED TITLE"));

// 6. Webflow list failure aborts instead of creating duplicates
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => (String(url).includes("api.webflow.com") && !opts?.method ? reply(400, { msg: "bad" }) : realFetch(url, opts));
const before = wfItems.length;
res = mockRes(); await syncAll(cronReq("Bearer cron-secret"), res);
assert.equal(res.statusCode, 502);
assert.equal(wfItems.length, before, "no creates when the index can't be loaded");

console.log("All sync tests passed");
