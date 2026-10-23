# Tiffany-Designs-Customer-Service

Connects the Sarvam AI voice agent (`Tiffany-Des-0db8e21d-e099`) to Tiffany Designs' Salesforce org. The agent's instructions, tools and test results are in [sarvam/](sarvam/README.md). The website "call me" panel is in [salesforce/](salesforce/README.md).

## Modules

| # | Module | How it is covered |
| --- | --- | --- |
| 1 | AI voice agent and call handling | Sarvam agent v3: inbound, delivery follow-up, callback and service update flows, plus phone orders ([prompt](sarvam/agent-prompt.md)) |
| 2 | After-hours and holiday calls | Agent answers 24/7 and registers requests at once. Salesforce "Tiffany Support Hours" (Mon to Sat, 09:00 to 18:00 IST) flags out-of-hours cases, and the customer hears that the team follows up on the next working day. `check_service_hours` (draft 4) tells the caller whether the team is working now and when it is back. **No holidays are set up in Salesforce yet**, so holidays are not detected |
| 3 | Customer identification | `find_customer`: name, registered mobile, recent orders; a caller who does not know the registered mobile is found by full name and PIN code (draft 4). New callers get an account and contact created by the server. `save_customer_details` (draft 4) saves a new caller's email, other number and address; for an existing customer it leaves a task for the team instead of changing the record |
| 4 | Order identification | `find_order`: any one of the `TD-ORD`/`ORD` id, the Salesforce order number of a phone order (said as "122" or "ORD-00000122") or the invoice number finds the order, and its products and delivery status are given without a second check (a business decision; addresses and phone numbers are never returned). An invoice number on more than one order asks for the order id. A service request links the order the caller named even when their mobile is not on it. Marketplace, invoice and product are recorded when no order is found. For an installation the agent then offers a WhatsApp link to upload the invoice, which is read by AI and matched to the order ([Invoice upload links](#invoice-upload-links)). No ERP API exists; Salesforce holds `ERP_Order_Id__c` |
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
| Uploaded invoices | Each link sent is an open `Task` with the number in its `Subject`; an upload finds it from the phone on the invoice or the order's customer, and completes it. The invoice's `Order` is found by `Invoice_Number__c`, `ERP_Order_Id__c` or order number, else the one recent order of the account of the phone on the invoice. The order takes the invoice's `Invoice_Number__c`, `Order_Source__c`, `EffectiveDate`, shipping and billing address (`ERP_Order_Id__c` only when empty) and the invoice details in `Description`; its `CustomerAuthorizedById` contact takes the name, `MobilePhone`, `Email` and mailing address (a new `Contact` on the order's account when needed); its `OrderItem`s take the invoice's quantities and prices, and missing products are added from the price book (the order is made Draft for this and activated again); the file is a `ContentVersion` on the order; open `Case`s of the caller without an order get `Order__c`; a `Task` notes it all. An unmatched invoice goes on the caller's waiting case, else on a new General Query case with `Origin = Web` |
| Delivery check calls | Orders with `Delivery_Status__c = Delivered` and today's `Delivery_Date__c` (or yesterday's, when saved today), their authorising contact (else the account's first contact with a number), their open cases, and a completed `Task` named "AI delivery check call" on each order that was called |

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
| `GET` or `POST /cron/run` | none (public, one run every 2 minutes) | Delivery check calls (cron-job.org, every 15 minutes); see [Delivery check calls](#delivery-check-calls). `?dryRun=true` lists who would be called and calls nobody. Sooner than 2 minutes after the last run it answers 429 with `Retry-After` |
| `POST /api/agent/*` | `x-agent-secret` | The 16 agent tools; see [sarvam/README.md](sarvam/README.md) |
| `GET /api/invoice-uploads` | none (public) | Whether invoice uploads work right now: `{ available }` |
| `POST /api/invoice-uploads` | none (public, rate-limited) | The invoice as the raw body (`image/jpeg`, `image/png`, `image/webp` or `application/pdf`, up to 8 MB), nothing else. Reads it with OpenAI and records it in Salesforce; answers `{ status: matched \| received \| not_found, invoice_number, order_id, message }`, 422 when the file is not an invoice. 10 uploads an hour and 20 a day per visitor, 30 an hour and 150 a day overall (`INVOICE_UPLOADS_MAX_PER_HOUR`, `INVOICE_UPLOADS_MAX_PER_DAY`) |
| `POST /api/webhooks/sarvam?token=…` | token | Sarvam call-end webhook |
| `GET /api/sarvam/orgs/{org}/workspaces/{ws}/apps/{app}/url` | none (public, rate-limited) | Session endpoint for the Sarvam web call widget: returns Sarvam's signed call URL, adding the API key on the server. Only the Tiffany agent; 5 calls per visitor per 10 minutes and 20 per day, 30 per hour and 200 per day overall (`WEB_CALLS_MAX_PER_HOUR`, `WEB_CALLS_MAX_PER_DAY`). Only requests that get a call link count, so attempts refused because of the server's own setup (such as a refused key) use up nothing. Pages on other sites may call it (CORS, including the browser's preflight); `WEB_CALL_ALLOWED_ORIGINS` limits which sites, and the default `*` allows any |

## Run

```bash
npm install
npm run dev                 # server on PORT (8081)
npm test                    # 299 tests, no network calls
npm run deploy:salesforce   # deploy the website call panel (salesforce/) and its credential
npm run review:salesforce   # read-only review of the org -> salesforce-review.json
```

All settings are in `.env`; see `.env.example`. Locally, scheduled calls are kept in `data/jobs.json` and run by a timer every 30 seconds.

## Deploy on Render (current)

The server runs at process.env.PUBLIC_BASE_URL, built from `main` on GitHub with `npm start`. One process serves the API and runs the scheduler every 30 seconds. The Sarvam agent's tools (version 3) and the website panel's Salesforce credential both point at it.

Render settings:

- **Environment variables:** everything in `.env.example`, with the same secrets as `.env`, including `SARVAM_API_KEY` (the `sk_samvaad_` workspace key). Set `PUBLIC_BASE_URL` to the Render URL, because instant calls give Sarvam that address for the call-end webhook. Set `SARVAM_APP_VERSION=3`, the committed agent version whose tools call Render (version 2's tools call a test tunnel that no longer exists). Raise it whenever a new agent version is committed.
- **Scheduled calls survive restarts only with Redis.** Without `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, jobs are kept in `data/jobs.json`, and Render's disk is wiped on every deploy and restart. A free Upstash database is enough.
- **Free instances sleep** after 15 minutes without traffic. The next request can then take up to a minute, which is longer than the agent's tool timeouts (8 to 20 seconds), and no scheduled call is placed while it sleeps. Use a paid instance, or have an external scheduler (for example cron-job.org) call `GET /api/cron/jobs` every 5 minutes with `Authorization: Bearer <CRON_SECRET>` (set `CRON_SECRET` on Render). This keeps the server awake and places due calls.

## Delivery check calls

cron-job.org calls `/cron/run` on the Render server every 15 minutes. Each run looks at the orders delivered today and calls each customer once, through Sarvam Instant Outbound from `SARVAM_AGENT_PHONE`. Each call carries the customer's name and mobile, the order id, its products, the delivery date and city, and an opening line (see `opening_line` in [sarvam/README.md](sarvam/README.md#variables)). The agent (call reason `delivery_check`) greets the customer, confirms it is speaking to them by name, says which order was delivered on which date, asks whether every part arrived in good condition, and only then offers to create an installation request, without asking again for details it already has. A missing, damaged or wrong part is registered as a service request instead.

An order is called only when all of these hold:

1. `Delivery_Status__c` is Delivered, and the order was delivered today in India: `Delivery_Date__c` is today, or it is yesterday and the order was saved as Delivered today (a delivery marked the next day).
2. At least `DELIVERY_CALL_DELAY_MINUTES` (60) have passed since delivery. Salesforce keeps the delivery date without a time, so the order's last save (never earlier than the moment it was marked Delivered) stands in for it.
3. The customer has an Indian mobile number: the contact who authorised the order, else the account's first contact with a number.
4. The order was not called before, has no open installation, damage or replacement request, and has no follow-up call from `POST /api/orders/delivered`.

Calls go out at any hour, at most `DELIVERY_CALLS_PER_RUN` (5) per run; the rest wait for the next run. With `DELIVERY_CALLS_SERVICE_HOURS_ONLY=true` they go out only while the service team is working (the org's default business hours and holidays), and a run outside those hours answers `outside_service_hours`. Once Sarvam accepts a call, a completed task "AI delivery check call" with Sarvam's call id is saved on the order, and later runs skip it. When Sarvam refuses a call nothing is saved and the next run tries again. When Sarvam does not answer, the call may have gone out, so the order is marked all the same. If saving the task fails, the server remembers the order until it restarts, and the run's response shows `markerError`. The call itself is logged by the call-end webhook like any other call.

The response lists the calls placed and, for every order skipped, the reason. Setup:

- **Render:** set the instant call settings `SARVAM_AGENT_ID`, `SARVAM_APP_VERSION`, `SARVAM_CONNECTION_ID` and `SARVAM_AGENT_PHONE`, plus `PUBLIC_BASE_URL` and `SARVAM_WEBHOOK_TOKEN` for the call log.
- **cron-job.org:** URL `https://<server>/cron/run`, every 15 minutes. The route needs no key for now; anyone who knows the address can start a run, but a run only ever calls customers who are due a call, each order once.
- **Try it first:** open `/cron/run?dryRun=true`. It applies every rule, outside service hours too, and calls nobody.

## Invoice upload links

When a caller wants an installation and no order is found by the order id, order number, invoice number or mobile number, the agent offers to send a link on WhatsApp (Phase 15 of the [prompt](sarvam/agent-prompt.md)). Once the caller confirms the WhatsApp number, `send_invoice_upload_link` posts the event to the WhatsApp integration:

```
POST https://whatsapp.startbit.co/api/integrations/voice-agent/events
Authorization: Bearer <WHATSAPP_API_KEY>
{ "event": "invoice_upload_requested", "phone_number": "+919876543210", "customer_name": "Asha Sharma",
  "invoice_date": "23 October 2026", "invoice_upload_link": "https://<site>/invoice" }
```

`invoice_upload_link` is the website's `/invoice` page, the same for every customer (http://localhost:3000/invoice unless `WEBSITE_URL` says otherwise). `invoice_date` is the day the link was sent, in India, and `customer_name` is "Customer" when the caller gave no name. Before the message goes out, the server saves an open Salesforce task "Invoice upload link sent on WhatsApp to +91…" with the caller's name and what they said on the call (it is removed again when WhatsApp refuses the message). One number gets at most 3 links a day. The agent then registers the installation request without the order.

The customer opens the page on the website (`web/`, page `/invoice`), chooses a photo, screenshot or PDF of the invoice, and the page sends only the file, through its own route, to `POST /api/invoice-uploads`. Nothing else is asked. Photos are scaled down to a JPEG of at most 2000 pixels in the browser first. The server reads the invoice with an OpenAI vision model (`OPENAI_OCR_MODEL`, default `gpt-4.1-mini`) as structured fields: invoice number, order id, dates, seller and channel, the customer's name, phone, email, delivery and billing address, the products and the total. Then it looks for the order:

1. By the invoice number, then by the order id (exact first, then by the number at the end, as `find_order` does). When several orders match, the one on the account of the phone on the invoice wins.
2. Else by the phone on the invoice, when that customer has exactly one recent order that carries no other invoice number.

Since the page asks for nothing but the file, the WhatsApp link an upload answers is found from the invoice: the newest link sent in the last `INVOICE_LINK_DAYS` (7) days to the phone on the invoice, or to the customer of the matched order. That link gives the caller's WhatsApp number, name and what they said on the call.

A matched order is brought in line with the invoice; where they differ, the invoice wins:

- **Order details:** invoice number (left alone when it is the same number written differently), channel (`Order_Source__c`), order date (`EffectiveDate`, from the order date or else the invoice date), delivery address and billing address (with the state code). The order id (`ERP_Order_Id__c`) is only filled in when empty, never replaced, because callers and other systems look orders up by it.
- **Customer details:** the order's contact (`CustomerAuthorizedById`) takes the invoice's name, mobile, email and address (the billing address, else the delivery address). An order without a contact gets the contact of its account with the invoice's or the caller's number, else a new contact made from the invoice.
- **Products:** each invoice line is matched to a Tiffany product (code starting `PRODUCT_CODE_PREFIX`, `TD-`) by its product code, else by the product whose every name word is in the line, the most specific one. A product already on the order gets the invoice's quantity and price (line amount divided by the quantity); a product not yet on the order is added. Salesforce changes products only on a Draft order, so an activated order is made Draft for the change and activated again; the purchase recommendation flow sends nothing twice. Invoice lines that match no product, and products that are only on the order, are left as they are and listed for the team.

Every change is saved with its old and new value in a task "Order updated from the uploaded invoice" on the order, together with everything read from the invoice. A value Salesforce refuses (for example the date of an activated order) is left out on its own and listed, and the task stays open whenever something needs a look. Everything read is also added to the order's notes (once per invoice number), the file is attached to the order, and, when the link was found, the caller's open requests that have no order (on the WhatsApp number or the caller's contact, registered from an hour before the link was sent) are linked to it. An invoice that matches no order is attached to the caller's newest waiting request with an open task, or else becomes a new General Query request (`Origin = Web`) on the WhatsApp number or the phone on the invoice. When the invoice matches no order and shows no phone, nothing is recorded and the page asks the customer to call customer care. Whenever the link was found, its task is completed with the outcome. The customer sees only whether the invoice was matched, received or not found; nothing from Salesforce is shown on the page.

The page has no key at all, so anyone can upload an invoice to it, and an uploaded invoice changes the order it names. That is why every change is recorded with its old value, nothing is recorded for a file that is not an invoice, the order id is never replaced, and uploads are limited: 10 an hour and 20 a day per visitor, and 30 an hour and 150 a day overall.

Setup:

- **Node server:** `OPENAI_API_KEY` (an OpenAI account with credits) for reading invoices, and `WHATSAPP_API_KEY` (the workspace voice agent API key of the WhatsApp integration) for sending the link. Optional: `WEBSITE_URL` (the website the link points to; `http://localhost:3000` by default, so set it to the deployed site, for example `https://<site>.vercel.app`, once the site is public), `OPENAI_OCR_MODEL`, `INVOICE_LINK_DAYS` (7), `WHATSAPP_EVENTS_URL`, `INVOICE_UPLOADS_MAX_PER_HOUR`, `INVOICE_UPLOADS_MAX_PER_DAY`. Without the keys, the page says uploads are not available and the agent hears that no link can be sent.
- **Vercel (website):** only `NODE_API_URL`, which the site already has. No key is involved.
- **Sarvam:** the `send_invoice_upload_link` tool and the prompt changes are in draft 6 of the stage agent. Commit it after the server is deployed, then set `SARVAM_APP_VERSION`.

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
- **The customer care page** (`/support`, public, no sign-in; `/call` redirects there): what the Tiffany Designs AI service assistant (the voice agent) can help with, what to keep handy, how a call works, and the service team's hours (live from Salesforce, kept for 5 minutes; nothing else from the console is shown). Customers press **Start a voice call** (or the button at the bottom right) to talk to the agent in the browser. When a call cannot start they see a plain message with the phone number; the technical reason goes to the browser console for staff. The staff console has no call widget.
- **The invoice upload page** (`/invoice`, public, one address for every customer, sent by the voice agent on WhatsApp): the customer uploads a photo, screenshot or PDF of the invoice, and nothing else is asked. The page sends the file through `app/api/invoice/route.js` (logic in `lib/invoiceUpload.js`) to the Node server's `/api/invoice-uploads`; files over 4 MB and other file types are refused before anything is sent. See [Invoice upload links](#invoice-upload-links).

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
