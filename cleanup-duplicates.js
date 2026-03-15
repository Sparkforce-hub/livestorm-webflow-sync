 // cleanup-duplicates.js
 // Deletes duplicate Webflow items, keeping one per Livestorm ID

 const WEBFLOW_TOKEN = process.env.WEBFLOW_TOKEN;
 const COLLECTION_ID = process.env.WEBFLOW_COLLECTION_ID;
 const LIVESTORM_ID_FIELD = process.env.WEBFLOW_LIVESTORM_ID_FIELD ||
 "webinar-embedded-form";

 if (!WEBFLOW_TOKEN || !COLLECTION_ID) {
   console.error("Missing WEBFLOW_TOKEN or WEBFLOW_COLLECTION_ID env vars");
   process.exit(1);
 }

 const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

 async function getAllItems() {
   const allItems = [];
   const seen = new Set();
   for (const endpoint of ["items/live", "items"]) {
     let offset = 0;
     while (true) {
       const { resp, json } = await wfFetch(
         `https://api.webflow.com/v2/collections/${COLLECTION_ID}/${endpoint}?l
 imit=100&offset=${offset}`
       );
       if (!resp.ok) break;
       const items = json?.items || [];
       for (const item of items) {
         if (!seen.has(item.id)) {
           seen.add(item.id);
           allItems.push(item);
         }
       }
       if (items.length < 100) break;
       offset += 100;
     }
   }
   return allItems;
 }

 async function deleteItem(itemId) {
   const { resp } = await wfFetch(
     `https://api.webflow.com/v2/collections/${COLLECTION_ID}/items/${itemId}`,
     { method: "DELETE" }
   );
   return resp.ok;
 }

 (async () => {
   console.log("Fetching all Webflow items...");
   const items = await getAllItems();
   console.log(`Total items found: ${items.length}`);

   // Group by Livestorm ID
   const grouped = {};
   for (const item of items) {
     const lsId = String(item?.fieldData?.[LIVESTORM_ID_FIELD] || "");
     if (!lsId) continue;
     if (!grouped[lsId]) grouped[lsId] = [];
     grouped[lsId].push(item);
   }

   // Find duplicates — keep oldest (first createdOn), delete the rest
   const toDelete = [];
   for (const [lsId, dupes] of Object.entries(grouped)) {
     if (dupes.length <= 1) continue;
     dupes.sort((a, b) => new Date(a.createdOn) - new Date(b.createdOn));
     const [keep, ...remove] = dupes;
     console.log(`"${keep.fieldData?.name}" — keeping 1, deleting
 ${remove.length} duplicate(s)`);
     toDelete.push(...remove);
   }

   console.log(`\nWill delete ${toDelete.length} duplicate items...`);
   if (toDelete.length === 0) {
     console.log("Nothing to delete!");
     return;
   }

   let deleted = 0;
   let errors = 0;
   for (const item of toDelete) {
     const ok = await deleteItem(item.id);
     if (ok) {
       deleted++;
       process.stdout.write(`Deleted ${deleted}/${toDelete.length}\r`);
     } else {
       errors++;
       console.log(`\nFailed to delete: ${item.id}`);
     }
     await sleep(300);
   }

   console.log(`\n\nDone! Deleted: ${deleted}, Errors: ${errors}`);
 })();

