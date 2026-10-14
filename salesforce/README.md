# Salesforce: "Call me" panel for the Tiffany Designs site

A customer enters a mobile number on the site, ticks the consent box, and the Tiffany Designs voice assistant (Sarvam agent `Tiffany-Des-0db8e21d-e099`) calls that number straight away.

```
Site visitor → tiffanyVoiceCall (LWC) → TiffanyVoiceCallController (Apex)
  → Named Credential Tiffany_Voice_API (x-api-key from the external credential)
  → voice server POST /api/calls/request → Sarvam Instant Outbound → customer's phone rings
  → after the call, Sarvam's webhook → voice server → Task in Salesforce
```

## What is in the org

| Component | Purpose |
| --- | --- |
| LWC `tiffanyVoiceCall` ("Tiffany Voice Call") | The panel. Works on the Experience site, and on Lead and Contact pages (number pre-filled), app and home pages, and the utility bar |
| Apex `TiffanyVoiceCallController` (+ test, 97% coverage) | Checks consent and the number, calls the voice server, and turns its answer into a customer-friendly message |
| External Credential + Named Credential `Tiffany_Voice_API` | Server address and the `SITE_CALL_API_KEY`, which can only request calls. Separate from the chat's `Tiffany_Agent_API` |
| Permission set `Tiffany_Voice_Call_Access` | Apex and credential access. Assigned to the site guest user and the admin |

Deploy or update everything with `npm run deploy:salesforce` (add `--check-only` to validate without saving). The script also stores the key on the credential and grants the permission set.

## Put the panel on the site

1. Setup → Digital Experiences → All Sites → **TiffanyDesigns** → **Builder**.
2. Open the page that should show it, for example the service request page.
3. Open **Components** (lightning icon), find **Tiffany Voice Call** under Custom Components, and drag it onto the page.
4. Optionally change Heading, Subheading and Button label in the property panel.
5. **Publish**. The site is still "Under Construction", so it is only public after publishing.

To use it inside Salesforce, add it to a Lead or Contact page (Edit Page → drag the component → Save → Activate), or as a utility item (App Manager → edit the app → Utility Items).

## Protection, because the site is public

The panel runs for site guests, so anyone on the internet can use it. The server enforces:

- **Consent:** the box must be ticked, and the server checks the flag again.
- **Indian mobiles only.**
- **Per number:** one call every 15 minutes, at most 3 a day.
- **Overall:** `CALLBACK_MAX_PER_HOUR` (20) and `CALLBACK_MAX_PER_DAY` (100).
- **Optional:** `CALLBACK_ALLOWED_NUMBERS=registered` only calls numbers that belong to a Salesforce contact. Recommended before the site goes live.
- **Greeting name:** a guest cannot choose the name the assistant greets with.

## Changing the server address or the key

- **New server address:** set `PUBLIC_BASE_URL`, then run `npm run deploy:salesforce`. The Named Credential URL is updated.
- **New key:** change `SITE_CALL_API_KEY`, restart the server, then run `npm run deploy:salesforce`.
