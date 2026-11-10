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

18 tools: `agenda`, `task_list`, `task_add`, `task_update`, `task_done`, `task_delete`, `approval_request`, `approval_list`, `approval_send`, `approval_mark_sent`, `api_request`, `activity_log`, `activity_recent`, `goal_set`, `goal_list`, `goal_progress`, `event_add`, `settings`.

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
| An assistant cannot swap a draft's text after asking | Trigger `guard_approval`: content changes from a token with a `client_id` are refused |
| A saved login cannot be read back by anyone | `secrets.ciphertext` has no select grant; it is sealed with a key that is not in the database; only `send_claim()` (server secret key) returns it |
| Only the person can save or remove a login | `put_secret()` / `remove_secret()` refuse tokens with a `client_id`; a connected app sees no rows in `secrets` |
| An email is sent at most once, and at most 50 a day | `send_claim()` takes the draft for one sender; `send_finish()` records the outcome |
| A saved API key can only go to the host the person entered | The host is stored with the key by `put_secret()` (public DNS names only) and is never taken from an assistant; the socket refuses private addresses at connect time |
| A request that changes something runs only after the person's yes, exactly as shown | `request_action()` writes the row and its text from the same data; `guard_approval` refuses hand-written, edited or self-finished API requests |
| An assistant cannot turn a stand-in back into a value, or switch masking off | `handles` is closed to tokens with a `client_id`; `handles_resolve()` is server only; `guard_profile` refuses `mask_level` changes from an app |
| Only the person can link a phone | `create_link_code()` refuses tokens with a `client_id`; codes are one-time, 15 minutes, stored hashed |
| A phone decides only its own person's drafts | `channel_*` functions run only with the server secret key and scope every query to the linked user; 60 messages a minute |

Reads and writes of a person's data always run with that person's own token. The Supabase secret key is used through three small files, each a short list of database functions: the Telegram webhook (`lib/channel-db.ts`), sending an approved email or request (`lib/send-db.ts`), and masking plus reading a saved key (`lib/mask-db.ts`: `handles_mask`, `handles_resolve`, `api_key_read`). The MCP endpoint accepts only tokens issued to a connected app; the person's own website session never passes through an assistant.

## Tests

`bun test` (134 tests):

- `tests/db.test.ts` runs the real migration on an in-process Postgres (PGlite) and attacks it as a second user and as a connected app. It also checks that every column and database function the code names exists in the schema.
- `tests/vault.test.ts` covers sealing (wrong key, wrong owner and changed values do not open), the mail rules, a real SMTP exchange against a local server (login check, the approved text arriving word for word, header injection, a refused recipient), and the whole sealed send with its failure paths.
- `tests/privacy.test.ts` covers finding contact details (and not mistaking ids, amounts or dates for phone numbers), masking and putting values back, the privacy levels, which addresses a key may be sent to, real HTTP exchanges against a local server (key header, body word for word, no redirects followed, size cap), and a read for an assistant end to end.
- `tests/bot.test.ts` covers the Telegram bot: commands, yes/no, buttons, the webhook secret check, unlinked chats, group chats ignored, and that only our own error messages reach the chat.
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
5. Vercel variables (production): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL=https://aos-connect.vercel.app`, plus the server-only ones for the phone and the vault: `SUPABASE_SECRET_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `NEXT_PUBLIC_TELEGRAM_BOT`, `VAULT_KEY`. `VAULT_KEY` is also in `.env.local`; if it is lost, saved logins cannot be opened and people reconnect their email.

Checked live: the landing page, `401` with the discovery header, the protected-resource document, a fake token refused, `/app` redirecting to sign-in, and a full app registration → authorize → consent page → sign-in redirect. Row level security, the no-delete rule and the approval guard were re-checked on the live database inside a rolled-back transaction.

**Still to try by a person:** sign in with Google, add the connector link in Claude (Settings → Connectors → Add custom connector), press Allow, and ask "what is on my aos agenda today?".

## The vault and sealed sending

The rule: **the model works with names and drafts; the server holds the secrets and does the sending.**

- On `/app`, under **Email sending**, the person picks their mail provider and enters their address and an app password. The server checks the login with the provider, seals it (AES-256-GCM, key `VAULT_KEY` in the server environment, bound to that user) and stores only the sealed value. It is never shown again, to anyone.
- An assistant can learn one thing: that email is connected, with a hint like `a***@example.com` (`settings` tool). Its instructions tell it never to ask for a password or key in chat.
- When the person approves an email draft (on `/app` or with the Telegram button), aos sends it right away from their own mailbox, word for word, and logs it. The assistant takes no part.
- `approval_send` lets an assistant ask aos to send an email that is already approved (for example a scheduled one whose time has come). It returns one line; no login, no mail server reply.
- A draft is sent by aos only if its channel is `email`, its recipient holds exactly one address and it has a subject. Anything else stays approved for the assistant to send as before.
- If the provider refuses the login or the recipient, nothing was sent: the draft stays approved and can be sent again. If the connection breaks mid-send, the draft is marked failed and is never retried by itself.
- The mail server's address always comes from the fixed provider list in `lib/mail.ts`, never from input.

## Connected services (API keys)

- On `/app`, under **Connected services**, the person saves a key with a short name, the service address (for example `api.razorpay.com`) and how the service wants the key (Bearer, Basic, or a header of its own). It is sealed like the mail login.
- An assistant sees the names and hosts (`settings` tool) and calls `api_request` with a name and a path. It never sees the key and cannot choose the host.
- **GET runs at once.** The reply comes back with the key scrubbed out (also in encoded forms), contact details masked, compact, cut at 12,000 characters, and reduced to the `fields` asked for.
- **Anything else waits for a yes.** POST, PUT, PATCH and DELETE become an approval that shows the exact request. It runs when the person approves, on `/app` or from Telegram, and only if they ticked "allow requests that change something" for that key. The first part of the answer is stored with the approval.
- Guards: public hosts only (checked when saved, and again on the socket's own DNS lookup, so a name cannot be re-pointed at a private address), HTTPS only, redirects not followed, replies read up to 256 KB, 30 reads a minute, 200 approved requests a day, 20 keys per person.

## Masking

- An email address or phone number in a reply from a connected service reaches the assistant as a stand-in: `[EMAIL_12]`, `[PHONE_3]`. The same value always gets the same stand-in for that person, so the assistant can still follow who is who across conversations.
- When the assistant uses a stand-in (a draft's recipient, a request path or body), the server puts the real value back before it stores or sends. The person sees real values on `/app` and on their phone.
- Once a value has a stand-in, it is masked in every tool result, so it cannot be read back by saving it in a task and listing the task.
- The person chooses the level on `/app` under **Privacy**: services only (default), also their own tasks, drafts and log, or off. The same section has a "Who is this?" box that turns a stand-in back into the value, for the person only.
- If masking a service reply fails, the reply is not returned.

Limits, plainly: text the person types into their assistant's chat reaches the model before aos sees it; names in free text are not masked; a service that returns a value in a changed form (encoded, split) is not caught; phone numbers are found by pattern, so an unusual format can slip through and a ten-digit number in free text can be masked by mistake.

Not built yet: a timer that sends scheduled emails by itself, a per-recipient cap, a look-up of stand-ins from Telegram.

## Phone (Telegram)

The person presses **Connect Telegram** on `/app`, Telegram opens, they press Start, and the chat is linked. From then on:

- every draft their assistant queues arrives in that chat with **Approve** and **Reject** buttons;
- `/today` shows what is due, drafts waiting and goals; `/drafts` lists drafts with buttons; `yes 12` / `no 12` also work.

Approving on the phone only marks the draft approved. The assistant still sends it, the next time it checks its drafts.

Telegram rather than WhatsApp or Discord for the first channel: free, no business verification, works entirely by webhook on Vercel, and the bot can message anyone who pressed Start. WhatsApp (Meta verification, paid conversations) and Discord (a bot can only DM people it shares a server with) can be added behind the same `channel_*` functions.

Setup:

1. In Telegram, message @BotFather, send `/newbot`, pick a name and a username ending in `bot`.
2. Paste the token after `TELEGRAM_BOT_TOKEN=` in `.env.local` (never in a chat). `TELEGRAM_WEBHOOK_SECRET` is already there and matches Vercel.
3. `bun scripts/telegram-setup.ts https://aos-connect.vercel.app` sets the webhook and command menu and prints the bot username.
4. Add `TELEGRAM_BOT_TOKEN` and `NEXT_PUBLIC_TELEGRAM_BOT` (the username) to Vercel and redeploy. `SUPABASE_SECRET_KEY` and `TELEGRAM_WEBHOOK_SECRET` are already set.

Until the token is set, `/api/telegram` answers 503 and `/app` hides the Connect Telegram button.

**Live since 10 Nov 2026:** bot @aos_connect_bot (name "aos"), webhook `https://aos-connect.vercel.app/api/telegram` with only `message` and `callback_query` updates. Checked from Telegram: `/start` and `/today` from an unlinked chat answer with how to link (the second goes through the database with the secret key).

## Run locally

`cp .env.example .env.local`, fill it in, then `npm run dev`. `npm run build` works without the variables; requests then answer that the server is not configured.

## Not in this first cut

- Email sign-in (Google only for now).
- Any always-on runner. Approved emails go out by themselves when a mailbox is connected; everything else (other channels, scheduled emails) still waits until the person talks to their assistant.
- A limit on how many messages one recipient gets (the personal aos has this). There is a limit of 50 emails a day per person.
