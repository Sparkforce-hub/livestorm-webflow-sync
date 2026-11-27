// Livestorm → Webflow full sync. Runs on the Vercel cron (see vercel.json)
// and can be triggered by hand with:  Authorization: Bearer <CRON_SECRET>
import {
  getConfig, safeEqual, fetchLivestormEvents, fetchEventStart,
  isPublishable, isSettled, loadWebflowIndex, upsertEvent,
} from "../lib/sync.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const secret = process.env.CRON_SECRET;
  const auth = req.headers?.authorization || "";
  if (!secret || !safeEqual(auth, `Bearer ${secret}`)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { cfg, missing } = getConfig();
  if (missing.length) return res.status(500).json({ error: "Missing env vars", missing });

  const results = { total: 0, skipped: 0, created: 0, updated: 0, unchanged: 0, errors: [] };
  try {
    const [events, { index, dupes }] = await Promise.all([
      fetchLivestormEvents(cfg),
      loadWebflowIndex(cfg),
    ]);
    results.total = events.length;
    if (dupes.length) results.duplicateItemsInWebflow = dupes.length;

    for (const event of events) {
      if (!isPublishable(event)) { results.skipped++; continue; }
      try {
        const existing = index.get(String(event.id));
        // Settled past webinars keep their stored date; skip the sessions lookup to stay well inside the time limit.
        const startAt = existing && isSettled(existing)
          ? existing.fieldData["date-and-time"]
          : await fetchEventStart(cfg, event.id);
        const action = await upsertEvent(cfg, index, event, startAt);
        results[action]++;
        if (action !== "unchanged") console.log(`${action}: ${event.attributes?.title} (${event.id})`);
      } catch (err) {
        console.log(`Error syncing event ${event.id}: ${err.message}`);
        results.errors.push({ id: event.id, error: err.message });
      }
    }
  } catch (err) {
    console.log("Sync aborted:", err.message);
    return res.status(502).json({ ok: false, error: err.message, ...results });
  }

  console.log("Sync complete:", JSON.stringify(results));
  return res.status(200).json({ ok: results.errors.length === 0, ...results });
}
