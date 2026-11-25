// Shared Livestorm → Webflow sync logic, used by the cron (api/sync-all.js)
// and the webhook (api/livestorm-webhook.js).
//
// Env vars (set in Vercel, never in code):
//   LIVESTORM_API_TOKEN, WEBFLOW_TOKEN, WEBFLOW_COLLECTION_ID
//   WEBFLOW_LIVESTORM_ID_FIELD  (optional, default "webinar-embedded-form")
//   CRON_SECRET                 (protects /api/sync-all; Vercel cron sends it automatically)
//   LIVESTORM_WEBHOOK_SECRET    (protects /api/livestorm-webhook via ?key=...)

const LS_API = "https://api.livestorm.co/v1";
const WF_API = "https://api.webflow.com/v2";

export function getConfig() {
  const cfg = {
    livestormToken: process.env.LIVESTORM_API_TOKEN,
    webflowToken: process.env.WEBFLOW_TOKEN,
    collectionId: process.env.WEBFLOW_COLLECTION_ID,
    idField: process.env.WEBFLOW_LIVESTORM_ID_FIELD || "webinar-embedded-form",
  };
  const missing = Object.entries({
    LIVESTORM_API_TOKEN: cfg.livestormToken,
    WEBFLOW_TOKEN: cfg.webflowToken,
    WEBFLOW_COLLECTION_ID: cfg.collectionId,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  return { cfg, missing };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with retry on 429 / 5xx (Webflow allows ~60 req/min on most plans)
async function request(url, options = {}, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    const resp = await fetch(url, options);
    if ((resp.status === 429 || resp.status >= 500) && attempt < tries) {
      const retryAfter = Number(resp.headers.get("retry-after")) || attempt * 2;
      await sleep(retryAfter * 1000);
      continue;
    }
    const text = await resp.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { resp, text, json };
  }
}

// ---------- Livestorm ----------

function lsHeaders(cfg) {
  return { Authorization: cfg.livestormToken, Accept: "application/vnd.api+json" };
}

// Livestorm pages are 0-based; results are de-duplicated by id as a safety net.
async function lsGetAll(cfg, path) {
  const out = [];
  const seen = new Set();
  for (let page = 0; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const { resp, text, json } = await request(
      `${LS_API}${path}${sep}page[size]=100&page[number]=${page}`,
      { headers: lsHeaders(cfg) }
    );
    if (!resp.ok) throw new Error(`Livestorm ${path} ${resp.status}: ${text.slice(0, 300)}`);
    const data = json?.data || [];
    for (const d of data) {
      if (d?.id != null && seen.has(d.id)) continue;
      if (d?.id != null) seen.add(d.id);
      out.push(d);
    }
    const pageCount = json?.meta?.page_count;
    if (data.length < 100 || (pageCount != null && page + 1 >= pageCount)) break;
  }
  return out;
}

export async function fetchLivestormEvents(cfg) {
  return lsGetAll(cfg, "/events");
}

export async function fetchLivestormEvent(cfg, eventId) {
  const { resp, text, json } = await request(
    `${LS_API}/events/${encodeURIComponent(eventId)}`,
    { headers: lsHeaders(cfg) }
  );
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`Livestorm event ${eventId} ${resp.status}: ${text.slice(0, 300)}`);
  return json?.data || null;
}

// Livestorm keeps dates on sessions, not on the event. Returns the next
// upcoming session start, else the most recent past one, else null.
export async function fetchEventStart(cfg, eventId) {
  const sessions = await lsGetAll(cfg, `/events/${encodeURIComponent(eventId)}/sessions`);
  const now = Date.now();
  const starts = sessions
    .filter((s) => (s.attributes?.status || "") !== "canceled")
    .map((s) => toDate(s.attributes?.estimated_started_at ?? s.attributes?.started_at))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const upcoming = starts.find((d) => d.getTime() >= now);
  const chosen = upcoming || starts[starts.length - 1];
  return chosen ? chosen.toISOString() : null;
}

// Livestorm returns unix seconds; tolerate ISO strings and milliseconds too.
export function toDate(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return isNaN(d) ? null : d;
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

export function isPublishable(event) {
  const a = event?.attributes || {};
  return a.status !== "draft" && a.scheduling_status !== "draft" && !a.deleted_at;
}

// ---------- Webflow ----------

function wfHeaders(cfg) {
  return {
    Authorization: `Bearer ${cfg.webflowToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function wf(cfg, path, options = {}) {
  return request(`${WF_API}${path}`, { ...options, headers: wfHeaders(cfg) });
}

// One pass over the staged collection (it contains every item, live or not).
// Returns Map<livestormId, item>. Throws instead of silently returning nothing,
// so a Webflow outage can never turn into a wave of duplicate creates.
export async function loadWebflowIndex(cfg) {
  const index = new Map();
  const dupes = [];
  for (let offset = 0; ; offset += 100) {
    const { resp, text, json } = await wf(
      cfg,
      `/collections/${cfg.collectionId}/items?limit=100&offset=${offset}`
    );
    if (!resp.ok) throw new Error(`Webflow list ${resp.status}: ${text.slice(0, 300)}`);
    const items = json?.items || [];
    for (const it of items) {
      const id = String(it?.fieldData?.[cfg.idField] || "");
      if (!id) continue;
      if (index.has(id)) dupes.push(it.id);
      else index.set(id, it);
    }
    const total = json?.pagination?.total;
    if (items.length < 100 || (total != null && offset + 100 >= total)) break;
  }
  return { index, dupes };
}

function stripHtml(html) {
  return html
    ? String(html)
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim()
    : "";
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

// startAt === null means "no date known": the field is left untouched
// instead of inventing one.
export function buildFieldData(cfg, event, startAt) {
  const a = event.attributes || {};
  const livestormId = String(event.id);
  const title = a.title || "Livestorm Webinar";
  const description = stripHtml(a.description || "");
  const fd = {
    name: title,
    "webinar-heading-2": title,
    "webinar-form-title": title,
    "webinar-description": description,
    "webinar---summary": description.slice(0, 200),
    [cfg.idField]: livestormId,
  };
  if (startAt) fd["date-and-time"] = startAt;
  return fd;
}

function newSlug(event) {
  const title = event.attributes?.title || "webinar";
  return `webinar-${String(event.id).slice(0, 8)}-${slugify(title)}`;
}

const TRACKED = ["name", "webinar-heading-2", "webinar-form-title", "webinar-description", "webinar---summary", "date-and-time"];

function sameDate(a, b) {
  const x = toDate(a), y = toDate(b);
  return x && y ? x.getTime() === y.getTime() : !a && !b;
}

function needsUpdate(item, fd) {
  const cur = item.fieldData || {};
  return TRACKED.some((k) => {
    if (!(k in fd)) return false;
    if (k === "date-and-time") return !sameDate(cur[k], fd[k]);
    return String(cur[k] ?? "") !== String(fd[k] ?? "");
  });
}

// Create or update one event. Returns "created" | "updated" | "unchanged".
// Items are written to the live site directly (…/items/live), so no separate
// publish call is needed and nothing else in the collection gets published.
export async function upsertEvent(cfg, index, event, startAt) {
  const fd = buildFieldData(cfg, event, startAt);
  const existing = index.get(String(event.id));

  if (!existing) {
    const { resp, text, json } = await wf(cfg, `/collections/${cfg.collectionId}/items/live`, {
      method: "POST",
      body: JSON.stringify({ isDraft: false, isArchived: false, fieldData: { ...fd, slug: newSlug(event) } }),
    });
    if (!resp.ok) throw new Error(`Create failed ${resp.status}: ${text.slice(0, 300)}`);
    if (json?.id) index.set(String(event.id), json);
    return "created";
  }

  if (!needsUpdate(existing, fd)) return "unchanged";

  // slug is deliberately not sent: renaming a webinar must not break its URL
  const { resp, text } = await wf(cfg, `/collections/${cfg.collectionId}/items/live`, {
    method: "PATCH",
    body: JSON.stringify({ items: [{ id: existing.id, fieldData: fd }] }),
  });
  if (!resp.ok) throw new Error(`Update failed ${resp.status}: ${text.slice(0, 300)}`);
  return "updated";
}

// Constant-time compare for shared secrets.
export function safeEqual(a, b) {
  a = String(a || ""); b = String(b || "");
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
