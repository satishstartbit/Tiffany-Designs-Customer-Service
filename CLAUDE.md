# Tiffany Designs Customer Service

## Sarvam voice agent

The Sarvam MCP server has access to the whole workspace, but this project owns exactly one agent:

- Agent ID: `Tiffany-Des-0db8e21d-e099` (also `SARVAM_AGENT_ID` in `.env`)
- Editor: https://indus.sarvam.ai/samvaad/build/update-agent/Tiffany-Des-0db8e21d-e099

Only read or change that agent. Never create, clone, edit, commit, or delete any other agent. Knowledge bases, secrets, campaigns, and telephony are shared across the workspace, so confirm with the user before changing them.

`.claude/hooks/sarvam-agent-guard.js` enforces this: it blocks Sarvam MCP writes that target a different agent ID and asks before workspace-level changes.

`sarvam/agent-prompt.md` is the source of the agent's instructions and `sarvam/tools.json` lists its tool IDs and endpoints; keep both in step with what is pushed to Sarvam. The workspace number `+917965851546` belongs to another agent's deployment, so never deploy or campaign Tiffany on it; `SARVAM_AGENT_PHONE` uses it only as a caller ID for test calls until Tiffany has its own number.

## Salesforce

`salesforce/force-app` holds what this project deploys to the org (the website "call me" panel, its Apex, the `Tiffany_Voice_API` credential and permission set); deploy with `npm run deploy:salesforce`, which validates and runs the Apex tests. The `Tiffany_Agent_API` credential, `AgentChatController` and `tiffanyChat` belong to the site's Agentforce chat: never change them.

The Node server owns its intake logic (order verification, case creation, business hours in `src/crm/`) and talks to Salesforce only through the standard REST data API; it must not call Apex. The site chat still uses the org's Apex intake (`ServiceIntakeService`), so when the verification or case rules change in one, mirror them in the other. The Experience site is public (guest user), so anything exposed to it needs server-side limits.

Write agent instructions in the voice Sarvam's playbook requires (third person, no quotes, `call tool:name`), and never let the model do date arithmetic: dates go through `resolve_date`.
