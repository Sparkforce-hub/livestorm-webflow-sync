// Livestorm webhook → syncs the one event that changed, within seconds.
// Register in Livestorm as:
//   https://<your-vercel-app>/api/livestorm-webhook?key=<LIVESTORM_WEBHOOK_SECRET>
// The payload is only used to learn WHICH event changed; the event itself is
// re-read from the Livestorm API, so a forged payload can't inject content.
import {
  getConfig, safeEqual, fetchLivestormEvent, fetchEventStart,
  isPublishable, loadWebflowIndex, upsertEvent,
} from "../lib/sync.js";

function eventIdFrom(payload) {
  const d = payload?.data;
  if (!d) return null;
  if (d.type === "events" && d.id) return String(d.id);
  // session.* webhooks: the parent event is in relationships or attributes
  const rel = d.relationships?.event?.data?.id || d.attributes?.event_id;
  if (rel) return String(rel);
  return d.id ? String(d.id) : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  const secret = process.env.LIVESTORM_WEBHOOK_SECRET;
  if (!secret || !safeEqual(req.query?.key, secret)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body || {};
  const eventType =
    payload?.data?.meta?.webhook?.event || payload?.meta?.event || payload?.event || payload?.type || "";
  if (!/^(event|session)\./.test(eventType)) {
    return res.status(200).json({ ok: true, ignored: eventType || "unknown" });
  }

  const eventId = eventIdFrom(payload);
  if (!eventId) return res.status(200).json({ ok: true, ignored: "no event id" });

  const { cfg, missing } = getConfig();
  if (missing.length) return res.status(500).json({ error: "Missing env vars", missing });

  try {
    const event = await fetchLivestormEvent(cfg, eventId);
    if (!event) return res.status(200).json({ ok: true, ignored: "event not found" });
    if (!isPublishable(event)) return res.status(200).json({ ok: true, ignored: "draft" });

    const [{ index }, startAt] = await Promise.all([
      loadWebflowIndex(cfg),
      fetchEventStart(cfg, eventId),
    ]);
    const action = await upsertEvent(cfg, index, event, startAt);
    console.log(`Webhook ${eventType}: ${action} ${eventId}`);
    return res.status(200).json({ ok: true, action });
  } catch (err) {
    console.log("Webhook error:", err.message);
    // non-2xx makes Livestorm retry later
    return res.status(500).json({ ok: false, error: err.message });
  }
}
