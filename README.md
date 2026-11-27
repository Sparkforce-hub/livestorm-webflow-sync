# Livestorm → Webflow sync

Keeps the Webflow webinar collection in step with Livestorm.

- **Webhook** (`/api/livestorm-webhook`): syncs a single event within seconds of a change in Livestorm.
- **Daily cron** (`/api/sync-all`, 05:00 UTC): a full safety-net sync that catches anything the webhook missed.

## What it writes

| Owned by | Fields | Behaviour |
|---|---|---|
| Livestorm | `date-and-time`, `status` (Upcoming / On demand), `webinar-embedded-form` (Livestorm event ID) | Kept in step on every run |
| Webflow | `name`, `webinar-heading-2`, `webinar-form-title`, `webinar-description`, `webinar---summary` | Written when a webinar is created, or when the field is empty. Edits made in Webflow are never overwritten |

Topic, thumbnail and speakers are not in Livestorm: add them in Webflow after a new webinar appears.
New webinars are created live with a slug made from the title.
Past webinars older than two days skip the Livestorm sessions lookup, so the full sync stays fast.

## Vercel environment variables

| Name | What |
|---|---|
| `LIVESTORM_API_TOKEN` | Livestorm API key (Account settings → Integrations → Public API) |
| `WEBFLOW_TOKEN` | Webflow site API token with CMS read/write |
| `WEBFLOW_COLLECTION_ID` | Webinar collection ID (new site: `6b09455d2d52c5fc6ea4d4a2`) |
| `WEBFLOW_LIVESTORM_ID_FIELD` | optional, default `webinar-embedded-form` |
| `CRON_SECRET` | any long random string; Vercel cron sends it automatically |
| `LIVESTORM_WEBHOOK_SECRET` | any long random string |

Set keys in the Vercel dashboard only. Never commit them.

## Livestorm webhook

In Livestorm → Integrations → Webhooks, add
`https://<vercel-app>/api/livestorm-webhook?key=<LIVESTORM_WEBHOOK_SECRET>`
for the event and session events (created, updated, published, scheduled).

## Manual run

```
curl -H "Authorization: Bearer $CRON_SECRET" https://<vercel-app>/api/sync-all
```

## Tests

`npm test` runs offline against fake APIs.
