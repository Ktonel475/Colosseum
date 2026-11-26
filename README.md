# Discord Competition Management Bot

A dedicated Discord bot + REST API for running a team competition. It manages
teams imported from Excel, player-to-team assignment through Discord, private
per-match discussion threads, result submission/confirmation, audit logging and
JSON/CSV/XLSX exports.

The bot and API run in a single Node.js process but are cleanly separated into
modules that share the same SQLite database and business-logic services.

---

## Table of contents

1. [Project overview](#1-project-overview)
2. [Prerequisites](#2-prerequisites)
3. [Installation](#3-installation)
4. [Discord application and bot setup](#4-discord-application-and-bot-setup)
5. [Required Gateway Intents](#5-required-gateway-intents)
6. [Required permissions and OAuth2 scopes](#6-required-permissions-and-oauth2-scopes)
7. [Discord role configuration](#7-discord-role-configuration)
8. [Environment configuration](#8-environment-configuration)
9. [Database initialization and migrations](#9-database-initialization-and-migrations)
10. [Slash-command registration](#10-slash-command-registration)
11. [Starting the bot and API](#11-starting-the-bot-and-api)
12. [Excel import template](#12-excel-import-template)
13. [API documentation](#13-api-documentation)
14. [Backup and recovery](#14-backup-and-recovery)
15. [Troubleshooting](#15-troubleshooting)
16. [Testing](#16-testing)
17. [Project structure](#17-project-structure)
18. [Design notes and Discord limitations](#18-design-notes-and-discord-limitations)

---

## 1. Project overview

Three capabilities are implemented:

**Team management and player assignment**

- Teams are imported from an `.xlsx` file or added manually. The Excel file is the
  source of truth for the team list and contains team information only (the
  importer reads the `ประเภทเกม` / `รหัสทีม` / `ชื่อทีม` columns; other columns
  are ignored). `รหัสทีม` is the primary key, so it must be globally unique.
  `ชื่อทีม` only has to be unique inside the same `ประเภทเกม`; the same team name
  may appear once per game type / competition category.
  Removing a team from the file marks it **inactive**; it is never deleted and no
  historical match data is lost.
- Players register themselves with their Discord account. On join they receive a DM
  with a **Choose Team** button. The bot replies with a prompt, the player types
  their **team code (รหัสทีม)** or **team name** as a normal message, and the bot
  answers with a select menu → mandatory **Confirm/Cancel** step.
  Alternatively `/regist teamname:<name or code>` picks a team directly
  (autocomplete by name/code); the confirmation step still applies.
  A player can change team with `/repick-team teamname:<name or code>`, or run
  `/repick-team` without the option for the message-based search.
  When `MATCH_MODULE_ONLY=true`, the automatic newcomer DM is skipped; `/regist`,
  `/repick-team` and every other command keep working as usual.
- The bot speaks **English and Thai only**. `/language language:<English|ไทย>`
  saves a per-user preference. Every interaction uses that preference first,
  then the Discord client locale (`interaction.locale`), then English. The
  newcomer welcome DM uses the saved preference or the guild's preferred locale.
- **Development shortcut:** `/init target:<@user>` selects a user with Discord's
  native **User option** (on-server or off-server) and uses the selected user's ID
  as the immutable identifier — never a typed username. It resets that user to the
  initial player state (registered, no team) and resends the newcomer
  welcome DM with the **Choose Team** button, so the join → select → confirm flow
  can be tested without a real member-join. It is only registered when
  `ENABLE_DEV_COMMANDS` is true (default: true outside production).
- Every team has a matching Discord role. Role assignment is synchronized from the
  player-to-team database records, and a player never keeps two competition roles.

**Match and result management (extractable module: `src/modules/match`)**

- `/match-create [channel] team1 team2 [require_role]` creates one private thread
  in the chosen **round channel** (or the current channel when `channel` is
  omitted), so a single server can host many independent round channels. Teams
  are selected by **team name or team code** (`team_id`) with autocomplete. By
  default (`require_role:true`) each team must have a matching Discord role, and
  the intro message pings both destination roles with a real `<@&roleId>`
  mention. Pass `require_role:false` to allow a plain-name intro when a role is
  missing. The thread name comes from the locale template (`{team1} vs {team2}`
  in English, `{team1} พบ {team2}` in Thai).
- `/match-create-bulk [require_role]` opens an ephemeral panel with two team
  pickers. Add as many pairings as needed, then **Create matches** to create all
  threads in the round in one flow. Each pair is validated independently and the
  summary lists success or failure per pairing. The same `require_role` behavior
  applies to every thread.
- `/result` is admin-only and works **only inside a module match thread** (the
  thread ID is resolved from `interaction.channel`, never from an argument). The
  admin picks the winner, then confirms with a button; only the same admin who
  started the flow can confirm. Confirming persists the result, marks the match
  `completed`, and posts a localized result embed in the thread.
- The module uses the single `ADMINISTRATOR_ROLE_ID` gate for both match creation
  and result entry, stores match records through a swappable repository (Prisma
  model `match_module_records`), and loads every user-facing string from the
  project-wide locale files `src/locales/{en,th}.json` through
  `src/utils/i18n.js`.
- The legacy team-code subsystem (`/match-list`, `/match-info`, `/match-close`,
  `/result-status`, `/result-review`, `/result-edit`, `/result-cancel`) remains
  registered and continues to use the original `matches`/`results` tables; it is
  independent of the module's records.

**REST API and exports**

- Read-only JSON endpoints for teams, players, matches and results with pagination
  and filtering.
- Authenticated JSON/CSV/XLSX exports for each dataset and for everything.
- Structured logging (Pino) and audit logging for important actions.

---

## 2. Prerequisites

- Node.js **18 LTS or newer**
- npm 9+
- A Discord application and bot token
- A Discord server where the bot can be invited
- SQLite (bundled with Prisma — no separate server needed)

---

## 3. Installation

```bash
git clone <your-repo-url> discord-competition-bot
cd discord-competition-bot
npm install
cp .env.example .env
# edit .env with your values
npm run prisma:generate
npm run prisma:deploy     # apply migrations (creates the SQLite DB)
```

For local development you can also use `npm run db:push` to sync the schema
without creating a migration.

---

## 4. Discord application and bot setup

1. Open <https://discord.com/developers/applications> and click **New Application**.
2. Go to **Bot**, click **Add Bot**, and copy the **Token** into `DISCORD_BOT_TOKEN`.
3. Copy the **Application ID** from **General Information** into `DISCORD_CLIENT_ID`.
4. Enable the required Gateway Intents (see section 5).
5. Build an invite URL from **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permissions: `Manage Roles`, `Manage Channels`, `Manage Threads`,
     `Create Private Threads`, `Send Messages in Threads`, `Send Messages`,
     `View Channels`, `Read Message History`, `Use External Emojis` (optional)
6. Invite the bot to your server. No guild ID needs to be configured: the bot
   detects every server it joins automatically and registers its slash
   commands there.

> **Important:** the bot's own role must be **above** every team role in the server
> role hierarchy, otherwise Discord will refuse to add/remove those roles.

---

## 5. Required Gateway Intents

Enable these in **Bot → Privileged Gateway Intents** where applicable:

| Intent | Why |
|---|---|
| `Guilds` | Guild/channel/role events |
| `Guild Members` (privileged) | `guildMemberAdd`, member fetching, role sync |
| `Guild Messages` | Interaction context and thread messages |
| `Message Content` (privileged) | Intro messages and result messages in threads |
| `Direct Messages` | First-time team selection DM |

The code requests them in `src/bot/index.js`:

```js
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMembers,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.MessageContent,
GatewayIntentBits.DirectMessages,
```

---

## 6. Required permissions and OAuth2 scopes

**Scopes**

- `bot` — run the bot
- `applications.commands` — register slash commands

**Bot permissions**

| Permission | Reason |
|---|---|
| View Channels | See the match-management channel |
| Send Messages | Welcome/DM and thread intro messages |
| Send Messages in Threads | Result messages inside match threads |
| Create Private Threads | Per-match private threads |
| Manage Threads | Add/remove members and delete closed match threads |
| Manage Roles | Create team roles and assign/remove them |
| Manage Channels | Resolve/fetch channels and threads |

`Manage Roles` is the sensitive one: Discord additionally enforces the role
hierarchy described in section 4.

---

## 7. Discord role configuration

1. Create (or let the bot create) an **Administrator role** used for admin
   commands. Put its ID in `ADMINISTRATOR_ROLE_ID`. Members with Discord's native
   `Manage Server` permission are also treated as administrators.
2. Optionally create a **Competition Staff role** (`COMPETITION_STAFF_ROLE_ID`).
   Staff can be added to match threads and may finalize/cancel results.
3. Optional `SUPPORT_CHANNEL_ID` is referenced in the "team not found" message.
4. Team roles are created automatically (`/team-import`, `/team-add`, `/team-sync`)
   using the official team name. `/team-sync` is safe to rerun and reports errors
   per team.
5. Ensure the bot's role is **above** all team roles.

---

## 8. Environment configuration

All configuration lives in `.env` (see `.env.example`). Nothing is hardcoded.

| Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token |
| `DISCORD_CLIENT_ID` | Application/client ID |
| `MATCH_MANAGEMENT_CHANNEL_ID` | Parent text channel for private match threads |
| `ADMINISTRATOR_ROLE_ID` | Admin role for administrative commands |
| `COMPETITION_STAFF_ROLE_ID` | Optional staff role |
| `MATCH_MODULE_ONLY` | `true` = register only the module's `/match-create`, `/match-create-bulk`, `/result` and skip the automatic newcomer welcome DM (all other commands/features stay available); `false` (default) = keep legacy match/result commands too |
| `SUPPORT_CHANNEL_ID` | Optional support channel for "team not found" |
| `API_PORT` | REST API port (default 3000) |
| `API_AUTH_SECRET` | Bearer token required by `/api/export/*` |
| `CORS_ORIGIN` | `*` or a comma-separated list of origins |
| `DATABASE_URL` | SQLite URL, e.g. `file:../data/dev.db` (paths resolve relative to `prisma/`) |
| `RESULT_CONFIRMATION_POLICY` | `both_teams`, `administrator`, `automatic` |
| `INTERACTION_EXPIRATION` | Confirmation lifetime in ms (default 300000 = 5 min) |
| `MAX_FILE_SIZE` | Max upload size in bytes (default 10 MB) |
| `API_RATE_LIMIT_WINDOW_MS` / `API_RATE_LIMIT_MAX` | API rate limiting |
| `LOG_LEVEL` / `LOG_FILE` | Pino logging |
| `ENABLE_BOT` / `ENABLE_API` | Run only one side if desired |

Secrets are never logged or returned by the API.

---

## 9. Database initialization and migrations

The Prisma schema lives in `prisma/schema.prisma` (SQLite provider).

```bash
# Create/apply migrations in development
npm run prisma:migrate

# Apply existing migrations (production / CI)
npm run prisma:deploy

# Quick schema sync without a migration (dev only)
npm run db:push

# Regenerate the Prisma client after schema changes
npm run prisma:generate
```

Tables: `teams`, `players`, `matches`, `results`, `result_confirmations`,
`audit_logs`, and `player_selections` (short-lived UI sessions). Foreign keys and
indexes are defined in the schema; multi-step writes use Prisma transactions.

`teams.team_id` (รหัสทีม) is the **primary key**, so player and match records
reference the team code directly. `teams.game_type` stores ประเภทเกม. Deleting a
team is never allowed; removal from an import only flips `is_active`.

The database file location is controlled by `DATABASE_URL`. For production keep it
on a persistent volume and back it up (section 14).

---

## 10. Slash-command registration

Commands are registered automatically when the bot becomes ready:

- Every guild the bot is currently in gets its commands registered **per guild**
  (instant, no `DISCORD_SERVER_ID` required).
- When the bot is invited to a new server, it registers the commands there as
  soon as it joins.
- If the bot is not in any guild yet, commands are registered **globally** as a
  fallback (may take up to an hour to propagate).

To force re-registration, restart the bot. Command definitions are in
`src/bot/registerCommands.js`.

Administrative commands also declare `defaultMemberPermissions(ManageGuild)`, but
the bot re-checks permissions server-side (`isAdmin`) — Discord permission checks
alone are never trusted.

### Command reference

| Command | Who | Purpose |
|---|---|---|
| `/team-import file:<xlsx>` | Admin | Validate, preview and confirm an Excel import |
| `/team-list` | Everyone | List active teams |
| `/team-add game_type team_id team_name` | Admin | Add a team manually (`รหัสทีม` is the primary key) |
| `/team-remove team` | Admin | Deactivate a team (history kept) |
| `/team-sync` | Admin | Create/sync Discord roles for active teams |
| `/myteam` | Everyone | Show your team |
| `/regist [teamname]` | Everyone | Register and pick a team by name/code, or run without the option for message search → confirm |
| `/repick-team [teamname]` | Everyone | Change team by name/code, or run without the option for message search → confirm |
| `/language language` | Everyone | Choose the bot language: English or Thai. Saved per Discord user |
| `/init target:@user` | Dev only | Reset the selected user to the initial player state (no team) and resend the welcome DM; enabled by `ENABLE_DEV_COMMANDS` |
| `/match-create [channel] team1 team2 [require_role]` | Admin role | Create one private match thread in the selected round channel, pinging both team roles (defaults to the current channel; autocomplete for team name/code) |
| `/match-create-bulk [require_role]` | Admin role | Assemble N pairings in a panel and create all threads, pinging each team role |
| `/match-list [status]` | Everyone | List matches (legacy team-code subsystem) |
| `/match-info [match]` | Everyone | Match details (or current thread) |
| `/match-close [match]` | Admin | Close match and delete its private thread |
| `/result` | Admin role | Pick the winner inside a module match thread; confirm as the same admin |
| `/result-status` | Everyone | Show result/confirmation status |
| `/result-review` | Admin | Review pending results with buttons |
| `/result-edit result_id score1 score2` | Admin | Correct a result (audited) |
| `/result-cancel` | Participant/Admin | Cancel pending result in this thread |

---

## 11. Starting the bot and API

```bash
# Both bot and API in one process
npm start

# Only the API
ENABLE_BOT=false npm start

# Only the bot
ENABLE_API=false npm start
```

The API listens on `http://localhost:${API_PORT}`; `GET /health` reports status and
database connectivity. Graceful shutdown (SIGINT/SIGTERM) closes the HTTP server,
destroys the Discord client and disconnects Prisma.

---

## 12. Excel import template

A ready-to-use file is included at `templates/teams-template.xlsx`. It uses the
competition registration export format (Thai headers). Only two columns are
required for the import:

| Column | Maps to | Description |
|---|---|---|
| `รหัสทีม` (required) | `team_id` | Team code — **primary key**, must be unique |
| `ชื่อทีม` (required) | `team_name` | Official team name; may repeat in a different game type (used for the Discord role) |
| `ประเภทเกม` (optional) | `game_type` | Game type, e.g. RoV / CS2 |

The full expected header row is:

| ลำดับ | ประเภทเกม | ส่งใบสมัครเมื่อ | รหัสทีม | ชื่อทีม | โรงเรียน | สังกัด | สถานะ | เหตุผลจากผู้จัด | อนุมัติเมื่อ | ผู้ควบคุมทีม | เบอร์ผู้ควบคุมทีม | อีเมลผู้ติดต่อ | บัญชี LINE | จำนวนสมาชิก | มีรูปแล้ว | แนบเอกสารยืนยันตัวตน | เช็คอินแล้ว |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

All other columns are accepted and ignored — the importer reads `ประเภทเกม`,
`รหัสทีม` and `ชื่อทีม`. The legacy English headers (`game_type`, `team_id`,
`team_name`) are still accepted, and headers are matched case-insensitively with
surrounding whitespace trimmed.

Example (trimmed to the relevant columns):

| รหัสทีม | ชื่อทีม |
|---|---|
| T001 | Team Alpha |
| T002 | Team Bravo |
| T003 | Team Charlie |

Import behaviour:

- Missing required columns, duplicate IDs, duplicate team names **within the same
  game type** (in the file or against the DB), and blank required fields reject
  the whole import. The same team name in a different `ประเภทเกม` is allowed and
  imported as a separate team.
- A preview shows counts of new / updated / deactivated teams; nothing is written
  until an administrator presses **Confirm** (expires after 5 minutes).
- New teams are created, renamed teams updated, and teams absent from the file
  deactivated (never deleted).
- After confirmation, Discord roles are synchronized.

---

## 13. API documentation

Base URL: `http://localhost:${API_PORT}`

All responses are JSON unless an export format is requested. Collection endpoints
accept:

- `page` (default 1)
- `limit` (default 25, max 200)
- plus endpoint-specific filters below.

### Public read endpoints

| Method | Path | Filters | Description |
|---|---|---|---|
| GET | `/health` | — | Liveness + DB status |
| GET | `/api/teams` | `search`, `includeInactive=true` | Paginated teams |
| GET | `/api/teams/:id` | — | Team by `team_id` (primary key) or name (with players) |
| GET | `/api/players` | `search`, `teamId` | Paginated players |
| GET | `/api/players/:discordId` | — | Player by Discord user ID |
| GET | `/api/matches` | `status`, `teamId` | Paginated matches |
| GET | `/api/matches/:id` | — | Match by id or thread id |
| GET | `/api/results` | `status`, `matchId` | Paginated results |
| GET | `/api/results/:matchId` | — | Latest result for a match |

Responses use the shape:

```json
{
  "data": [ ... ],
  "pagination": { "page": 1, "limit": 25, "total": 42, "pages": 2 }
}
```

### Protected export endpoints

Require `Authorization: Bearer <API_AUTH_SECRET>`. Missing/invalid credentials
return `401`; if the secret is not configured the endpoints return `503`.

| Method | Path | `format` |
|---|---|---|
| GET | `/api/export/teams` | `json` (default), `csv`, `xlsx` |
| GET | `/api/export/players` | `json`, `csv`, `xlsx` |
| GET | `/api/export/matches` | `json`, `csv`, `xlsx` |
| GET | `/api/export/results` | `json`, `csv`, `xlsx` |
| GET | `/api/export/all` | `json`, `csv`, `xlsx` |

Examples:

```bash
curl http://localhost:3000/api/teams?page=1&limit=10
curl -H "Authorization: Bearer $API_AUTH_SECRET" \
     -o teams.xlsx "http://localhost:3000/api/export/teams?format=xlsx"
curl -H "Authorization: Bearer $API_AUTH_SECRET" \
     "http://localhost:3000/api/export/all?format=csv"
```

All `/api/*` routes are rate limited (default: 100 requests / 15 minutes per IP).
No administrative or mutating operation is exposed over HTTP.

---

## 14. Backup and recovery

SQLite stores everything in the file referenced by `DATABASE_URL`
(default `data/dev.db`).

**Online backup (recommended)** — use SQLite's backup command so a writer does not
corrupt the copy:

```bash
sqlite3 data/dev.db ".backup 'backup/dev-$(date +%Y%m%d-%H%M%S).db'"
```

**Simple copy** (stop the process first):

```bash
cp data/dev.db backup/dev.db
```

**Restore**

```bash
# stop the bot/API
cp backup/dev.db data/dev.db
npm run prisma:deploy   # ensure migrations are applied
# start again
```

Keep at least one backup outside the machine and test restores periodically.
`prisma/migrations` should be version-controlled; the `.db` file should not.

---

## 15. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Logs `PrismaClientKnownRequestError` / `The table main.teams does not exist` | The database has no schema yet. Run `npm run prisma:deploy` (or `npm run db:push` in development), then restart the bot. |
| Bot online but slash commands missing | Commands are registered per guild when the bot starts or joins; check the logs, then restart the bot. |
| Logs `DiscordAPIError[10004]: Unknown Guild` | A guild the bot was in no longer exists. Re-invite the bot; the guild ID is detected automatically on join. |
| "Missing Permissions" when creating roles | Bot role is below team roles, or `Manage Roles` not granted. |
| Cannot create private thread | Bot lacks `Create Private Threads` / `Manage Threads`, or `MATCH_MANAGEMENT_CHANNEL_ID` is not a text channel. |
| New members get no DM | `MATCH_MODULE_ONLY=true`, user has DMs disabled, or `Direct Messages` / `Guild Members` intent missing. The bot logs a warning and the member can still use `/repick-team`. |
| Player can't see a match thread | They joined after the match was created or changed teams. `/team-sync` re-syncs roles; thread membership is re-synced on team changes and on match creation. |
| Import rejected | Check required columns, duplicate IDs, duplicate names inside the same game type, and blank rows. The preview lists the exact row errors. |
| `/result` says "not associated with a match" | Use the exact thread created by `/match-create`; commands in normal channels or unrelated threads are rejected. Both `/result` and `/match-create*` require `ADMINISTRATOR_ROLE_ID` (or Discord's native `Manage Server` permission for legacy admin checks). |
| API export returns 503 | `API_AUTH_SECRET` is not set. |
| Prisma "database is locked" | Run a single instance, or use shorter transactions; SQLite allows one writer. |

Logs: `LOG_FILE` (default `logs/app.log`) plus stdout. Set `LOG_LEVEL=debug` for
more detail.

---

## 16. Testing

```bash
npm test
```

The suite uses Jest (ESM) with a dedicated `data/test.db` created by
`tests/globalSetup.js`. Discord interactions are mocked with lightweight fakes
(`tests/helpers.js`), so no real Discord connection is required.

Coverage highlights:

- **Team import** — valid parse, header normalization, missing columns, duplicate
  IDs/names, new/updated/deactivated teams.
- **Player registration** — first assignment, team change with old-role removal,
  inactive team rejection, expired sessions, active-team search, duplicate/expired
  confirmation tokens.
- **Matches** — creation with private thread, participant membership, self-match,
  inactive teams, duplicates, thread access sync on team change.
- **Results** — valid submission, wrong thread, unrelated player, invalid scores,
  duplicate submission, both-teams/administrator/automatic policies, audited
  corrections, cancellation rules, closed matches.
- **API** — health, pagination, filtering, 404s, auth required/invalid/valid,
  JSON/CSV/XLSX exports.

---

## 17. Project structure

```
src/
├── bot/
│   ├── index.js               # Client, events, welcome DM, startBot
│   ├── registerCommands.js    # Slash command definitions
│   └── interactions/
│       ├── index.js           # Command/button/select handlers
│       └── state.js           # Expiring pending selections & imports
├── services/
│   ├── teamService.js         # Import, add/remove, role sync
│   ├── playerService.js       # Team assignment + compensation logic
│   ├── matchService.js        # Matches, private threads, access sync
│   ├── resultService.js       # Submission + configurable confirmation
│   ├── exportService.js       # JSON / CSV / XLSX
│   └── auditService.js        # Audit logging
├── imports/
│   └── excelImport.js         # XLSX parsing + validation
├── database/
│   └── prisma.js              # Shared Prisma client
├── api/
│   ├── app.js                 # Express app factory
│   ├── server.js              # Entry point (API + bot, graceful shutdown)
│   ├── middleware/            # auth, rate limit, async handler
│   └── routes/                # teams, players, matches, results, export
├── config/index.js            # Zod-validated environment config
└── utils/                     # logger, errors
prisma/
├── schema.prisma
└── migrations/
tests/                         # Jest suites + fakes
templates/teams-template.xlsx  # Excel import template
```

---

## 18. Design notes and Discord limitations

- **Private threads do not inherit role access.** Every participant must be added
  individually. The bot adds the registered players of both teams and staff when a
  match is created, and re-syncs membership when a player changes team
  (`syncThreadAccessForPlayer`). Failures are logged and surfaced to the
  administrator as a warning instead of silently dropping access.
- **Monospace team tables.** Discord does not render Markdown pipe tables, so team
  information (`/team-list`, `/myteam`, `/regist`/`/repick-team` confirmation,
  `/match-list`, and the import preview) is rendered as a left-aligned table inside
  a triple-backtick code block. Column widths come from the longest cell, headers
  are followed by a `-` divider aligned to the same pipe positions, and long tables
  are split across messages with the header repeated. CJK glyphs and emoji can be
  wider than Latin characters, so those tables may drift slightly; short labels
  align best.
- **Message length.** Discord rejects messages over 2000 characters. Long output
  (`/team-list`, `/match-list`, import errors/preview details) is split by
  `src/utils/message.js` into 1900-character chunks and sent as follow-up messages,
  so nothing is silently truncated.
- **Message-based search (no modal).** Discord select menus have no search box, so
  team choice is a button/command → bot asks the user to type a team code or name
  in the chat → select menu → explicit confirm/cancel. The prompt times out after
  `INTERACTION_EXPIRATION` (default 5 minutes) and `cancel` stops it. Only active
  teams from the database are offered; free-text team names can never create
  teams. Results are capped at 25 options; users narrow the list by typing a more
  specific code or name. If the typed search finds nothing (or a `/regist` /
  `/repick-team` name is missing/ambiguous), the bot keeps the loop open instead
  of failing; a **Search again** button on the confirmation step discards the
  pending selection and restarts the search.
- **Language resolution.** Preferred strings live in `src/locales/{en,th}.json`.
  `src/services/languageService.js` stores each user's choice in `user_settings`
  (independent of player registration) and resolves it with the Discord client
  locale as fallback. Handlers read the resolved value from `interaction.userLocale`.
- **Extractable match module.** `src/modules/match` owns `/match-create`,
  `/match-create-bulk` and `/result`. It reads env only through `config.match`
  and `config.discord.adminRoleId`, persists via a repository interface
  (`createRepository()` → Prisma or memory), and loads Thai/English strings from
  the project-wide `src/locales/{en,th}.json` using `src/utils/i18n.js`. The host
  only merges its command definitions and forwards `matchmod:` component
  interactions; the module never imports the command registry, `/init`, or player
  onboarding code.
- **Interaction safety.** Confirmation tokens are single-use, bound to the user,
  expire after `INTERACTION_EXPIRATION`, and are consumed atomically, so double
  clicks or replayed custom IDs cannot assign a team twice. Custom IDs are never
  trusted for authorization — every handler re-checks the database and permissions.
- **Safe ordering with compensation.** Team assignment adds the new role first,
  then writes the database transactionally, then removes stale team roles. If the
  Discord role add fails, nothing is saved; if stale-role removal fails afterwards,
  the database stays authoritative and the player is warned to contact an admin.
- **Result confirmation is policy-driven.** The policy is read from
  `RESULT_CONFIRMATION_POLICY` and centralized in `resultService`; it is not
  hardcoded across commands. Both-teams confirmation requires one confirmation
  from a member of *each* participating team.
- **Excel is the source of truth for teams only.** Players are never imported; they
  register through Discord, keyed by Discord user ID.
- **Historical integrity.** Teams are deactivated, never deleted, and results keep
  their match/team references after deactivation.
