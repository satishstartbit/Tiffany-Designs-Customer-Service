# Sarvam agent: Tiffany Designs Customer Service

Agent `Tiffany-Des-0db8e21d-e099`, committed as **version 2** (version 1 had no phone orders). The instructions are in [agent-prompt.md](agent-prompt.md), and the tool IDs and endpoints are in [tools.json](tools.json). Only this agent may be changed; the Sarvam workspace is shared with other agents.

## Call types

`call_reason` selects the flow. Outbound calls get their opening line from the server (`app_overrides.initial_bot_message`), and that line only confirms who answered.

| `call_reason` | Who starts it | Opening line |
| --- | --- | --- |
| `inbound` | Customer calls the Tiffany number | Namaste, welcome to Tiffany Designs customer care. This is the Tiffany Designs service assistant. How can I help you today? (translated into all 11 languages) |
| `delivery_followup` | Server, 1 hour after `Delivery_Status__c` becomes Delivered | Hello, this is the Tiffany Designs service assistant. Am I speaking with {name}? |
| `callback_request` | Server, when a customer leaves a number | …calling back as requested. Am I speaking with {name}? |
| `service_update` | Server, on a case event (module 13) | Same as delivery follow-up; the update text is passed in `notice_details` |

## Variables

| Variable | Set by | Purpose |
| --- | --- | --- |
| `customer_name`, `customer_phone`, `order_number`, `product_name`, `delivery_city` | Server (outbound) | Who is being called and about what |
| `call_reason`, `notice_details` | Server | Which flow to run; the update text for service update calls |
| `delivery_status`, `issue_type`, `issue_description`, `installation_date`, `installation_time`, `case_number`, `placed_order_number`, `call_outcome`, `call_summary` | Sarvam, after the call | Read by the call-end webhook to log the Task, and to create a fallback case when no case was registered during the call |

The success goal is "Customer need captured or resolved": `call_outcome` is one of `request_registered`, `installation_requested`, `order_placed`, `delivery_confirmed`, `information_given` or `human_callback`.

## Tools

All tools POST to the server with the `x-agent-secret` header and speak the `message` field of the response. Refusals come back as HTTP 200 with the reason, so the agent can ask the customer for the missing detail. A non-200 response makes Sarvam play the tool's generic failure line instead.

| Tool | Endpoint | What it does |
| --- | --- | --- |
| `find_customer` | `/api/agent/customer-lookup` | Customer and recent orders by mobile |
| `find_order` | `/api/agent/order-lookup` | Order by `TD-ORD` id or invoice number, verified in Node against the invoice number or a mobile on the order's account |
| `find_parts` | `/api/agent/part-lookup` | Parts and part numbers (`Product_Component__c`) for the order or product |
| `resolve_date` | `/api/agent/resolve-date` | "tomorrow", "Saturday", "17/10" → calendar date in IST; refuses past dates. The model never does date arithmetic |
| `register_service_request` | `/api/agent/cases` | Node creates the classified Salesforce Case (record type, order, contact, part, `Origin = Phone`); the routing flow picks the queue |
| `book_installation` | `/api/agent/installation` | Installation or reschedule request with the preferred slot |
| `request_human_callback` | `/api/agent/escalate` | Escalated case for a service team callback (no live transfer yet) |
| `check_request_status` | `/api/agent/case-status` | Open cases, service visit and replacement shipment; only the caller's own cases |
| `find_products` | `/api/agent/products` | Products and list prices from the standard price book (codes starting `TD-`); generic words such as "furniture" list everything |
| `place_order` | `/api/agent/orders` | Draft `Order` with its lines at list price, on the account of the given mobile (or a new account), shipped to the given address. The sales team confirms price, delivery and payment |

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

## Re-pointing the tools after deployment

The tools currently point to a temporary test tunnel (`current_base_url` in tools.json). That address stops working when the tunnel closes. Once the server runs at a permanent HTTPS address, change the base URL of all 10 tools: either ask Claude ("re-point the Tiffany tools to https://…"), or edit each tool's URL in the Sarvam dashboard. Then commit a new version, and move any campaign or deployment to it.

## Going live

1. **Get a phone number for Tiffany.** `+917965851546` is already deployed (inbound and outbound) to another agent, `Arogaya-Hos-ec23d46a-0bcc` (Startbit Hospital). Deploying Tiffany on it would take that agent's calls, and customers calling back would reach the hospital agent. Buy or onboard a separate number in the Sarvam dashboard.
2. **Inbound:** create a deployment of version 2 on the new number, with the webhook `{PUBLIC_BASE_URL}/api/webhooks/sarvam?token={SARVAM_WEBHOOK_TOKEN}`.
3. **Outbound:** create campaigns on the new number for the follow-up, the callback and, if wanted, notifications. Use Monday to Saturday dialling hours (for example 09:00 to 19:00 IST), retries on busy and no-answer, and the same webhook. Put their IDs in `.env` (`SARVAM_FOLLOWUP_CAMPAIGN_ID`, `SARVAM_CALLBACK_CAMPAIGN_ID`, `SARVAM_NOTIFY_CAMPAIGN_ID`).
4. **Live transfer (module 10, optional):** give the service team's number and the agent can transfer calls instead of only flagging them (`call_transfer_config`, Vobiz connections only).
