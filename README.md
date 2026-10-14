# Tiffany-Designs-Customer-Service

Connects the Sarvam AI voice agent (`Tiffany-Des-0db8e21d-e099`) to Tiffany Designs' Salesforce org. The agent's instructions, tools and test results are in [sarvam/](sarvam/README.md). The website "call me" panel is in [salesforce/](salesforce/README.md).

## Modules

| # | Module | How it is covered |
| --- | --- | --- |
| 1 | AI voice agent and call handling | Sarvam agent v2: inbound, delivery follow-up, callback and service update flows, plus phone orders ([prompt](sarvam/agent-prompt.md)) |
| 2 | After-hours and holiday calls | Agent answers 24/7 and registers requests at once. Salesforce "Tiffany Support Hours" (Mon to Sat, 09:00 to 18:00 IST) flags out-of-hours cases, and the customer hears that the team follows up on the next working day. **No holidays are set up in Salesforce yet**, so holidays are not detected |
| 3 | Customer identification | `find_customer`: name, registered mobile, recent orders. New callers get an account and contact created by the server |
| 4 | Order identification | `find_order`: `TD-ORD` id or invoice number plus a mobile on the order's account, checked by the server. Marketplace, invoice and product are recorded when an order cannot be verified. No ERP API exists; Salesforce holds `ERP_Order_Id__c` |
| 5 | Intent detection and classification | Agent picks one of 14 issue types, each mapped to `Service_Type__c` / `Service_Sub_Type__c` |
| 6 | Installation requests | `book_installation` with `resolve_date`: new, reschedule, follow-up and re-installation |
| 7 | Damage and defect complaints | `find_parts` (part number), quantity, delivery damage versus later damage; part linked as `Damaged_Component__c` |
| 8 | Automatic case creation | The server creates the Salesforce case during the call, and a fallback case from the call-end webhook when the agent could not register one |
| 9 | Location and routing | Agent collects city and PIN; Salesforce flow `Case_Service_Routing` with `Service_Region__mdt` sends Delhi NCR to the Internal Service Team and others to Provider Coordination |
| 10 | Human handoff and escalation | `request_human_callback`: escalated case for a callback. Live transfer needs the team's number |
| 11 | Technician and provider coordination | Cases land in the right queue; `check_request_status` reads `Service_Visit__c` (technician, schedule) |
| 12 | Replacement requests | Replacement and return requests registered for assessment; `Replacement_Shipment__c` status is readable |
| 13 | Notifications and follow-ups | Delivery follow-up call 1 hour after delivery. `POST /api/calls/notify` for case registered, appointment scheduled and replacement dispatched; off until `SARVAM_NOTIFY_CAMPAIGN_ID` is set |
| 14 | Service history and call logging | Every call becomes a Task (outcome, summary, transcript, recording) linked to the contact and to the case or order from that call, or else the order the call was about |
| 15 | ERP and telephony integration | Node logic over the Salesforce REST data API; Sarvam campaigns, deployments and call-end webhooks |
| + | Phone orders | `find_products` (list prices) and `place_order`: the customer orders by name, mobile and delivery address; Salesforce gets a Draft order for the sales team to confirm |

## How it uses Salesforce

All business logic runs in Node (`src/crm/`). The server reads and writes records through Salesforce's standard REST data API (SOQL, SOSL, describe, create, update and delete); it does not call any Apex. The only Salesforce automation involved is the routing flow, which runs by itself whenever a Case is saved.

| Need | Done in Node with |
| --- | --- |
| Verify an order | `Order` by `ERP_Order_Id__c`, invoice number or (for phone orders, which have no ERP id yet) `OrderNumber`. It is shown only when the invoice number matches, or a mobile on the order's account matches. Unknown and unverified orders give the same answer |
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
| `GET /api/cron/jobs` | `Authorization: Bearer <CRON_SECRET>` | Places the scheduled calls that are due (Vercel Cron, every 5 minutes) |
| `POST /api/agent/*` | `x-agent-secret` | The 10 agent tools; see [sarvam/README.md](sarvam/README.md) |
| `POST /api/webhooks/sarvam?token=…` | token | Sarvam call-end webhook |

## Run

```bash
npm install
npm run dev                 # server on PORT (8081)
npm test                    # 167 tests, no network calls
npm run deploy:salesforce   # deploy the website call panel (salesforce/) and its credential
npm run review:salesforce   # read-only review of the org -> salesforce-review.json
```

All settings are in `.env`; see `.env.example`. Locally, scheduled calls are kept in `data/jobs.json` and run by a timer every 30 seconds.

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

`.vercelignore` keeps `salesforce/`, `sarvam/`, `scripts/`, `test/` and `.env` out of the upload; only `public/robots.txt` is served as a static file.

## Remaining setup

1. **Sarvam workspace API key.** Create one in the Sarvam agents dashboard (Settings → API keys) and put it in `SARVAM_API_KEY`. The current `sk_...` key is a speech-API key and Sarvam refuses it, so no call can start until this is done.
2. **Deploy the server** at a permanent HTTPS address ([Vercel](#deploy-on-vercel)) and set `PUBLIC_BASE_URL` if it is not the Vercel production domain. Then run `npm run deploy:salesforce` to point the website panel at it, and re-point the agent's tools as described in [sarvam/README.md](sarvam/README.md#re-pointing-the-tools-after-deployment). Both currently use a temporary test tunnel.
3. **Phone number.** `+917965851546` is deployed to another agent (Startbit Hospital). The website panel uses it as the caller ID for test calls only, because customers who call it back reach that agent. Tiffany needs its own number, set in `SARVAM_AGENT_PHONE`, before any deployment, campaign or real customer calls.
4. **Campaigns and deployment** on that number, with the webhook URL; put the campaign IDs in `.env`.
5. **Salesforce flows** to call this server:
   - Order, when `Delivery_Status__c` changes to Delivered: `POST /api/orders/delivered` with `{ "orderId": "{!$Record.Id}" }`.
   - Optional (module 13): Service_Visit__c becomes Appointment Scheduled, or Replacement_Shipment__c becomes Dispatched: `POST /api/calls/notify`.
   - Both need the `INTERNAL_API_KEY` in the `x-api-key` header, so give them their own credential. `Tiffany_Agent_API` belongs to the website chat (Agentforce), and the `Tiffany_Voice_API` key can only request calls.
6. **Salesforce data:** add holidays to "Tiffany Support Hours" (module 2). Consider routing cases without a location to a queue: today they stay with the integration user, because `Case_Service_Routing` assigns nothing when city and PIN are empty.
7. **Sales follow-up for phone orders.** Orders placed by the agent are Draft orders with `Order_Source__c = Other`, owned by the integration user, with a description that starts "Placed by phone through the Sarvam AI voice agent". Nothing notifies the sales team yet, so give them a list view or report on these orders (or an assignment rule), and have them activate an order once price, delivery and payment are agreed. The agent cannot verify that a caller owns the mobile number they give, which is why every order waits for this confirmation call.
