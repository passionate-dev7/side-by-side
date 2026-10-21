# Friction log: Side by Side (Alexa+ track, AWS Builder mini challenge)

Eight entries from building an Alexa+ MCP add-on, a client for it, and an Amazon Bedrock tool-calling loop between 2026-10-20 and 2026-10-21. Every entry happened in this repo's history; each names where it is recorded.

## 1. Alexa+ developer tooling cannot be reached by hackathon participants

- Task: test the add-on against the real Alexa+ client and the web simulator before submitting.
- Steps: read the Devpost FAQ and the Alexa+ for Builders page, then the CLI setup page.
- Expected: apply for the Category SDK, MCP Toolkit, CLI and Web Simulator from the hackathon page and run `alexa-ai deploy` and `alexa-ai test`.
- Actual: the FAQ says these are "in preview and available to select partners only - there is currently no way for hackathon participants to apply". The CLI setup assumes an AWS account allowlisted by an Alexa Solutions Architect (it assumes role `arn:aws:iam::372468808636:role/AddOn3PDeveloperToolsRead`).
- Severity: High. The track asks for an Alexa+ integration and withholds the only harness that exercises one.
- Workaround: built a client that behaves as the docs describe (MCP client, MCP Apps AppBridge, 768x480 canvas, elicitation forms, voice, an LLM tool-choosing loop) in `sim/`, and a wire panel that prints the MCP handshake and the latency of every call against the 500 ms budget.
- Suggestion: ship the Local Inspector (`addon-local-inspector`, the thing that writes `certification-verdict.json`) as a public npm package, with no allowlist. It needs no Alexa account to be useful.
- Source: `docs/research/platform.md` section 3.

## 2. The docs and the real `initialize` disagree on the MCP protocol version

- Task: pick which protocol version the server must speak.
- Steps: read the add-on overview, then the client-lifecycle page.
- Expected: one version.
- Actual: the overview says Alexa+ supports 2025-11-25, which is also the hackathon minimum. The lifecycle page shows Alexa's own `initialize` request carrying `protocolVersion: "2025-03-26"`, `clientInfo.name: "Alexa+ MCP Client"` and `capabilities.roots.listChanged: true`.
- Severity: Medium. A server that answers only 2025-11-25 to that request can be rejected by the spec's own version negotiation.
- Workaround: the server accepts both and echoes the client's version when it supports it. `server/test/mcp.test.ts` runs `initialize` with each and asserts the echo, then asserts a client that asks for an unknown version gets 2025-11-25.
- Suggestion: state in one sentence which version Alexa+ sends today and which it will send after the planned upgrade, so authors do not have to infer it from a payload example.
- Source: `docs/research/platform.md` conflict 7.1; `server/test/mcp.test.ts`.

## 3. Session semantics are not MCP sessions

- Task: decide where to keep the family and the booking between turns and between days.
- Steps: read the client-lifecycle page.
- Expected: an `Mcp-Session-Id` the server can key state on.
- Actual: the page says context is rebuilt from the customer's earlier Alexa conversations, not from an MCP session id. A server cannot assume a session header arrives on every call.
- Severity: Medium.
- Workaround: `save_family` writes the family to the server's own store and every other tool reads it from there. The server also serves a request that has no session and no `initialize` (`serves a request with no session and no initialize (Alexa+ style) statelessly` in `server/test/mcp.test.ts`).
- Suggestion: document the identity a server can rely on across turns (a stable user or household id in `_meta`), because "state across sessions" is a stated judging item and there is no named key to hang it on.
- Source: `docs/research/platform.md` section 3; `server/test/mcp.test.ts`.

## 4. Anthropic models are refused for the account on Bedrock

- Task: use a Claude model on Bedrock as the tool-choosing model in the Echo Show client (Converse API, default id `us.anthropic.claude-haiku-4-5-20251001-v1:0`), and in a sibling entry as a judge (`anthropic.claude-3-haiku-20240307-v1:0`).
- Steps: call Converse from `@aws-sdk/client-bedrock-runtime` in `us-east-1` with the account's credentials.
- Expected: the Anthropic model answers.
- Actual: every Anthropic model id we tried was refused for the account. The sibling entry's probe through the real SDK returned `ResourceNotFoundException`, and the Ring entry's ledger records the same refusal of Anthropic models for these credentials.
- Severity: High for an AWS Builder entry. The most common Bedrock model family is the one that is unavailable, and the error does not say how to enable it.
- Workaround: switched the default to the mantle endpoint with `openai.gpt-oss-120b` (entry 6). The Converse provider stays in `sim/server/llm.ts` for accounts that have an Anthropic model.
- Suggestion: have the error name the missing step (model access request, use-case form, or regional availability) and link to it, and add a `list-usable-models` call that returns only what the calling identity can invoke.
- Source: `ring/.progress/LEDGER.md` (Bedrock section) and `bee/.progress/LEDGER.md` (judge probe), same account.

## 5. Nova returns "Operation not allowed" on bedrock-runtime while the mantle endpoint works

- Task: call `amazon.nova-lite-v1:0` through Bedrock for a cheaper tool-choosing model.
- Steps: Converse request on `bedrock-runtime` with the same bearer token that works on `bedrock-mantle.us-east-1.api.aws/v1`.
- Expected: Nova answers, or a 403 that names a missing permission.
- Actual: HTTP 400 `Operation not allowed`. The same token and region answered chat-completions requests on the mantle endpoint for `openai.gpt-oss-120b` and `qwen.qwen3-vl-235b-a22b-instruct`.
- Severity: High. Two endpoints on one service accept one credential differently, and the 400 message does not say which side of the difference the caller is on.
- Workaround: all live Bedrock calls go through mantle. `sim/scripts/mantle-turn.ts` is the runnable proof.
- Suggestion: say in the error which entitlement is missing, and publish a table of which model ids are served on bedrock-runtime and which on bedrock-mantle.
- Source: `ring/.progress/LEDGER.md` ("Nova on bedrock-runtime Converse returns 400 Operation not allowed").

## 6. gpt-oss-120b writes markdown into a voice reply after being told not to

- Task: have the model answer in short plain sentences that Alexa will speak.
- Steps: system prompt says "Speak in short plain sentences, no markdown." Run `npx tsx sim/scripts/mantle-turn.ts`.
- Expected: plain sentences.
- Actual: the final reply of the full turn contains bold markers and a per-offer list (`**JetBlue (offer off_jetblue)** - total $812.`), which a speech engine reads aloud as symbols.
- Severity: Medium for voice products.
- Workaround: strip markdown in code before any reply is captioned, spoken or stored in history (`sim/src/speakable.ts`, 14 tests in `sim/test/speakable.test.ts`). Tool selection is unaffected: the same run called `save_family` then `find_family_flights` with valid arguments.
- Suggestion: document a response-format switch for chat completions on mantle that forbids markdown, or a documented prompt pattern that holds for this model.
- Source: commit `2aa1c63`; `sim/scripts/mantle-turn.ts` output.

## 7. "Agent Skill" means three different things in the track material

- Task: decide what to ship for "a working Agent Skill or a self-hosted MCP server".
- Steps: read the rules, the Resources page, and the add-on docs.
- Expected: one definition.
- Actual: Resources links "Build with Agent Skills" to the MCP Apps repo's scaffolding skills. The add-on docs call the onboarding helper "the Add-on Agent Skill". Other tracks use "Agent Skill" for a SKILL.md that teaches an agent to drive a CLI.
- Severity: Low to Medium. The choice changes what a judge looks for.
- Workaround: ship both: the MCP server and `skills/side-by-side/SKILL.md`, whose frontmatter, rules and tool routing match the server's six tools.
- Suggestion: one sentence on the track page naming the artifact a submission must contain.
- Source: `docs/research/platform.md` conflict 7.1 list, item 1.

## 8. The Duffel SDK exposes seat maps by offer id only

- Task: after booking, find seats to put a child back beside an adult once the airline has moved her.
- Steps: read `@duffel/api` for a post-booking seat call.
- Expected: seat map by order, or a seat-service purchase on an existing order.
- Actual: the SDK exposes seat maps by offer id, and seat services are attached at order creation. Against a booked order the offer's seat map may no longer answer.
- Severity: Medium for any product that manages seats after purchase.
- Workaround: `still_together` computes the proposal from the booked offer's seat map and, when it does not answer, names the traveler and the seats to ask the airline for (`server/src/service.ts`, covered by `server/test/e2e.test.ts`).
- Suggestion: a seat map endpoint keyed by order id, and a way to add a seat service to a paid order.
- Source: `alexa/.progress/LEDGER.md` data truth section.
