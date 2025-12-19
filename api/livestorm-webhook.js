export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  try {
    const payload = req.body;

    // ✅ Livestorm Webhooks app: event name is here
    const eventType =
      payload?.data?.meta?.webhook?.event ||
      payload?.meta?.event ||
      payload?.event ||
      payload?.type;

    console.log("Detected Livestorm eventType:", eventType);

    if (eventType !== "event.created") {
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

    const livestormId = data.id;
    const title = attrs.title || "Livestorm Webinar";
    const description = attrs.description || "";
    const registrationLink = attrs.registration_link || "";

    // Livestorm sometimes provides no start date until scheduled
    // Your Webflow field is REQUIRED, so we must set something.
    // We'll use "now + 7 days" when it's not scheduled yet.
    const startAt =
      attrs.start_at ||
      attrs.starts_at || // just in case variant
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Generate slug (Webflow requires unique slug)
    const baseSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    const slug = `webinar-${String(livestormId).slice(0, 8)}-${baseSlug}`;

    const webflowItem = {
      fieldData: {
        name: title,
        slug: slug,

        "webinar-heading-2": title,
        "date-and-time": startAt,

        "webinar-embedded-form": String(livestormId),
        "webinar-form-title": title,

        "webinar-description": description,
        "webinar--summary": description ? description.substring(0, 200) : "",

        // Optional: if you want to store it somewhere later
        // "registration-link": registrationLink
      }
    };

    const resp = await fetch(
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

    const text = await resp.text();

    if (!resp.ok) {
      console.log("Webflow error:", resp.status, text);
      return res.status(500).json({
        error: "Webflow API error",
        status: resp.status,
        details: text
      });
    }

    console.log("Webflow item created successfully");
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("Server error:", err);
    return res.status(500).json({ error: "Server error", message: String(err) });
  }
}
