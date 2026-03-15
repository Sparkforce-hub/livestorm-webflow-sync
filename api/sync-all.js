export default async function handler(req, res) {
    if (req.method !== "GET" && req.method !== "POST") {                        
      return res.status(405).send("Method not allowed");
    }

    const LIVESTORM_TOKEN = process.env.LIVESTORM_API_TOKEN;
    const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
    const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;
    const LIVESTORM_ID_FIELD = process.env.WEBFLOW_LIVESTORM_ID_FIELD ||
  "webinar-embedded-form";

    if (!LIVESTORM_TOKEN || !WEBFLOW_TOKEN || !COLLECTION_ID) {
      return res.status(500).json({ error: "Missing env vars" });
    }

    async function fetchLivestormEvents() {
      const events = [];
      let page = 1;

      while (true) {
        const resp = await fetch(

  `https://api.livestorm.co/v1/events?page[size]=100&page[number]=${page}`,
          {
            headers: {
              Authorization: LIVESTORM_TOKEN,
              Accept: "application/vnd.api+json",
            },
          }
        );

        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Livestorm API error: ${resp.status} ${text}`);
        }

        const json = await resp.json();
        const data = json?.data || [];
        events.push(...data);

        if (data.length < 100) break;
        page++;
      }

      return events;
    }

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

    async function findWebflowItem(livestormId) {
      for (const endpoint of ["items/live", "items"]) {
        let offset = 0;
        while (true) {
          const { resp, json } = await wfFetch(
            `https://api.webflow.com/v2/collections/${COLLECTION_ID}/${endpoint}
  ?limit=100&offset=${offset}`
          );
          if (!resp.ok) break;

          const items = json?.items || [];
          const found = items.find(
            (it) => String(it?.fieldData?.[LIVESTORM_ID_FIELD] || "") ===
  livestormId
          );
          if (found?.id) return found.id;
          if (items.length < 100) break;
          offset += 100;
        }
      }
      return null;
    }

    function buildFieldData(event) {
      const attrs = event.attributes || {};
      const livestormId = String(event.id);
      const title = attrs.title || "Livestorm Webinar";
      const description = attrs.description || "";
      const startAt =
        attrs.start_at ||
        attrs.starts_at ||
        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

      const slug = `webinar-${livestormId.slice(0, 8)}-${title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")}`;

      return {
        name: title,
        slug,
        "webinar-heading-2": title,
        "date-and-time": startAt,
        "webinar-form-title": title,
        "webinar-description": description,
        "webinar---summary": description ? description.substring(0, 200) : "",
        [LIVESTORM_ID_FIELD]: livestormId,
      };
    }

    async function updateItem(itemId, fieldData) {
      const { resp: patchResp, text: patchText } = await wfFetch(

  `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${itemId}`,
        { method: "PATCH", body: JSON.stringify({ fieldData }) }
      );
      if (!patchResp.ok) throw new Error(`Update failed: ${patchResp.status}
  ${patchText}`);

      const { resp: pubResp, text: pubText } = await wfFetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/publish`,
        { method: "POST", body: JSON.stringify({ itemIds: [itemId] }) }
      );
      if (!pubResp.ok) throw new Error(`Publish failed: ${pubResp.status}
  ${pubText}`);
    }

    async function createItem(fieldData) {
      const { resp, text } = await wfFetch(
        `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/live`,
        { method: "POST", body: JSON.stringify({ fieldData }) }
      );
      if (!resp.ok) throw new Error(`Create failed: ${resp.status} ${text}`);
    }

    // --- Main sync ---
    const events = await fetchLivestormEvents();
    console.log(`Fetched ${events.length} events from Livestorm`);

    const results = { total: events.length, created: 0, updated: 0, errors: []
  };

    for (const event of events) {
      try {
        const livestormId = String(event.id);
        const fieldData = buildFieldData(event);
        const existingId = await findWebflowItem(livestormId);

        if (existingId) {
          await updateItem(existingId, fieldData);
          console.log(`Updated: ${fieldData.name}`);
          results.updated++;
        } else {
          await createItem(fieldData);
          console.log(`Created: ${fieldData.name}`);
          results.created++;
        }
      } catch (err) {
        console.log(`Error syncing event ${event.id}:`, err.message);
        results.errors.push({ id: event.id, error: err.message });
      }
    }

    console.log("Sync complete:", results);
    return res.status(200).json({ ok: true, ...results });
  }
