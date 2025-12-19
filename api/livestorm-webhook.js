export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  try {
    const payload = req.body;
    console.log("Webhook received. method:", req.method);
    console.log("Webhook meta event:", payload?.meta?.event);
    const eventType =
    payload?.event ||
    payload?.type ||
    payload?.meta?.event;

    console.log("Detected Livestorm eventType:", eventType);

    if (!eventType || !eventType.includes("event.created")) {
    console.log("Ignored webhook eventType:", eventType);
    return res.status(200).json({ ok: true, ignored: eventType });
    }

    const data = payload.data;
    const attrs = data.attributes || {};

    const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
    const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;

    if (!WEBFLOW_TOKEN || !COLLECTION_ID) {
      return res.status(500).json({ error: "Missing env vars" });
    }

    // Core values from Livestorm
    const livestormId = data.id;
    const title = attrs.title || "Livestorm Webinar";
    const description = attrs.description || "";

    // Required: slug
    const baseSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    const slug = `webinar-${String(livestormId).slice(0, 8)}-${baseSlug}`;

    // Required: date (ISO)
    const startAt = attrs.start_at; // already ISO from Livestorm

    if (!startAt) {
      return res.status(400).json({ error: "Missing start date from Livestorm" });
    }

    const webflowItem = {
      fieldData: {
        name: title,
        slug: slug,

        "webinar-heading-2": title,
        "date-and-time": startAt,

        "webinar-embedded-form": String(livestormId),
        "webinar-form-title": title,

        "webinar-description": description,
        "webinar-summary": description.substring(0, 200)
      }
    };

    const response = await fetch(
      `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/live`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${WEBFLOW_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(webflowItem)
      }
    );

    const text = await response.text();

    if (!response.ok) {
      return res.status(500).json({
        error: "Webflow API error",
        status: response.status,
        details: text
      });
    }

    return res.status(200).json({ ok: true });

  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: String(err)
    });
  }
}
