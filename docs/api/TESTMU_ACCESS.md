# TestMu AI access key: mandatory auth for the API and site

Every Hack OS API call and participant page sits behind the participant's TestMu AI
access key. The switch is `TESTMU_KEY_REQUIRED`.

Interactive API docs: **`/api/docs`** · spec: **`/api/v1/openapi.json`** · endpoint list: [ENDPOINTS.md](ENDPOINTS.md)

## Activation: the profile gets the key (main path)

```
/register  (or POST /api/v1/auth/register)
  name · Luma email · LinkedIn · X · GitHub · password
        │  profile saved, account created
        ▼
  our server ──POST TESTMU_PROVISION_URL──► TestMu AI  /api/trials/hack-day/claim
        {email, password, name, linkedin, twitter: "@<x>", github,
         source: "kaneclihack.sh", page_url: "<SITE_URL>/register"}
        ◄── {code, message, user_id, username, access_token, organization_id}
        │   (TestMu creates the account, or signs the existing one in with the password)
        ▼
  testmu_links: username + member + fingerprint of the key (the key is NOT stored),
                organization_id and claim_code
  browser: hd_testmu cookie (signed, 12h) + the key shown ONCE on /register
  API caller: data.testmu = {username, access_key}, returned ONCE
```

`access_token` is the access key. From then on the key is the credential for everything:
the browser carries it as the cookie, Kane CLI / Codex / MCP send it as headers. The proxy
matches it against the stored fingerprint, so no verify call to TestMu is needed per request.

### The password

The claim needs the participant's TestMu AI password, so it is used **only in memory, for
that one request**: from the form (or the API body) straight to TestMu AI. It is never
stored, logged, audited, put in `testmu_provision_failures`, an error, a cookie or a URL.
Which password is sent: `testmu_password` when the person typed one, else the password
they chose here (`password`), else the one they proved an existing account with
(`proof_password`). TestMu AI's password rules are 8–255 characters.

Anything that has no password asks for one. Signing in on another device and opening a
gated page (`/api/v1/auth/testmu/start`) lands on `/register?testmu=failed`, whose panel
asks for the TestMu AI password and retries. A profile edit on a device that is already
activated doesn't claim again.

### Claim codes

The outcome is set by `code`, and several codes are HTTP 200.

| HTTP | `code` | What we do |
|---|---|---|
| 200 | `SIGNEDUP`, `JOINED_TEAM`, `ALREADY_CLAIMED`, `ALREADY_ACTIVE` | Activated: link the key, store `organization_id` and the code, show the key once |
| 200 | `INELIGIBLE` | Refused: TestMu's message is shown, no key |
| 401 | `INVALID_CREDENTIALS` | `wrong_password`: the email already has a TestMu AI account with another password. `/register` asks for "TestMu AI password for &lt;email&gt;" and retries with it. The password here stays the same |
| 502 | `FAILED` | Unavailable, retry |
| 422 | `INVALID_REQUEST` | Refused, with `errors` mapped to our field names (`twitter` → `x`) |
| 403 / 410 | `REGION_NOT_SUPPORTED` / `CAMPAIGN_ENDED` | Refused |
| 429 | (none) | Unavailable: "try again in about N s" from `Retry-After` (default 60 s) |
| other | anything else | Unavailable |

Failures are kept in `testmu_provision_failures` (reason `rejected`, `wrong_password` or
`unavailable`, plus the HTTP status, code and TestMu's message) for staff and for the
`/register` panel's copy. The `/activate` plan step (step 2) is recorded from this claim:
it no longer calls the claim API itself once activation succeeded.

## Team sync: one TestMu AI org per team

TestMu AI builds one org per hack-day team. Every signup gets its own org and is its Admin.
When the captain confirms the final team on `/team` (which locks our roster), the confirm
form also asks for **the captain's TestMu AI password**, used once and never stored. After
our lock commits, outside the transaction, we call TestMu once per other current member,
one at a time:

```
POST TESTMU_TEAM_INVITE_URL   /api/trials/hack-day/team/invite
  {email: <captain's email>, password: <captain's TestMu AI password>, member_email}
```

| `code` | Meaning | Next |
|---|---|---|
| `MEMBER_ADDED` | A solo participant moved into the captain's org | done |
| `MEMBER_INVITED` | Not signed up yet: joins the captain's org when they claim (`JOINED_TEAM`) | done |
| `ALREADY_IN_TEAM` | Already there | done |
| `INVALID_CREDENTIALS` | Wrong captain password | stop, retry with the password |
| `NOT_TEAM_LEAD` | The captain isn't the Admin of their own Hack Day account | stop, help desk |
| `NOT_HACK_DAY_ORG` | The teammate has a TestMu AI account but never claimed | they finish activation on `/register`, then retry |
| `MEMBER_IN_ANOTHER_TEAM` / `ALREADY_INVITED` | The teammate is in, or invited to, another org | help desk |
| `TEAM_FULL` | 4 people including pending invites | stop, help desk |
| 429 | Rate limited | a `Retry-After` up to 20 s is waited out and tried once more, else stop |

Each answer is kept in `testmu_team_sync` (one row per team and teammate) and audited as
`testmu.team_sync` with the codes only. **Our lock never depends on TestMu AI**: a failed
sync leaves the team locked, `/team` shows each teammate's status, and the captain gets a
"Retry the ones that failed" form (asks for the password again, skips members already at
`MEMBER_ADDED`, `MEMBER_INVITED` or `ALREADY_IN_TEAM`). A solo team makes no calls. A
teammate who isn't alone in their TestMu org can't be moved again, so the sync runs only once
the roster is final. Teams locked another way (the team lock time, an organizer) show the
same panel, so the captain can run it from there. Organizers see the statuses on `/ops/t/{slug}`.

TestMu AI's limits: 30 requests/min per IP and 5/min per email, with `Retry-After` on 429.

## Connect an existing TestMu login (optional)

When `TESTMU_AUTH_URL` is set, people who are not signed in can instead be sent to
TestMu's login page, which redirects back:

```
Participant ── /api/v1/auth/testmu/start?next=/team ──► TestMu AI (register / log in / connect)
                                                              │
   ◄── /api/v1/auth/testmu/callback?state=…&username=…&access_key=…   (or ?code=…)
```

CLI / Codex / MCP callers send the key on each request instead:

```
X-TestMu-Username: alex@example.com
X-TestMu-Access-Key: <access key>
# or: Authorization: Basic base64(username:access_key)
```

`src/proxy.ts` checks the key with TestMu (cached 5 min per instance) and forwards a
60-second signed principal; `getMember()` maps it to the registration with the same
email. A `kanehack pair` bearer token still works for identity. With the switch on it
needs the key headers too, so send both.

## The switch

| `TESTMU_KEY_REQUIRED` | What happens |
|---|---|
| unset / `false` (default) | Site works exactly as today. A valid key still signs a CLI call in; an **invalid** key is refused (401). |
| `true` | `/api/v1/*`, `/mcp`, `/api/upload`, `/{team}/status`: 401 `TESTMU_KEY_REQUIRED` without the cookie or key headers. Participant pages (`/team /activate /setup /passport /t/* /studio/* /match /submit /help /pair /readiness /me`): activate (signed in) or go to `/register`, then back. |

Always open: `/register`, `/passport/login` and `POST /api/v1/auth/register` (where the key
comes from), the handshake (`/api/v1/auth/testmu/*`), `/api/docs`, `/api/v1/openapi.json`,
cron, webhooks and the photo import (they have their own secrets), the landing page,
`/ship/*`, `/live`, `/dashboard`, `/ops/*`, `/judge`.
Staff (`hd_staff` / `hd_admin` cookies) pass the gate: they aren't TestMu users.

Public aggregate reads stay open by default (TV, Mission Control, public Ship Page data,
receipt checks, event brief, Kane catalog). Set `TESTMU_KEY_PUBLIC_PATHS=none` to gate
them too, or a comma-separated list of prefixes to choose. Note that `/live` and
`/dashboard` poll these, so gating them will blank the TV screens.

Roll back: set `TESTMU_KEY_REQUIRED=false` in Vercel (takes effect on the next request
after the env change is applied to the deployment).

## Environment variables

| Variable | Needed | Meaning |
|---|---|---|
| `TESTMU_KEY_REQUIRED` | to enforce | `true` turns the gate on |
| `TESTMU_PROVISION_URL` | production | The claim API: `https://backend.lambdatest.com/api/trials/hack-day/claim`. Unset in production = activation off |
| `TESTMU_TEAM_INVITE_URL` | production | The team invite API: `https://backend.lambdatest.com/api/trials/hack-day/team/invite`. Unset in production = no team sync (the confirm form doesn't ask for a password) |
| `TESTMU_PROVISION_TOKEN` | optional | Sent to the claim API as `Authorization: Bearer …`. The claim API has no auth, so it isn't needed |
| `TESTMU_AUTH_URL` | optional | TestMu login page for the connect flow; we append `redirect_uri` and `state` |
| `TESTMU_VERIFY_URL` | optional | Only for keys we didn't provision: GET with Basic `username:access_key`; 2xx = valid, 401/403 = invalid. Email read from `email`, `data.email`, `user.email` or `data.user.email` |
| `TESTMU_TOKEN_URL` | if TestMu sends a code | POST `{code, redirect_uri}` → `{username, access_key, email?}` |
| `TESTMU_CALLBACK_USERNAME_PARAM` / `TESTMU_CALLBACK_KEY_PARAM` | if names differ | default `username` / `access_key` |
| `TESTMU_KEY_PUBLIC_PATHS` | optional | see above |
| `TESTMU_VERIFY_STUB` | dev only | `valid` (default) / `invalid` when no verify URL outside production |
| `TESTMU_PROVISION_STUB` / `TESTMU_TEAM_INVITE_STUB` | dev only | The code the claim / invite stub answers with when its URL is unset outside production (default `SIGNEDUP` / `MEMBER_ADDED`) |

Outside production with no claim or invite URL, a stub answers in the contract's shapes, so
every outcome can be clicked through on a preview or locally: put `+testmu-<code>` in the
email (`alex+testmu-ineligible@example.com`, `bob+testmu-not-hack-day-org@example.com` as a
teammate). The `invalid-credentials` stub accepts the password `testmu-password`, so the
wrong-password retry works too. For a stateful local mock of both APIs (accounts, orgs,
invites, rate limits), run `node tests/support/testmu-mock.mjs --port 3105` and point the two
URLs at it. Never point a preview or local run at `backend.lambdatest.com`.

Outside production with no `TESTMU_AUTH_URL`, `/start` loops straight to a stub callback
(`dev-user` / `dev-key`) so the flow can be clicked through on a preview. In production a
missing URL fails closed with 503 `TESTMU_UNAVAILABLE`.

## Still needed from TestMu AI

1. Both APIs exist (claim and team invite, US region only, open until 2026-10-27 23:59:59 UTC).
2. Open questions: whether the 30/min per-IP limit counts all of our server's calls as one
   IP, whether a member's access key keeps working after `MEMBER_ADDED` moves them, and what
   `ALREADY_ACTIVE` means for the Hack Day trial.
3. Optional: a login URL + callback parameters for the connect flow, and a verify endpoint
   for keys that didn't come through activation.

## Turning it on

1. Run `npm run db:migrate` (adds `db/039_testmu_hack_day.sql`).
2. Set `TESTMU_PROVISION_URL` and `TESTMU_TEAM_INVITE_URL` in Vercel (production). New
   profiles now activate and show the key, and captains' confirmations sync their teams.
3. Register once yourself and check the key shows and `/team` loads.
4. Set `TESTMU_KEY_REQUIRED=true`. People who registered earlier are asked for their
   TestMu AI password on `/register` the next time they open a participant page.

## Database

`db/034_testmu_access.sql` adds `testmu_links` (additive; run `npm run db:migrate`).
`db/039_testmu_hack_day.sql` adds `testmu_links.organization_id` and `claim_code`, and
`testmu_team_sync` (one row per team and teammate: the last invite `code`, `message`,
`organization_id`, `attempted_at`). Neither ever holds a password.
