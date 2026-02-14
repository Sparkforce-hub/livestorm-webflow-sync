export default async f:contentReference[oaicite:11]{index=11} if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const payload = req.body;

    const eventType =
      payload?.data?.meta?.webhook?.event ||
      payload?.meta?.event ||
      payload?.event ||
      payload?.type;

    console.log("Detected Livestorm eventType:", eventType);

    // 1) Accept more triggers than only event.created
    const ALLOWED = new Set([
      "event.created",
      "event.published",
      "event.canceled",
      "event.ended",
      // optionally: session.* triggers if you wire them in Livestorm
      // "session.created",
      // "session.started",
      // "session.ended",
    ]);

    if (!ALLOWED.has(eventType)) {
      console.log("Ignored webhook eventType:", eventType);
      return res.status(200).json({ ok: true, ignored: eventType });
    }

    const data = payload.data;
    const attrs = data?.attributes || {};

    const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
    const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;

    if (!WEBFLOW_TOKEN || !COLLECTION_ID) {
      return res.status(500).json({ error: "Missing env vars" });
    }

    const livestormId = String(data.id);
    const title = attrs.title || "Livestorm Webinar";
    const description = attrs.description || "";
    const startAt =
      attrs.start_at ||
      attrs.starts_at ||
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const baseSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    const slug = `webinar-${livestormId.slice(0, 8)}-${baseSlug}`;

    // 2) Build the mirrored fieldData (expand this later)
    const fieldData = {
      name: title,
      slug,

      "webinar-heading-2": title,
      "date-and-time": startAt,

      // Treat this as our stable external ID:
      "webinar-embedded-form": livestormId,

      "webinar-form-title": title,
      "webinar-description": description,

      // ✅ IMPORTANT: use your real Webflow slug here
      "webinar---summary": description ? description.substring(0, 200) : "",
    };

    // --- Webflow helpers ---
    async function wfFetch(url, options = {}) {
      const resp = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${WEBFLOW_TOKEN}`,
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      const text = await resp.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      return { resp, text, json };
    }

    // 3) Find existing item by scanning (OK for small collections)
    // NOTE: If your webinars collection grows huge, we’ll optimize later.
    async function findExistingItemIdByLivestormId() {
      let offset = 0;
      const limit = 100;

      while (true) {
        const { resp, json, text } = await wfFetch(
          `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items?limit=${limit}&offset=${offset}`
        );
        if (!resp.ok) throw new Error(`List items failed: ${resp.status} ${text}`);

        const items = json?.items || [];
        const found = items.find(
          (it) => String(it?.fieldData?.["webinar-embedded-form"] || "") === livestormId
        );
        if (found?.id) return found.id;

        if (items.length < limit) return null; // no more pages
        offset += limit;
      }
    }

    const existingItemId = await findExistingItemIdByLivestormId();

    if (existingItemId) {
      console.log("Updating existing Webflow item:", existingItemId);

      // 4) Update (mirror overwrite)
      const { resp, text } = await wfFetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${existingItemId}/live`,
        { method: "PATCH", body: JSON.stringify({ fieldData }) }
      );

      if (!resp.ok) {
        console.log("Webflow update error:", resp.status, text);
        return res.status(500).json({ error: "Webflow update error", status: resp.status, details: text });
      }

      return res.status(200).json({ ok: true, action: "updated" });
    } else {
      console.log("Creating new Webflow item");

      // 5) Create
      const { resp, text } = await wfFetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/live`,
        { method: "POST", body: JSON.stringify({ fieldData }) }
      );

      if (!resp.ok) {
        console.log("Webflow create error:", resp.status, text);
        return res.status(500).json({ error: "Webflow create error", status: resp.status, details: text });
      }

      return res.status(200).json({ ok: true, action: "created" });
    }
  } catch (err) {
    console.log("Server error:", err);
    return res.status(500).json({ error: "Server error", message: String(err) });
  }
}
