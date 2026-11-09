# Social Planner MCP server

The planner exposes every planning, approval and publishing action as MCP tools, so **Hermes** (planning agent) and **inqi** (client portal) work with the same data, rules and audit trail as the web UI.

| | |
|---|---|
| Endpoint | `https://social-planner-nine.vercel.app/api/mcp` |
| Transport | MCP Streamable HTTP, **stateless** (each JSON-RPC request is a `POST`; no session, `GET` returns 405) |
| Auth | `Authorization: Bearer <api_key>` on every request |
| REST mirror | `GET /api/v1/tools`, `POST /api/v1/tools/{tool_name}` with the tool arguments as the JSON body |

## API keys and scopes

Keys look like `sp_live_<12 hex>_<secret>`. Only a hash is stored; a key is shown once when created or rotated (`pnpm db:seed --rotate` for the seeded clients; the Settings page from phase 4).

| Scope | Allows |
|---|---|
| `posts:read` | list/get posts, calendars, free slots, resources |
| `posts:write` | create, edit, media, comment, submit, schedule, reschedule, cancel, calendars |
| `posts:approve` | approve, reject, comment (with `actingUser`) |
| `posts:publish` | `publish_now`, `retry_failed_post` |
| `brands:read` | list/get brands, brand status, guidelines resource |
| `brands:write` | `update_brand_guidelines` |
| `insights:read` | post and brand insights |

Keys are also limited to a set of brands (or all). A brand outside the key's list behaves as if it doesn't exist (`not_found`).

| Client | Scopes | Brands |
|---|---|---|
| `hermes` | all | all |
| `inqi` | `posts:read`, `posts:approve`, `brands:read`, `insights:read` | per brand (seeded: `uppal-nq1`) |

## Conventions

- **Brands** are referenced by id or slug: `"brand": "uppal-nq1"`.
- **Times** are ISO-8601 **with an offset**: `2026-11-12T17:00:00+05:00`. Stored in UTC; responses include `scheduledAt` (UTC) and `scheduledAtLocal` (brand timezone). Each brand's timezone is in `get_brand`.
- **Optimistic concurrency**: every post has a `version`. `update_post` requires it; other mutations accept it. A stale version returns `version_conflict`.
- **Statuses**: `idea → draft → awaiting_approval → approved → scheduled → publishing → published`, plus `rejected`, `failed`, `cancelled`. Only the publisher sets `publishing/published/failed`. Editing caption/media of an approved or scheduled post sends it back to `awaiting_approval` when the brand requires approval.
- **Source badge**: posts created with the `hermes` key show `source: "hermes"`, with `inqi` `"inqi"`.
- **Media**: pass public URLs. The server copies them into storage; images are converted to sRGB JPEG ≤1440 px wide (Instagram accepts only JPEG). Reels: MP4/MOV, 3 s – 15 min, ≤300 MB. Carousels: 2–20 items. Private/internal addresses are refused.
- **Instagram limits** checked before scheduling: caption + hashtags ≤ 2,200 chars, ≤ 30 hashtags, ≤ 20 @mentions, image aspect 4:5 to 1.91:1, ≤ 8 MB. `create_post` / `submit_for_approval` return `warnings`; `get_post` returns `publishReadiness`.

### Errors

Tool errors come back as an MCP result with `isError: true` and this JSON text (REST returns the same body with an HTTP status):

```json
{ "error": { "code": "validation_error", "message": "Invalid input: scheduledAt: ISO-8601 datetime with offset, e.g. 2026-11-10T17:00:00+05:00",
  "details": [{ "field": "scheduledAt", "message": "ISO-8601 datetime with offset, e.g. 2026-11-10T17:00:00+05:00" }] } }
```

| code | meaning / what to do |
|---|---|
| `validation_error` (400) | fix the fields named in `details` |
| `media_invalid` (422) | Instagram would reject the post; `details` lists every problem |
| `forbidden` (403) | the key lacks the scope named in `message` |
| `not_found` (404) | wrong id/slug, or outside the key's brands |
| `invalid_transition` (409) | the post isn't in a state that allows this; `hint` says what to call first |
| `version_conflict` (409) | re-read with `get_post`, re-apply |
| `no_free_slot` (409) | brand has no posting slots / none free; pass `scheduledAt` |
| `unauthorized` (401) | missing or invalid key |

## Tools (29)

**Brands:** `list_brands`, `get_brand {brand}`, `update_brand_guidelines {brand, guidelines, mode?, postingSlots?}`, `get_brand_status {brand}`

**Posts:** `list_posts {brand?, calendarId?, status?, type?, source?, pillar?, from?, to?, limit?, cursor?}`, `get_post {postId}`, `create_post {brand, type, caption?, hashtags?, firstComment?, pillar?, notes?, isAiGenerated?, status?, scheduledAt?, calendarIds?, media?}`, `update_post {postId, version, …}`, `add_media {postId, url, altText?, position?}`, `remove_media {postId, mediaId}`, `reorder_media {postId, mediaIds}`, `add_comment {postId, comment, actingUser?}`, `submit_for_approval {postId}`, `approve_post {postId, comment?, actingUser?}`, `reject_post {postId, comment, actingUser?}`, `schedule_post {postId, scheduledAt | nextFreeSlot: true}`, `reschedule_post {postId, scheduledAt | nextFreeSlot: true}`, `cancel_post {postId, comment?}`, `publish_now {postId}`, `retry_failed_post {postId, scheduledAt?}`

**Planning:** `list_calendars {brand?}`, `create_calendar {brand, name, color?, startsOn?, endsOn?}`, `add_post_to_calendar {calendarId, postId}`, `remove_post_from_calendar {calendarId, postId}`, `get_calendar {brand | calendarId, from, to}`, `get_free_slots {brand, from?, to?, limit?}`, `bulk_create_posts {posts: [create_post args…]}` (atomic, max 50)

**Insights:** `get_post_insights {postId}`, `get_brand_insights {brand, from?, to?, top?}`

`tools/list` returns the full JSON Schema of every tool, with field descriptions.

## Resources

| URI | Content |
|---|---|
| `brand://{slug}/guidelines` | voice, pillars, palette, fonts, do/don't, hashtag sets, CTA, posting slots, timezone |
| `brand://{slug}/calendar/{yyyy-mm}` | posts of that month grouped by day in the brand timezone (incl. published/imported) |

`resources/list` returns each accessible brand's guidelines and current month.

## Example: plan → approve → schedule

```jsonc
// Hermes
{"method":"tools/call","params":{"name":"get_brand","arguments":{"brand":"uppal-nq1"}}}
{"method":"tools/call","params":{"name":"create_post","arguments":{
  "brand":"uppal-nq1","type":"image","isAiGenerated":true,"pillar":"Trade snapshots",
  "caption":"Waited for the retest. One clean NQ1 trade, then done.",
  "hashtags":["#NQ1","#DayTrading"],
  "media":[{"url":"https://files.example.com/nq1-2026-11-12.png","altText":"NQ1 5-minute chart, entry marked"}]}}}
// → {"id":"…","status":"draft","version":1,"warnings":[]}
{"method":"tools/call","params":{"name":"submit_for_approval","arguments":{"postId":"…"}}}

// inqi (client approves in the portal)
{"method":"tools/call","params":{"name":"approve_post","arguments":{"postId":"…","comment":"Looks good","actingUser":{"id":"inqi-user-42","name":"Sara"}}}}

// Hermes
{"method":"tools/call","params":{"name":"schedule_post","arguments":{"postId":"…","nextFreeSlot":true}}}
// → {"status":"scheduled","scheduledAt":"2026-11-12T12:00:00.000Z","scheduledAtLocal":"2026-11-12T17:00:00+05:00"}
```

Testing with curl (stateless server, so a single POST works):

```bash
curl -s https://social-planner-nine.vercel.app/api/mcp \
  -H "Authorization: Bearer $PLANNER_HERMES_KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_free_slots","arguments":{"brand":"uppal-nq1","limit":3}}}'

# REST mirror
curl -s https://social-planner-nine.vercel.app/api/v1/tools/get_brand_status \
  -H "Authorization: Bearer $PLANNER_HERMES_KEY" -d '{"brand":"uppal-nq1"}'
```

## Client configuration

### Hermes Agent (`~/.hermes/config.yaml`)

Hermes uses HTTP transport when an entry has a `url`. Keep the key in Hermes's secret scope or environment, not in the file.

```yaml
mcp_servers:
  planner:
    url: "https://social-planner-nine.vercel.app/api/mcp"
    headers:
      Authorization: "Bearer ${env:PLANNER_HERMES_KEY}"
    timeout: 120          # publish_now can wait on Instagram
    connect_timeout: 30
```

Then run `/reload-mcp` in a Hermes chat. Reference: [Hermes MCP config](https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference).

### inqi (TypeScript, official SDK)

inqi authenticates its own users and calls the planner with the `inqi` key, passing the portal user as `actingUser` on approve/reject/comment so the planner's audit log names them. To link that person to a planner account, set their **inqi user id** on the planner's Team page.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const planner = new Client({ name: "inqi", version: "1.0.0" });
await planner.connect(
  new StreamableHTTPClientTransport(new URL("https://social-planner-nine.vercel.app/api/mcp"), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.PLANNER_INQI_KEY}` } },
  }),
);

const res = await planner.callTool({
  name: "approve_post",
  arguments: { postId, comment, actingUser: { id: session.user.id, name: session.user.name } },
});
const body = JSON.parse((res.content as { text: string }[])[0].text);
if (res.isError) throw new Error(`${body.error.code}: ${body.error.message}`);
```

Useful inqi calls: `get_calendar` or `brand://{slug}/calendar/{yyyy-mm}` for the client calendar, `list_posts {status:["awaiting_approval"]}` for the approval queue, `approve_post` / `reject_post` / `add_comment`, `get_brand_insights` for performance.

### Any MCP client with a JSON config (Claude Desktop, Cursor, VS Code…)

```json
{
  "mcpServers": {
    "social-planner": {
      "type": "http",
      "url": "https://social-planner-nine.vercel.app/api/mcp",
      "headers": { "Authorization": "Bearer sp_live_…" }
    }
  }
}
```

## Current limits (by phase)

- **Publishing to Instagram starts in phase 5** (Instagram login, exact-minute trigger via Upstash QStash, 5-minute safety sweep). Until a brand's Instagram account is connected, scheduled posts stay `scheduled`, and `publish_now` ends in `failed` with "No Instagram account is connected"; use `retry_failed_post` once it is.
- **Insights** return empty results until the daily collector (phase 6).
- **Webhooks** (`post.status_changed`, `post.published`, `post.failed`, `account.token_expiring`) are recorded from now on and delivered from phase 6.
- **Rate limiting** per key arrives in phase 7.
