# aos connect

A multi-user version of the aos core that anyone adds to the AI assistant they already use (Claude, ChatGPT, any MCP client) by pasting one link. Nothing to install, works on Mac, Windows, Linux and phones.

It is a separate app from `control/` (Ayush's personal aos) with its **own database**. The two share no data and no code at runtime.

```
person's assistant (Claude / ChatGPT)
   │  1. add connector: https://<app>/api/mcp
   │  2. 401 + link to /.well-known/oauth-protected-resource
   ▼
Supabase Auth (OAuth 2.1 server, sign-in with Google)
   │  3. person signs in, sees /oauth/consent, presses Allow
   ▼
/api/mcp  ── every tool call runs with that person's own token ──►  Postgres (row level security)
/app      ── the person's page: approve or reject drafts, goals, today, connected apps
```

## What a connected assistant can do

16 tools: `agenda`, `task_list`, `task_add`, `task_update`, `task_done`, `task_delete`, `approval_request`, `approval_list`, `approval_mark_sent`, `activity_log`, `activity_recent`, `goal_set`, `goal_list`, `goal_progress`, `event_add`, `settings`.

There is **no tool to approve a draft**. The assistant writes the text with `approval_request`; the person presses yes or no on `/app`; the assistant then sends the approved text and calls `approval_mark_sent`.

## Where the rules live

Every user, and every app they connect, holds a real Supabase token and could call the database API directly. So the rules are in the database (`supabase/migrations/`), not only in this app:

| Rule | How |
|---|---|
| A user reads and writes only their own rows | Row level security on every table, `user_id = auth.uid()` |
| A row cannot point at another user's task or goal | Composite foreign keys `(user_id, id)` |
| An assistant can never approve its own draft | Trigger `guard_approval`: tokens with a `client_id` claim (issued to an app) are refused |
| An approved text cannot be changed, and only an approved draft can be marked sent | Same trigger |
| Nothing is hard-deleted | No delete policy, delete privilege revoked; `deleted_at` only |
| One user cannot fill the database | Row quotas per table, size checks on every text column |
| Rate limit (120 tool calls a minute per user) | `hit_rate()`; users cannot read or reset the counter |

The app has no service-role key at all. The MCP endpoint accepts only tokens issued to a connected app; the person's own website session never passes through an assistant.

## Tests

`bun test` (45 tests):

- `tests/db.test.ts` runs the real migration on an in-process Postgres (PGlite) and attacks it as a second user and as a connected app. It also checks that every column and database function the code names exists in the schema.
- `tests/lib.test.ts` covers time zones (including daylight-saving days), repeating tasks, the agenda, goal pace, the redirect guard and the tool wrapper.

Checked by hand on a local build with placeholder settings: the landing page, the OAuth metadata document, `401` with the discovery header for no token, a garbage token and a forged unsigned token, and the redirects to sign-in.

**Not tested yet:** a real Google sign-in, tool calls through Supabase's REST API, and connecting from Claude and ChatGPT (see "Live" below).

## Live

- **App:** https://aos-connect.vercel.app (Vercel project `aos-connect`, deployed from this folder with `vercel deploy --prod`).
- **Connector link:** `https://aos-connect.vercel.app/api/mcp`
- **Database and sign-in:** Supabase project `aos-connect` (ref `peruwdunukezbyojebvb`, Mumbai). Separate from `aos-control`.

How it was set up (10 Nov 2026), so it can be repeated:

1. `supabase projects create aos-connect --region ap-south-1`, then `supabase link` and `supabase db push`. The database password is in `.env.supabase.local` (git-ignored, never uploaded: see `.vercelignore`).
2. Sign-in settings live in `supabase/config.toml` and are applied with `npx supabase@3.1.0 config push` (the 2.x CLI cannot push the OAuth server settings). They turn on the OAuth server (consent page `/oauth/consent`, dynamic client registration), turn off email sign-up, and allow the redirects `https://aos-connect.vercel.app/auth/callback` and `http://localhost:3000/auth/callback`.
3. Google sign-in: a Google Cloud OAuth client (type Web) with the redirect `https://peruwdunukezbyojebvb.supabase.co/auth/v1/callback`, entered in Supabase → Authentication → Sign In / Providers → Google. Basic scopes only, so no Google review.
4. Token signing uses the project's default asymmetric key (ES256), so tokens are checked without a network call.
5. Vercel variables (production): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL=https://aos-connect.vercel.app`.

Checked live: the landing page, `401` with the discovery header, the protected-resource document, a fake token refused, `/app` redirecting to sign-in, and a full app registration → authorize → consent page → sign-in redirect. Row level security, the no-delete rule and the approval guard were re-checked on the live database inside a rolled-back transaction.

**Still to try by a person:** sign in with Google, add the connector link in Claude (Settings → Connectors → Add custom connector), press Allow, and ask "what is on my aos agenda today?".

## Run locally

`cp .env.example .env.local`, fill it in, then `npm run dev`. `npm run build` works without the variables; requests then answer that the server is not configured.

## Not in this first cut

- Email sign-in (Google only for now).
- Any always-on runner: the assistant acts only while the person is talking to it. Hosted automations are step 2.
- A limit on how many messages one recipient gets (the personal aos has this; port it with the first hosted automation).
