export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  try {
    const payload = req.body;

    // Livestorm Webhooks app: event name is here (this is what worked for you)
    const eventType =
      payload?.data?.meta?.webhook?.event ||
      payload?.meta?.event ||
      payload?.event ||
      payload?.type;

    console.log("Detected Livestorm eventType:", eventType);

    // ✅ Mirror approach: accept more than just event.created
    // (If Livestorm sends only event.created today, this still works;
    // later you can add more triggers in Livestorm UI without code changes.)
    const ALLOWED_PREFIXES = ["event.", "session."]; // keep it permissive
    if (!eventType || !ALLOWED_PREFIXES.some((p) => eventType.startsWith(p))) {
      console.log("Ignored webhook eventType:", eventType);
      return res.status(200).json({ ok: true, ignored: eventType });
    }

    const data = payload.data;
    const attrs = data?.attributes || {};

    const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
    const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;

    // IMPORTANT: this is the plain text field you added to the Webflow collection
    // Default slug: "livestorm-id"
    // If your Webflow field slug differs, set WEBFLOW_LIVESTORM_ID_FIELD in Vercel env vars.
   const LIVESTORM_ID_FIELD =
    process.env.WEBFLOW_LIVESTORM_ID_FIELD || "livestorm-id";

    if (!WEBFLOW_TOKEN || !COLLECTION_ID) {
      return res.status(500).json({ error: "Missing env vars" });
    }

    // --- Livestorm values ---
    const livestormId = String(data.id);
    const title = attrs.title || "Livestorm Webinar";
    const description = attrs.description || "";
    const registrationLink = attrs.registration_link || "";

    // Livestorm sometimes has no start time yet (not scheduled)
    // Keep your safe fallback (this is what made your Phase 1 stable)
    const startAt =
      attrs.start_at ||
      attrs.starts_at ||
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Generate a stable slug (unique by Livestorm id)
    const baseSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    const slug = `webinar-${livestormId.slice(0, 8)}-${baseSlug}`;

    // --- Webflow fieldData ---
    // ✅ Keep your working dashes exactly (webinar---summary)
    const fieldData = {
      name: title,
      slug,

      "webinar-heading-2": title,
      "date-and-time": startAt,

      // keep your existing external id storage (already used by you)
      "webinar-embedded-form": livestormId,
      "webinar-form-title": title,

      "webinar-description": description,
      "webinar---summary": description ? description.substring(0, 200) : "",

      // NEW: stable lookup key for mirror/upsert
      [LIVESTORM_ID_FIELD]: livestormId,

      // Optional if you later add a Webflow field for it:
      // "registration-link": registrationLink,
    };

    // --- helpers ---
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
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}
      return { resp, text, json };
    }

    // ✅ Webflow v2: list LIVE items from /items/live
    async function findExistingLiveItemIdByLivestormId() {
      let offset = 0;
      const limit = 100;

      while (true) {
        const { resp, json, text } = await wfFetch(
          `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/live?limit=${limit}&offset=${offset}`
        );

        if (!resp.ok) {
          throw new Error(`List live items failed: ${resp.status} ${text}`);
        }

        const items = json?.items || [];
        const found = items.find((it) => {
          const v = it?.fieldData?.[LIVESTORM_ID_FIELD];
          return String(v || "") === livestormId;
        });

        if (found?.id) return found.id;

        if (items.length < limit) return null;
        offset += limit;
      }
    }

    // ✅ Webflow v2: update LIVE items via PATCH /items/live with items:[{id, fieldData}]
    async function updateLiveItem(itemId) {
      const { resp, text } = await wfFetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/live`,
        {
          method: "PATCH",
          body: JSON.stringify({
            items: [{ id: itemId, fieldData }],
          }),
        }
      );

      if (!resp.ok) {
        throw new Error(`Update live item failed: ${resp.status} ${text}`);
      }
    }

    // ✅ Webflow v2: create LIVE item via POST /items/live (this is your proven working call)
    async function createLiveItem() {
      const { resp, text } = await wfFetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/live`,
        {
          method: "POST",
          body: JSON.stringify({ fieldData }),
        }
      );

      if (!resp.ok) {
        throw new Error(`Create live item failed: ${resp.status} ${text}`);
      }
    }

    // --- MIRROR / UPSERT ---
    const existingItemId = await findExistingLiveItemIdByLivestormId();

    if (existingItemId) {
      console.log("Mirror: updating existing Webflow item:", existingItemId);
      await updateLiveItem(existingItemId);
      console.log("Webflow item updated successfully");
      return res.status(200).json({ ok: true, action: "updated" });
    } else {
      console.log("Mirror: creating new Webflow item");
      await createLiveItem();
      console.log("Webflow item created successfully");
      return res.status(200).json({ ok: true, action: "created" });
    }
  } catch (err) {
    console.log("Server error:", err);
    return res
      .status(500)
      .json({ error: "Server error", message: String(err?.message || err) });
  }
}
