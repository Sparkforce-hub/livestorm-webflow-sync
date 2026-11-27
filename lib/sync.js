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

const STATUS_UPCOMING = process.env.WEBFLOW_STATUS_UPCOMING_ID || "03319a09047e67cbd26a293509624855";
const STATUS_ON_DEMAND = process.env.WEBFLOW_STATUS_ON_DEMAND_ID || "fab10897748c6f4490a1d751d65e4dab";
// A session counts as upcoming until ~90 minutes after it starts (same rule as the website script).
const LIVE_WINDOW_MS = 90 * 60 * 1000;

function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function stripHtml(html) {
  return html
    ? decodeEntities(String(html).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()
    : "";
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Keep simple formatting from the Livestorm description and drop everything else
// (scripts, styles, iframes, inline handlers, classes, ids).
const KEEP = new Set(["p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "h2", "h3", "h4", "blockquote", "a"]);
export function cleanHtml(html) {
  if (!html) return "";
  let s = String(html)
    .replace(/<(script|style|iframe|object|embed|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (tag, name, attrs) => {
    name = name.toLowerCase();
    if (!KEEP.has(name)) return name === "div" ? (tag.startsWith("</") ? "</p>" : "<p>") : "";
    if (tag.startsWith("</")) return `</${name}>`;
    if (name === "a") {
      const m = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)')/i);
      const href = m ? (m[2] ?? m[3]) : "";
      return /^(https?:|mailto:)/i.test(href) ? `<a href="${escHtml(href)}" target="_blank" rel="noopener">` : "<a>";
    }
    return name === "br" ? "<br>" : `<${name}>`;
  });
  s = s.replace(/<p>\s*<\/p>/g, "").trim();
  if (!s) return "";
  return /^<(p|ul|ol|h[2-4]|blockquote)>/.test(s) ? s : `<p>${s}</p>`;
}

// Card summary: first ~160 characters, cut on a word boundary.
export function summarize(text, max = 160) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1).replace(/\s+\S*$/, "").replace(/[\s,;:.–-]+$/, "");
  return `${cut}…`;
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

export function statusFor(startAt, now = Date.now()) {
  const d = toDate(startAt);
  if (!d) return null;
  return d.getTime() + LIVE_WINDOW_MS > now ? STATUS_UPCOMING : STATUS_ON_DEMAND;
}

// Who owns what:
//  - Livestorm owns the schedule: date-and-time, status and the Livestorm ID are
//    kept in step on every run.
//  - Webflow owns the content: name, heading, form title, description and summary
//    are only written when the item is created, or when that field is empty.
//    Edits made in Webflow (styled headings, shorter summaries, SEO titles) are never overwritten.
export function buildFieldData(cfg, event, startAt) {
  const a = event.attributes || {};
  const title = (a.title || "").trim() || "Livestorm webinar";
  const descHtml = cleanHtml(a.description || "");
  const content = {
    name: title,
    "webinar-heading-2": `<h1>${escHtml(title)}</h1>`,
    "webinar-form-title": title,
    "webinar-description": descHtml,
    "webinar---summary": summarize(stripHtml(descHtml)),
  };
  const schedule = { [cfg.idField]: String(event.id) };
  if (startAt) {
    schedule["date-and-time"] = startAt;
    schedule.status = statusFor(startAt);
  }
  return { content, schedule };
}

function newSlug(event) {
  const title = event.attributes?.title || "webinar";
  return slugify(title) || `webinar-${String(event.id).slice(0, 8)}`;
}

function sameDate(a, b) {
  const x = toDate(a), y = toDate(b);
  return x && y ? x.getTime() === y.getTime() : !a && !b;
}

function isEmpty(v) {
  return v == null || stripHtml(String(v)) === "";
}

// The fields that need writing on an existing item (empty object = nothing to do).
export function diffForExisting(item, { content, schedule }) {
  const cur = item.fieldData || {};
  const out = {};
  for (const [k, v] of Object.entries(schedule)) {
    const changed = k === "date-and-time" ? !sameDate(cur[k], v) : String(cur[k] ?? "") !== String(v ?? "");
    if (changed) out[k] = v;
  }
  for (const [k, v] of Object.entries(content)) {
    if (k !== "name" && isEmpty(cur[k]) && !isEmpty(v)) out[k] = v;
  }
  return out;
}

// Past items whose stored date is well behind us don't need a Livestorm sessions lookup:
// only their status can still change, and that follows from the stored date.
export function isSettled(item, now = Date.now()) {
  const d = toDate(item?.fieldData?.["date-and-time"]);
  return !!d && d.getTime() < now - 2 * 24 * 3600 * 1000;
}

// Create or update one event. Returns "created" | "updated" | "unchanged".
// Items are written to the live site directly (…/items/live), so no separate
// publish call is needed and nothing else in the collection gets published.
export async function upsertEvent(cfg, index, event, startAt) {
  const fd = buildFieldData(cfg, event, startAt);
  const existing = index.get(String(event.id));

  if (!existing) {
    let slug = newSlug(event);
    const taken = new Set([...index.values()].map((it) => it?.fieldData?.slug));
    if (taken.has(slug)) slug = `${slug}-${String(event.id).slice(0, 8)}`;
    const body = { isDraft: false, isArchived: false, fieldData: { ...fd.content, ...fd.schedule, slug } };
    const { resp, text, json } = await wf(cfg, `/collections/${cfg.collectionId}/items/live`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Create failed ${resp.status}: ${text.slice(0, 300)}`);
    index.set(String(event.id), json?.id ? json : { fieldData: body.fieldData });
    return "created";
  }

  const patch = diffForExisting(existing, fd);
  if (!Object.keys(patch).length) return "unchanged";

  // slug is never sent: it must not change once the page exists
  const { resp, text } = await wf(cfg, `/collections/${cfg.collectionId}/items/live`, {
    method: "PATCH",
    body: JSON.stringify({ items: [{ id: existing.id, fieldData: patch }] }),
  });
  if (!resp.ok) throw new Error(`Update failed ${resp.status}: ${text.slice(0, 300)}`);
  Object.assign((existing.fieldData ||= {}), patch);
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
