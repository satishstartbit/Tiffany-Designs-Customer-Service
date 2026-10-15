# Tiffany-Designs-Customer-Service

Connects the Sarvam AI voice agent (`Tiffany-Des-0db8e21d-e099`) to Tiffany Designs' Salesforce org. The agent's instructions, tools and test results are in [sarvam/](sarvam/README.md). The website "call me" panel is in [salesforce/](salesforce/README.md).

## Modules

| # | Module | How it is covered |
| --- | --- | --- |
| 1 | AI voice agent and call handling | Sarvam agent v3: inbound, delivery follow-up, callback and service update flows, plus phone orders ([prompt](sarvam/agent-prompt.md)) |
| 2 | After-hours and holiday calls | Agent answers 24/7 and registers requests at once. Salesforce "Tiffany Support Hours" (Mon to Sat, 09:00 to 18:00 IST) flags out-of-hours cases, and the customer hears that the team follows up on the next working day. `check_service_hours` (draft 4) tells the caller whether the team is working now and when it is back. **No holidays are set up in Salesforce yet**, so holidays are not detected |
| 3 | Customer identification | `find_customer`: name, registered mobile, recent orders; a caller who does not know the registered mobile is found by full name and PIN code (draft 4). New callers get an account and contact created by the server. `save_customer_details` (draft 4) saves a new caller's email, other number and address; for an existing customer it leaves a task for the team instead of changing the record |
| 4 | Order identification | `find_order`: any one of the `TD-ORD`/`ORD` id, the Salesforce order number of a phone order (said as "122" or "ORD-00000122") or the invoice number finds the order, and its products and delivery status are given without a second check (a business decision; addresses and phone numbers are never returned). An invoice number on more than one order asks for the order id. A service request links the order the caller named even when their mobile is not on it. Marketplace, invoice and product are recorded when no order is found. No ERP API exists; Salesforce holds `ERP_Order_Id__c` |
| 5 | Intent detection and classification | Agent picks one of 14 issue types, each mapped to `Service_Type__c` / `Service_Sub_Type__c` |
| 6 | Installation requests | `book_installation` with `resolve_date`: new, reschedule, follow-up and re-installation |
| 7 | Damage and defect complaints | `find_parts` (part number), quantity, delivery damage versus later damage; part linked as `Damaged_Component__c` |
| 8 | Automatic case creation | The server creates the Salesforce case during the call, and a fallback case from the call-end webhook when the agent could not register one |
| 9 | Location and routing | Agent collects city and PIN; Salesforce flow `Case_Service_Routing` with `Service_Region__mdt` sends Delhi NCR to the Internal Service Team and others to Provider Coordination. `check_service_area` (draft 4) applies the same rules during the call, so the caller hears who will visit and a wrong PIN is caught early |
| 10 | Human handoff and escalation | `request_human_callback`: escalated case for a callback, with `check_service_hours` for when the team calls back. Live transfer needs the team's number |
| 11 | Technician and provider coordination | Cases land in the right queue; `check_request_status` reads `Service_Visit__c` (technician, schedule) |
| 12 | Replacement requests | Replacement and return requests registered for assessment; `Replacement_Shipment__c` status is readable |
| 13 | Notifications and follow-ups | Delivery follow-up call 1 hour after delivery. `POST /api/calls/notify` for case registered, appointment scheduled and replacement dispatched; off until `SARVAM_NOTIFY_CAMPAIGN_ID` is set |
| 14 | Service history and call logging | Every call becomes a Task (outcome, summary, transcript, recording) linked to the contact and to the case or order from that call, or else the order the call was about. `get_service_history` (draft 4) reads back the latest requests, closed ones included, and the latest calls |
| 15 | ERP and telephony integration | Node logic over the Salesforce REST data API; Sarvam campaigns, deployments and call-end webhooks |
| + | Phone orders | `find_products` (list prices) and `place_order`: the customer orders by name, mobile and delivery address; Salesforce gets a Draft order for the sales team to confirm |

## How it uses Salesforce

All business logic runs in Node (`src/crm/`). The server reads and writes records through Salesforce's standard REST data API (SOQL, SOSL, describe, create, update and delete); it does not call any Apex. The only Salesforce automation involved is the routing flow, which runs by itself whenever a Case is saved.

| Need | Done in Node with |
| --- | --- |
| Verify an order | `Order` by `ERP_Order_Id__c`, invoice number or (for phone orders, which have no ERP id yet) `OrderNumber`. It is shown only when the invoice number matches, a mobile on the order's account matches, or the caller's full name matches the account or one of its contacts. Unknown and unverified orders give the same answer |
| Callers without the registered mobile | A full name must have a first and a last name; each word may be one letter off (speech recognition), and titles and the "Demo Customer" prefix are ignored. Accepted with an order id or invoice number (`find_order`), with a request number (`check_request_status`, which also accepts the order id on the request), or with a PIN code that is on the customer's address or one of their orders (`find_customer`, only when exactly one customer matches). Addresses and phone numbers are never read back |
| Products and prices | Active `PricebookEntry` rows in the standard price book whose product code starts with `PRODUCT_CODE_PREFIX` (`TD-`) |
| Place an order | `Order` with `Status = Draft`, the standard price book, `Order_Source__c = Other`, the shipping address (state code from the Order describe) and a note for the sales team, then its `OrderItem` lines at list price in one composite call. If the lines fail, the order is deleted again. The org's purchase recommendation flow only runs when someone activates the order |
| Create a case | `Case` created with the record type for its Service Type, `Service_Type__c` / `Service_Sub_Type__c`, `Origin = Phone`, the order, the contact, the part (`Damaged_Component__c`) and the city and PIN. Callback requests are created as `Escalated` |
| New callers | An `Account` and `Contact` are created from the name and mobile (and the billing address, for an order). Set `SF_CUSTOMER_ACCOUNT_RECORD_TYPE` once the org has a customer Account record type; today the only one is "Service Provider" |
| Out-of-hours note | Default business hours ("Tiffany Support Hours", IST) and `Holiday` records |
| Route the case | Flow `Case_Service_Routing` with `Service_Region__mdt` sets `Service_Route__c` and the owning queue on save. The server never sets the route |
| Status | `Case`, the latest `Service_Visit__c` and `Replacement_Shipment__c` |
| Parts | `Product_Component__c` |
| Call log | `Task` (call subtype, `CallType`, `CallDisposition`, `CallObject` = Sarvam interaction id), linked to the case or order created during the call, found in Salesforce by creation time rather than trusted from the agent's notes |

## API

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness |
| `GET /health/salesforce` | `x-api-key` | Live Salesforce check (costs one API call) |
| `POST /api/orders/delivered` | `x-api-key` | `{ orderId \| erpOrderId, deliveredAt?, phone?, customerName? }`; schedules the follow-up call 1 hour after delivery |
| `DELETE /api/orders/delivered/:orderId` | `x-api-key` | Cancels a scheduled follow-up |
| `POST /api/calls/request` | `x-api-key` (internal or site key) | `{ phone, consent: true, name?, orderNumber?, recordId?, source? }`; the agent calls now (Sarvam Instant Outbound), rate-limited per number and overall |
| `POST /api/calls/notify` | `x-api-key` | `{ caseId \| caseNumber, event }`, where `event` is `case_registered`, `appointment_scheduled` or `replacement_dispatched` |
| `GET /api/jobs` | `x-api-key` | Scheduled calls and their status |
| `GET /api/admin/*` | `x-api-key` (internal) | Read-only data for the service console (`web/`), from Salesforce: `summary`, `products` and `products/:id`, `orders` and `orders/:id`, `customers` and `customers/:id`, `cases` and `cases/:id`, `field-service`, `activities`, `requests`, `service`. Lists take `q`, filters checked against the org's picklists, `page` and `pageSize` (up to 100) |
| `GET /api/admin/orders/:id/edit` | `x-api-key` (internal) | An order's editable values with the org's choices (statuses, delivery statuses, channels, fulfilment, Indian states) and field lengths |
| `PATCH /api/admin/orders/:id` | `x-api-key` (internal) | Edits an order: `status`, `deliveryStatus`, `deliveryDate`, `erpOrderId`, `invoiceNumber`, `source`, `fulfilment`, `orderDate`, `description`, `shippingStreet`, `shippingCity`, `shippingState` (state code), `shippingPostalCode`; an empty string clears a field. Each value is checked against the org's own rules (picklists, lengths, dates, six-digit PIN, required fields) before saving, only real changes are sent, and a completed task on the order records who changed what (`X-Console-User`). Answers 400 with `field` for a bad value, 422 when Salesforce refuses (for example a duplicate order id), 404 for an unknown order |
| `GET /api/cron/jobs` | `Authorization: Bearer <CRON_SECRET>` | Places the scheduled calls that are due (Vercel Cron, every 5 minutes) |
| `POST /api/agent/*` | `x-agent-secret` | The 15 agent tools; see [sarvam/README.md](sarvam/README.md) |
| `POST /api/webhooks/sarvam?token=…` | token | Sarvam call-end webhook |
| `GET /api/sarvam/orgs/{org}/workspaces/{ws}/apps/{app}/url` | none (public, rate-limited) | Session endpoint for the Sarvam web call widget: returns Sarvam's signed call URL, adding the API key on the server. Only the Tiffany agent; 5 calls per visitor per 10 minutes and 20 per day, 30 per hour and 200 per day overall (`WEB_CALLS_MAX_PER_HOUR`, `WEB_CALLS_MAX_PER_DAY`). Only requests that get a call link count, so attempts refused because of the server's own setup (such as a refused key) use up nothing. Pages on other sites may call it (CORS, including the browser's preflight); `WEB_CALL_ALLOWED_ORIGINS` limits which sites, and the default `*` allows any |

## Run

```bash
npm install
npm run dev                 # server on PORT (8081)
npm test                    # 204 tests, no network calls
npm run deploy:salesforce   # deploy the website call panel (salesforce/) and its credential
npm run review:salesforce   # read-only review of the org -> salesforce-review.json
```

All settings are in `.env`; see `.env.example`. Locally, scheduled calls are kept in `data/jobs.json` and run by a timer every 30 seconds.

## Deploy on Render (current)

The server runs at `https://tiffany-designs-customer-service.onrender.com`, built from `main` on GitHub with `npm start`. One process serves the API and runs the scheduler every 30 seconds. The Sarvam agent's tools (version 3) and the website panel's Salesforce credential both point at it.

Render settings:

- **Environment variables:** everything in `.env.example`, with the same secrets as `.env`, including `SARVAM_API_KEY` (the `sk_samvaad_` workspace key). Set `PUBLIC_BASE_URL` to the Render URL, because instant calls give Sarvam that address for the call-end webhook. Set `SARVAM_APP_VERSION=3`, the committed agent version whose tools call Render (version 2's tools call a test tunnel that no longer exists). Raise it whenever a new agent version is committed.
- **Scheduled calls survive restarts only with Redis.** Without `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, jobs are kept in `data/jobs.json`, and Render's disk is wiped on every deploy and restart. A free Upstash database is enough.
- **Free instances sleep** after 15 minutes without traffic. The next request can then take up to a minute, which is longer than the agent's tool timeouts (8 to 20 seconds), and no scheduled call is placed while it sleeps. Use a paid instance, or have an external scheduler (for example cron-job.org) call `GET /api/cron/jobs` every 5 minutes with `Authorization: Bearer <CRON_SECRET>` (set `CRON_SECRET` on Render). This keeps the server awake and places due calls.

## Deploy on Vercel

`api/index.js` serves the whole Express app as one function (`vercel.json` rewrites every path to it, in the Mumbai region `bom1`). A serverless function keeps no files and no timers between requests, so on Vercel:

- **Scheduled calls and callback limits live in Upstash Redis.** In the Vercel project, open Storage (Marketplace), add Upstash Redis and connect it; it sets `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`), and both names work. Without it, `/api/orders/delivered`, `/api/calls/notify` and `/api/jobs` answer 503 instead of losing jobs, and callback limits only count per instance.
- **Vercel Cron runs due jobs** by calling `GET /api/cron/jobs` every 5 minutes. Set `CRON_SECRET` (any long random string); Vercel sends it as a Bearer token. A notification call is therefore placed within about 5 minutes of `/api/calls/notify`.
- **Plan:** a cron more often than once a day needs the Pro plan; on Hobby the deployment is refused. On Hobby, remove `crons` from `vercel.json` and have an external scheduler (for example cron-job.org) call `/api/cron/jobs` every 5 minutes with the `Authorization: Bearer <CRON_SECRET>` header.

Steps:

1. Import the GitHub repository into Vercel (framework preset "Other"; there is no build step).
2. Connect Upstash Redis, then add the variables from `.env.example` under Settings → Environment Variables, including `CRON_SECRET`. `PUBLIC_BASE_URL` can be left empty: it defaults to the production domain.
3. Deploy, then check `GET /health` and `GET /health/salesforce` (with `x-api-key`).
4. Point the Salesforce credential (`npm run deploy:salesforce`) and the Sarvam agent's tools at the production URL, as in step 2 of the setup below.

`.vercelignore` keeps `salesforce/`, `sarvam/`, `scripts/`, `test/`, `web/` and `.env` out of the upload; only `public/` (robots.txt) is served as static files.

## Service console and voice call site (Next.js on Vercel)

`web/` is a separate Next.js app (it replaced the old `public/test.html`) with two parts:

- **The service console** (`/`, behind a staff sign-in): dashboard, products by category, orders (with an edit page for status, delivery, order id, invoice, channel, dates, ship-to address and notes), customers, cases, requests (call backs, scheduled calls, to-dos), technician visits and replacement shipments, calls and emails, the voice agent's hours and coverage, and a search across all of them. Each page reads Salesforce live through the Node server's `/api/admin` (below), from the site's server with `NODE_API_KEY` (the Node server's `INTERNAL_API_KEY`); no browser holds that key. The sign-in is `ADMIN_EMAIL` / `ADMIN_PASSWORD`, kept in a signed cookie (`SESSION_SECRET`) for 12 hours, with wrong passwords limited per visitor. The look follows the ROCCO storefront: warm off-white, black uppercase buttons, maroon accents, Red Hat Display.
- **The customer care page** (`/support`, public, no sign-in; `/call` redirects there): what Satish Choudhary, the AI voice agent, can help with, what to keep handy, how a call works, and the service team's hours (live from Salesforce, kept for 5 minutes; nothing else from the console is shown). Customers press **Start a voice call** (or the button at the bottom right) to talk to the agent in the browser. When a call cannot start they see a plain message with the phone number; the technical reason goes to the browser console for staff. The staff console has no call widget.

For calls, the site has its own session endpoint, `app/api/sarvam/orgs/[orgId]/workspaces/[workspaceId]/apps/[appId]/url/route.js` (logic in `lib/webSession.js`), so it needs no other server: the Sarvam key stays in the site's server environment, and the browser only gets the signed call URL. Like the Node server's route, it reaches only the Tiffany agent, allows each visitor 5 calls per 10 minutes and 20 per day (30 per hour and 200 per day overall), and counts only calls that got a link. A line on the page names the server it uses and, when a call cannot start, the reason. Variables are listed in `web/.env.example`.

- **Local:** `cd web`, `npm install`, fill `web/.env.local` from `web/.env.example` (`SARVAM_API_KEY` is the `sk_samvaad_` key from `.env`, `NODE_API_URL=http://localhost:8081`, `NODE_API_KEY` is `INTERNAL_API_KEY` from `.env`), run the Node server (`npm run dev` at the root) and `npm run dev` in `web/`, then open http://localhost:3000 and sign in. `?server=http://localhost:8081` makes calls go through the local Node server.
- **Vercel:** add a new project from this repository and set **Root Directory** to `web` (Next.js is detected; `web/vercel.json` runs the functions in Mumbai, `bom1`). Under Settings → Environment Variables add `SARVAM_API_KEY` (the value only, no quotes), `NODE_API_URL` (the Render URL), `NODE_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` and `SESSION_SECRET`, optionally `SARVAM_APP_VERSION=3`, then deploy. The Node server must run the code with `/api/admin` (push it to Render first). For limits shared by all instances, connect Upstash Redis under Storage (it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`); without it each instance counts on its own. The CLI also works: `npx vercel --prod` inside `web/`; `web/.vercelignore` keeps local `.env` files out of the upload.
- Do not set `NEXT_PUBLIC_VOICE_SERVER_URL` on Vercel unless the site should use another server's `/api/sarvam/` (for example Render); that server then needs the key, and must allow the site in `WEB_CALL_ALLOWED_ORIGINS` if that is narrowed.

## Remaining setup

1. **Sarvam workspace API key.** Done locally: `SARVAM_API_KEY` in `.env` holds the `sk_samvaad_` workspace key, which Sarvam accepts. Set the same value on Render. Keep it out of web pages: the web widget uses `session-endpoint`, never `api-key`.
2. **Server deployment: done on [Render](#deploy-on-render).** The agent's tools (committed version 3) and the website panel (`npm run deploy:salesforce`) point at it. On Render, set `SARVAM_APP_VERSION=3` and `PUBLIC_BASE_URL`, and add Upstash Redis so scheduled calls are not lost on restarts.
3. **Phone number.** `+917965851546` is deployed to another agent (Startbit Hospital). The website panel uses it as the caller ID for test calls only, because customers who call it back reach that agent. Tiffany needs its own number, set in `SARVAM_AGENT_PHONE`, before any deployment, campaign or real customer calls.
4. **Campaigns and deployment** on that number, with the webhook URL; put the campaign IDs in `.env`.
5. **Salesforce flows** to call this server:
   - Order, when `Delivery_Status__c` changes to Delivered: `POST /api/orders/delivered` with `{ "orderId": "{!$Record.Id}" }`.
   - Optional (module 13): Service_Visit__c becomes Appointment Scheduled, or Replacement_Shipment__c becomes Dispatched: `POST /api/calls/notify`.
   - Both need the `INTERNAL_API_KEY` in the `x-api-key` header, so give them their own credential. `Tiffany_Agent_API` belongs to the website chat (Agentforce), and the `Tiffany_Voice_API` key can only request calls.
6. **Salesforce data:** add holidays to "Tiffany Support Hours" (module 2). Consider routing cases without a location to a queue: today they stay with the integration user, because `Case_Service_Routing` assigns nothing when city and PIN are empty.
7. **Sales follow-up for phone orders.** Orders placed by the agent are Draft orders with `Order_Source__c = Other`, owned by the integration user, with a description that starts "Placed by phone through the Sarvam AI voice agent". Nothing notifies the sales team yet, so give them a list view or report on these orders (or an assignment rule), and have them activate an order once price, delivery and payment are agreed. The agent cannot verify that a caller owns the mobile number they give, which is why every order waits for this confirmation call.
