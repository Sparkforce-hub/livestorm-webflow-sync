export default async function handler(req, res) {
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    try {
      const payload = req.body;

      const eventType =
        payload?.data?.meta?.webhook?.event ||
        payload?.meta?.event ||
        payload?.event ||
        payload?.type;

        // TEMPORARY DEBUG - remove after we identify the payload structure
      console.log("FULL PAYLOAD:", JSON.stringify(payload, null, 2));

      const ALLOWED_PREFIXES = ["event.", "session."];
      if (!eventType || !ALLOWED_PREFIXES.some((p) => eventType.startsWith(p)))
  {
        console.log("Ignored webhook eventType:", eventType);
        return res.status(200).json({ ok: true, ignored: eventType });
      }

      const data = payload.data;
      const attrs = data?.attributes || {};

      const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
      const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;
      const LIVESTORM_ID_FIELD = process.env.WEBFLOW_LIVESTORM_ID_FIELD ||
  "webinar-embedded-form";

      if (!WEBFLOW_TOKEN || !COLLECTION_ID) {
        return res.status(500).json({ error: "Missing env vars" });
      }

      const livestormId = String(data.id);
      const title = attrs.title || "Livestorm Webinar";
      const description = attrs.description || "";
      const registrationLink = attrs.registration_link || "";

      const startAt =
        attrs.start_at ||
        attrs.starts_at ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const baseSlug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

      const slug = `webinar-${livestormId.slice(0, 8)}-${baseSlug}`;

      const fieldData = {
        name: title,
        slug,
        "webinar-heading-2": title,
        "date-and-time": startAt,
        "webinar-form-title": title,
        "webinar-description": description,
        "webinar---summary": description ? description.substring(0, 200) : "",
        // Single assignment for the Livestorm ID field
        [LIVESTORM_ID_FIELD]: livestormId,
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
        try { json = text ? JSON.parse(text) : null; } catch {}
        return { resp, text, json };
      }

      // Search both live AND draft items to find existing Livestorm event
      async function findExistingItemId() {
        for (const endpoint of ["items/live", "items"]) {
          let offset = 0;
          const limit = 100;

          while (true) {
            const { resp, json, text } = await wfFetch(
              `https://api.webflow.com/v2/collections/${COLLECTION_ID}/${endpoin
  t}?limit=${limit}&offset=${offset}`
            );

            if (!resp.ok) {
              console.log(`Warning: listing ${endpoint} failed: ${resp.status}
  ${text}`);
              break;
            }

            const items = json?.items || [];
            const found = items.find((it) => {
              const v = it?.fieldData?.[LIVESTORM_ID_FIELD];
              return String(v || "") === livestormId;
            });

            if (found?.id) {
              console.log(`Found existing item in ${endpoint}:`, found.id);
              return found.id;
            }

            if (items.length < limit) break;
            offset += limit;
          }
        }
        return null;
      }

      // ✅ FIXED: PATCH single item by ID, then publish it live
      async function updateItem(itemId) {
        // Step 1: update the draft
        const { resp: patchResp, text: patchText } = await wfFetch(

  `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${itemId}`,
          {
            method: "PATCH",
            body: JSON.stringify({ fieldData }),
          }
        );

        if (!patchResp.ok) {
          throw new Error(`Update item failed: ${patchResp.status}
  ${patchText}`);
        }
        console.log("Item draft updated:", itemId);

        // Step 2: publish it live
        const { resp: pubResp, text: pubText } = await wfFetch(

  `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/publish`,
          {
            method: "POST",
            body: JSON.stringify({ itemIds: [itemId] }),
          }
        );

        if (!pubResp.ok) {
          throw new Error(`Publish item failed: ${pubResp.status} ${pubText}`);
        }
        console.log("Item published live:", itemId);
      }

      // Create directly as live item (your proven working call)
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

      // --- UPSERT ---
      const existingItemId = await findExistingItemId();

      if (existingItemId) {
        console.log("Updating existing Webflow item:", existingItemId);
        await updateItem(existingItemId);
        return res.status(200).json({ ok: true, action: "updated" });
      } else {
        console.log("Creating new Webflow item");
        await createLiveItem();
        return res.status(200).json({ ok: true, action: "created" });
      }

    } catch (err) {
      console.log("Server error:", err);
      return res.status(500).json({ error: "Server error", message:
  String(err?.message || err) });
    }
  }
