# Connecting Instagram and turning on automatic publishing

Checked against Meta's docs on 2026-11-13 ([Business Login for Instagram](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login), [Content publishing](https://developers.facebook.com/docs/instagram-platform/content-publishing)). The planner uses **Instagram API with Instagram Login** (no Facebook Page needed), Graph API **v27.0** (`INSTAGRAM_GRAPH_VERSION`).

## 1. Make @uppal.nq1 a professional account (phone, 2 min)

Instagram app → Profile → ☰ → **Settings and privacy** → **Account type and tools** → **Switch to professional account** → pick a category → **Creator** or **Business**. Either works for publishing.

## 2. Create the Meta app (developers.facebook.com, ~10 min)

1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Use case: the Instagram API one (**Manage messaging & content on Instagram**; wording can vary). App type **Business** if asked.
3. In the app, open **Instagram** → **API setup with Instagram business login**.
4. **Business login settings → OAuth redirect URIs**, add exactly:
   `https://social-planner-nine.vercel.app/api/instagram/callback`
5. Copy the **Instagram App ID** and **Instagram App Secret** shown on that page (not the Facebook App ID/secret at the top of the dashboard).
6. **App roles → Roles → Instagram testers**: add `uppal.nq1`, then accept the invite in the Instagram app (Settings → Apps and websites → Tester invites). While the app is in development mode only tester accounts can connect.

Permissions requested: `instagram_business_basic`, `instagram_business_content_publish`, `instagram_business_manage_comments` (first comment). Client accounts that aren't testers need **App Review** (Advanced Access) and a privacy policy URL; do that once your own account works.

## 3. Upstash QStash (exact-minute triggers, ~5 min)

1. <https://console.upstash.com> → **QStash** → copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` (and `QSTASH_URL` if shown for your region).
2. Generate a `CRON_SECRET` (lets you run jobs by hand): `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

## 4. Vercel environment (Production)

Set from Git Bash with `printf %s "value" | vercel env add NAME production --force` (PowerShell pipes add a carriage return):

| Name | Value |
|---|---|
| `INSTAGRAM_CLIENT` | `real` |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | from step 2.5 |
| `INSTAGRAM_REDIRECT_URI` | `https://social-planner-nine.vercel.app/api/instagram/callback` |
| `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` (`QSTASH_URL`) | from step 3 |
| `CRON_SECRET` | from step 3.2 |

Redeploy, then create the recurring jobs once:
`QSTASH_TOKEN=... APP_URL=https://social-planner-nine.vercel.app pnpm qstash:schedules`

## 5. Connect and test

1. Brands → **Uppal NQ1** → **Connect Instagram** → log in as @uppal.nq1 → allow. You land back on the brand page with "Instagram connected" (with a warning if a different account was connected).
2. Make a test post, approve it, schedule it a few minutes ahead. It publishes at that minute (QStash), or within 5 minutes via the sweep, and the calendar shows it published with its permalink.
3. Post something in the Instagram app: within 30 minutes it appears on the calendar with the Instagram badge.
4. Manual runs: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://social-planner-nine.vercel.app/api/jobs/sweep` (also `sync`, `tokens`).

## How it behaves

- **Scheduling** sends one QStash message for the exact minute; rescheduling/cancelling replaces/cancels it. The 5-minute sweep catches anything missed (e.g. if your QStash plan's maximum delay is shorter than how far ahead you scheduled).
- **Publishing** never double-posts: container ids are stored before publishing and checked first on any retry. Reels are checked once a minute for up to 5 minutes, as Meta recommends. Failures retry after 1, 5 and 15 minutes, then the post is marked failed.
- **Tokens** last ~60 days and are refreshed daily once under 15 days remain; failures mark the brand and fire `account.token_expiring`.
- **Import** links planner posts whose Instagram id wasn't confirmed (matched by caption) and imports anything posted outside the planner as `source=instagram`. Imported thumbnails use Instagram's CDN URLs, which can expire; the permalink stays valid.
