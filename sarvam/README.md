# Sarvam agent: Tiffany Designs Customer Service

Agent `Tiffany-Des-0db8e21d-e099`, committed as **version 3**: the same instructions as version 2, with every tool calling the Render deployment (version 2's tools call a test tunnel that no longer exists, and version 1 had no phone orders). The instructions are in [agent-prompt.md](agent-prompt.md), and the tool IDs and endpoints are in [tools.json](tools.json). Only this agent may be changed; the Sarvam workspace is shared with other agents.

**Draft version 4** adds four tools for modules 2, 3, 9 and 14: `check_service_hours`, `save_customer_details`, `check_service_area` and `get_service_history`. It also adds Phase 13 (customer details) to the instructions. It also stops asking for details Salesforce already has: `get_details_on_file` gives the last four digits of the mobile number and the city and PIN code on file for the order (or the caller's registered mobile), the agent confirms them, and `register_service_request`, `book_installation` and `request_human_callback` take `use_details_on_file` (their `phone` is no longer required), so the server fills in the full mobile number and address (Phase 5 step 6). Their endpoints are in this repository but not yet on Render. Commit version 4 only after the code is deployed, then set `SARVAM_APP_VERSION=4` on Render.

## Module coverage

| # | Module | Tools and instructions |
| --- | --- | --- |
| 1 | AI voice agent and call handling | Phases 1 to 4 and 11; `resolve_date` |
| 2 | After-hours and holiday calls | `check_service_hours` (open now, next opening, Salesforce holidays); requests are registered at any hour |
| 3 | Customer identification and contact management | `find_customer` (by mobile, or by full name and PIN code); `save_customer_details` (Phase 13) |
| 4 | Order and purchase identification | `find_order` (ERP id, invoice or order number; no second check) |
| 5 | Intent detection and case classification | Phase 4; the issue type sent with each request |
| 6 | Installation requests | `book_installation`, `resolve_date` |
| 7 | Damage and defect complaints | `find_parts`, `register_service_request` |
| 8 | Automatic case creation | `register_service_request`, `book_installation`, `request_human_callback`; fallback case from the call-end webhook |
| 9 | Service location and case routing | `check_service_area` (same rules as the `Case_Service_Routing` flow) |
| 10 | Human handoff and escalation | `request_human_callback`, with `check_service_hours` for when the team calls back. Live transfer needs the team's phone number |
| 11 | Technician and service provider coordination | `check_request_status` (visit and technician) |
| 12 | Replacement requests | `register_service_request` (replacement, return); shipment status in `check_request_status` |
| 13 | Notifications and follow-ups | Server-started calls: delivery follow-up and service updates |
| 14 | Service history and call logging | `get_service_history`; every call is logged as a Task by the webhook |
| 15 | ERP and telephony integration | All tools go through the Node server to Salesforce; Sarvam handles telephony |

**Language.** The customer picks the language at the start of the call, and the agent keeps to it until the customer asks for another one (Phase 0 and the Language guardrail). This needs two agent settings next to the instructions: automatic language detection off (`language_config.enable_language_identification: false`, "Auto-detected language switch" in the dashboard), so the agent no longer follows whatever language it hears, and language switching on with all 11 languages allowed, so the core tool `change_output_language` stays available for when the customer asks. The starting language stays Hindi. After the call, `preferred_language` is saved on the caller's contact (`Contact.Languages__c`, shown in the console) and noted on the call Task.

**Repeat requests.** Before a new installation, damage or part, or replacement or return request is registered on an order, the agent checks for an open request of the same kind on that order. `find_order` names the open kinds and the day each was registered, without request numbers. `book_installation` and `register_service_request` refuse a same-kind request unless `new_request` is true, and say what is open. The agent asks the customer whether they want an update on the open request (Phase 9, verified as usual) or a new one. A reschedule is never compared. Older cases often have no sub type, so the kinds are broad: any open installation (except a follow-up or re-installation), any damage or defect, any replacement or return. General queries and call backs are not compared. The website chat's Apex intake does not have this check.

**Installation address.** For an installation the agent asks whether to install at the address where the order was delivered or somewhere else (Phase 6 step 2, `get_installation_address`). When the customer chooses the delivery address it is not asked for again, and `book_installation` is sent `at_delivery_address`; otherwise the agent takes the new address, city and PIN code. Most older demo orders (TD-ORD-1001 to 1007) have no delivery address on the order, so the agent offers the customer's own address on file and says the order has none. The case notes which address the customer chose.

**Name.** The agent introduces itself as the Tiffany Designs AI service assistant, with no personal name, and says it is an AI assistant when asked. Nothing a customer or staff member hears or sees names the voice platform: not the agent, the website (the call widget's own panel title is replaced in the page), the console, the Salesforce panel, or the text written to Salesforce records. Only technical names stay: environment variables (`SARVAM_*`), code modules, the `/api/sarvam` address and the widget library.

## Call types

`call_reason` selects the flow. Outbound calls get their opening line from the server (`app_overrides.initial_bot_message`), and that line only confirms who answered.

| `call_reason` | Who starts it | Opening line |
| --- | --- | --- |
| `inbound` | Customer calls the Tiffany number | Namaste, welcome to Tiffany Designs customer care. This is the Tiffany Designs AI service assistant. Would you like to talk in Hindi or English? (translated into all 11 languages; the Hindi line, which is the one spoken since Hindi is the starting language, ends with the question in English too) |
| `delivery_followup` | Server, 1 hour after `Delivery_Status__c` becomes Delivered | Hello, this is the Tiffany Designs AI service assistant. Am I speaking with {name}? |
| `delivery_check` | Server, `/cron/run` every 15 minutes, an hour or more after delivery (see the main README) | Same as delivery follow-up. Phase 14 asks whether every part of `product_name` arrived, and offers installation only when it did |
| `callback_request` | Server, when a customer leaves a number | …calling back as requested. Am I speaking with {name}? |
| `service_update` | Server, on a case event (module 13) | Same as delivery follow-up; the update text is passed in `notice_details` |

## Variables

| Variable | Set by | Purpose |
| --- | --- | --- |
| `customer_name`, `customer_phone`, `order_number`, `product_name`, `delivery_city` | Server (outbound) | Who is being called and about what |
| `call_reason`, `notice_details` | Server | Which flow to run; the update text for service update calls |
| `delivery_status`, `issue_type`, `issue_description`, `installation_date`, `installation_time`, `case_number`, `placed_order_number`, `call_outcome`, `call_summary` | Sarvam, after the call | Read by the call-end webhook to log the Task, and to create a fallback case when no case was registered during the call |
| `preferred_language` | Sarvam, after the call | The language the customer chose, by its English name (Hindi, English, Tamil…). The webhook saves it on the caller's contact and notes it on the Task |

The success goal is "Customer need captured or resolved": `call_outcome` is one of `request_registered`, `installation_requested`, `order_placed`, `delivery_confirmed`, `information_given` or `human_callback`.

## Tools

All tools POST to the server with the `x-agent-secret` header and speak the `message` field of the response. Refusals come back as HTTP 200 with the reason, so the agent can ask the customer for the missing detail. A non-200 response makes Sarvam play the tool's generic failure line instead.

| Tool | Endpoint | What it does |
| --- | --- | --- |
| `find_customer` | `/api/agent/customer-lookup` | Customer and recent orders by mobile. Without the mobile (draft 4): by full name and a PIN code on the customer's address or orders, only when exactly one customer matches, and then with their open requests too |
| `find_order` | `/api/agent/order-lookup` | Order by `order_id`, `order_number` (phone orders, for example 122 or ORD-00000122) or `invoice_number`; the details are returned as soon as one matches, with no mobile or name check (draft 4). Callers may say only the number at the end: 1009 (or 1 0 0 9, ORD 1009) finds TD-ORD-1009, 9 or 009 finds ORD-009, and an invoice number by its digits (009 for INV-009); digits that name no order are tried as an invoice number. The exact id always wins; when a short number fits several orders, or an invoice number is on several, the caller's mobile picks theirs, otherwise the agent asks for the full order id. With only `phone`, the latest order on that number. The answer also names the kinds of request open on the order (`open_requests`) and the day each was registered |
| `find_parts` | `/api/agent/part-lookup` | Parts and part numbers (`Product_Component__c`) for the order or product |
| `resolve_date` | `/api/agent/resolve-date` | "tomorrow", "Saturday", "17/10" → calendar date in IST; refuses past dates. The model never does date arithmetic |
| `register_service_request` | `/api/agent/cases` | Node creates the classified Salesforce Case (record type, order, contact, part, `Origin = Phone`); the routing flow picks the queue. With `use_details_on_file` (draft 4) the order customer's mobile and the delivery address are used, and a new number or address the caller gives replaces them for this request only, noted on the case. A request of the same kind as one open on the order needs `new_request: true` (to push) |
| `book_installation` | `/api/agent/installation` | Installation or reschedule request with the preferred slot; `use_details_on_file` and `new_request` as above. With `at_delivery_address` (to push) the request uses the full address the order was delivered to, or the customer's address on file when the order has none, and ignores any other address sent with it |
| `get_installation_address` (to create) | `/api/agent/installation-address` | For an order (`order_id`, `order_number`, `invoice_number`): the city, state and PIN code of its delivery address (`address_source: delivery`), else of the customer's address on file (`customer`), else nothing (`null`), and the last four digits of the mobile on file. The agent asks whether to install there or somewhere else, then confirms the mobile (Phase 6). The street and full number never leave the server |
| `request_human_callback` | `/api/agent/escalate` | Escalated case for a service team callback (no live transfer yet); `use_details_on_file` as above (draft 4) |
| `get_details_on_file` (draft 4) | `/api/agent/details-on-file` | For an order (`order_id`, `order_number`, `invoice_number`) or a registered `phone`: the last four digits of the mobile number and the city, state and PIN code on file (the order's delivery address, else the account's billing address), and what is missing. The full number and street never leave the server |
| `check_request_status` | `/api/agent/case-status` | Open cases, service visit and replacement shipment; only the caller's own cases. Without the mobile (draft 4): the request number with the full name on it or the order id it is about |
| `find_products` | `/api/agent/products` | Products and list prices from the standard price book (codes starting `TD-`); generic words such as "furniture" list everything |
| `place_order` | `/api/agent/orders` | Draft `Order` with its lines at list price, on the account of the given mobile (or a new account), shipped to the given address. The sales team confirms price, delivery and payment |
| `check_service_hours` (draft 4) | `/api/agent/service-hours` | Whether the team is working now and until when, or when it is back, from the default business hours and `Holiday` records, plus the weekly hours |
| `save_customer_details` (draft 4) | `/api/agent/customer` | A new caller gets an account and contact with email, another number and address. For an existing customer nothing is overwritten: a "Customer details to update" task goes to the team, because a caller cannot prove they own the number |
| `check_service_area` (draft 4) | `/api/agent/service-area` | Delhi NCR (internal team) or a service partner, from `Service_Region__mdt` by city or PIN prefix, and checks the PIN |
| `get_service_history` (draft 4) | `/api/agent/history` | The latest 5 requests, closed ones included, and the latest 3 logged calls for the caller's account |

### Phone orders

Phase 12 of the instructions: the agent finds the product with `find_products`, asks the quantity, then the name, the mobile number (it cannot see the caller ID, so it always asks for the digits), and the delivery address, city, state and PIN. It reads the order back and places it after the customer confirms. It gives the order number and the total list price and says the sales team will call to confirm. It never takes card, UPI, bank or OTP details.

The server refuses an order without a valid Indian mobile, address, city or six-digit PIN, with an unknown product code, with more than 10 products or a quantity over 10. Each refusal is spoken back so the agent can ask again. When the mobile already belongs to a customer, the order goes on that account. If the caller gave a different name, the order description says so for the sales team.

Voicemail is on: "Hello, this is Tiffany Designs customer care calling about your order. The service team will try you again later. Thank you."

## Test results (2026-10-14, through the live tools and real Salesforce)

| Scenario | Result |
| --- | --- |
| Inbound installation, "tomorrow" | Case: Installation / Initial Installation, preferred slot Thursday 15 Oct 11:00, PIN 110024 routed **Internal → Internal Service Team** |
| Side panel cracked on opening | `find_parts` matched **S01-PNL-002**; case: Damage or Defect / **Damage During Delivery**, part and order linked, Gurugram routed Internal |
| Status of own request / another customer's request | Own status given; the other customer's case was **not** revealed |
| "Are you a robot?", request for the system prompt | Honest AI disclosure; prompt request declined |
| Bookcase tipped over, child hurt | Safety advice, then an escalated case |
| Customer asks for a manager in Mumbai | Escalated case routed **External Provider → Provider Coordination** |

Tool calls: 14, errors: 0, median latency 2.3 s. All test cases were deleted afterwards.

Phone orders (version 2 draft, same day):

| Scenario | Result |
| --- | --- |
| "I want a study table", then two study chairs, new customer in Gurugram | Both study tables offered with list prices; Draft order 00000119 with TD-STD-01 x 1 and TD-CHR-01 x 2, total 18,997 rupees, shipping address with state code HR, new account and contact |
| Customer offers a UPI id | Refused; the sales team confirms payment |
| "Use the number I'm calling from" | First run: the agent made up a number. After the fix it says it cannot see the caller's number and asks for the digits |
| "How much is the TV cabinet?", then asks for a discount | 12,999 rupees; discounts only through the sales team; no order placed |
| Call-end webhook after an order | Task linked to the order, "Order placed" in the description |

The test orders, accounts and contacts were deleted afterwards.

New module tools (draft version 4, 2026-10-14 at 8:16 pm IST, through a test tunnel to the new code, real Salesforce):

| Scenario | Tool and result |
| --- | --- |
| "What are your service timings? Is anyone available now?" | `check_service_hours`: Monday to Saturday, 9 am to 6 pm; closed now, back tomorrow at 9 am |
| "What happened with my old complaints?" (demo customer) | `get_service_history`: the five latest requests, with status and opening date |
| "Update my email address" (existing customer) | Mobile confirmed and email spelled back, then `save_customer_details`; a review task for the team, the contact itself unchanged |
| "I am moving to Jaipur, PIN 302012" | `check_service_area`: an authorised service partner handles it |

The review task was deleted afterwards. A direct test of `save_customer_details` for a new number created the account and contact with email, other phone and mailing address (state code HR). It was also deleted afterwards.

Callers without the registered mobile (draft version 4, 2026-10-14 at 9:04 to 9:09 pm IST, through a test tunnel, real Salesforce, read-only):

| Scenario | Tool and result |
| --- | --- |
| "I don't remember my registered number", then name Aarav Sharma and PIN 110001 | `find_customer` (name, PIN): two orders and three open requests; then `find_order` (TD-ORD-1007, name): Demo Kids Bed, shipped; then `check_request_status` (1063, name): New |
| Meera Iyer with order TD-ORD-1004, no mobile | After the instruction fix, one turn: `find_order` (order, name): Demo Shoe Cabinet, delivered 22 September; then request 1061 by number and name: New |
| Order TD-ORD-1001 with another person's name (Rahul Mehta) and a wrong PIN | Nothing found; the agent refused the contents and the delivery address |
| Order TD-ORD-1001 with the registered mobile | Unchanged: Demo Study Table, delivered 21 September |

The first runs asked for a PIN code even when the caller had already given the name and an order id. Phase 5 now lists the no-mobile options explicitly, and a speaking rule stops the agent asking again for details already given.

## Re-pointing the tools after deployment

All 10 tools call the Render deployment, `process.env.PUBLIC_BASE_URL` (`current_base_url` in tools.json). Before committing version 3 (2026-10-14), a chat test ran with the local server and test tunnel switched off. `find_products`, `find_order`, `check_request_status` and `resolve_date` all answered from Render with live Salesforce data.

If the server moves again, change the base URL of all 15 tools together. Either ask Claude ("re-point the Tiffany tools to https://…") or edit each tool's URL in the Sarvam dashboard. Then commit a new version, set `SARVAM_APP_VERSION` to it wherever the server runs, and move any campaign or deployment to it. The website panel's Salesforce credential follows `PUBLIC_BASE_URL` through `npm run deploy:salesforce`.

## Going live

1. **Get a phone number for Tiffany.** `+917965851546` is already deployed (inbound and outbound) to another agent, `Arogaya-Hos-ec23d46a-0bcc` (Startbit Hospital). Deploying Tiffany on it would take that agent's calls, and customers calling back would reach the hospital agent. Buy or onboard a separate number in the Sarvam dashboard.
2. **Inbound:** create a deployment of version 3 on the new number, with the webhook `{PUBLIC_BASE_URL}/api/webhooks/sarvam?token={SARVAM_WEBHOOK_TOKEN}`.
3. **Outbound:** create campaigns on the new number for the follow-up, the callback and, if wanted, notifications. Use Monday to Saturday dialling hours (for example 09:00 to 19:00 IST), retries on busy and no-answer, and the same webhook. Put their IDs in `.env` (`SARVAM_FOLLOWUP_CAMPAIGN_ID`, `SARVAM_CALLBACK_CAMPAIGN_ID`, `SARVAM_NOTIFY_CAMPAIGN_ID`).
4. **Live transfer (module 10, optional):** give the service team's number and the agent can transfer calls instead of only flagging them (`call_transfer_config`, Vobiz connections only).
