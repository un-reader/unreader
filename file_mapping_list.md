# Un-Reader File Map

This document is a guide to the repository as it exists now. It maps the user-facing pages to shared code, server routes, data tables, assets, and hosting files. Most of the browser apps are plain HTML, CSS, and JavaScript in `static/`; their server-side behavior is concentrated in `index.js` and `database.js`.

## Start here

| If you are changing… | Start with… | Also check… |
| --- | --- | --- |
| Dashboard links, login UI, settings, or app launch | [`static/index.html`](static/index.html) | [`static/common.js`](static/common.js), matching app page |
| Shared sign-in, live chat, DMs, or chat roles | [`static/chat.html`](static/chat.html) | [`static/common.js`](static/common.js), WebSocket handlers in [`index.js`](index.js) |
| Shared colors, typography, or BBS controls | [`static/styles.css`](static/styles.css), [`static/bbs.css`](static/bbs.css), [`static/theme.css`](static/theme.css) | The page being changed and Kindle behavior |
| HTTP API, authorization, or server-side app behavior | [`index.js`](index.js) | [`database-schema.js`](database-schema.js), [`database.js`](database.js) |
| Database tables or migrations | [`database-schema.js`](database-schema.js) | [`database.js`](database.js), callers in `index.js` |
| Database failover, replication, or coordinator behavior | [`database.js`](database.js) | [`hosting.md`](hosting.md), [`test/database.test.js`](test/database.test.js) |
| Netlify routing or WebSocket behavior | [`netlify.toml`](netlify.toml) | [`netlify/functions/server.mjs`](netlify/functions/server.mjs), [`netlify/edge-functions/render-websocket.ts`](netlify/edge-functions/render-websocket.ts) |
| Kindle-specific browser behavior | [`kindle-browser-quirk-system.skill`](kindle-browser-quirk-system.skill) | The app page and shared styles/scripts |

## Browser apps

All files in this section are served from `static/`. The dashboard links to these pages; server APIs are listed in the backend sections below.

### Dashboard and community

| File | Purpose and connections |
| --- | --- |
| [`static/index.html`](static/index.html) | Main dashboard, account login/registration, profile settings, display preferences, and app launcher. Uses the shared account/profile APIs and `common.js`; app visibility is based on the user's role. |
| [`static/chat.html`](static/chat.html) | Current public chat and direct-message client, including threaded replies. Uses the root WebSocket connection, history/profile APIs, message reactions, role styles, system AI providers, and account actions. |
| [`static/chatold.html`](static/chatold.html) | Older chat client retained for reference or fallback. Shares the root WebSocket protocol and older UI implementation. |
| [`static/topics.html`](static/topics.html) | Topic/room list and live topic conversations. Uses the root WebSocket, topic history, profile APIs, reactions, and moderation events. Data is in `topics` and `topic_messages`. |
| [`static/neighbourhood.html`](static/neighbourhood.html) | Forum-style feed with posts and comments. Uses the root WebSocket and neighbourhood history/profile APIs. Data is in `neighborhood_posts` and `neighborhood_comments`. |
| [`static/suggestions.html`](static/suggestions.html) | Feature suggestion list, submission, status/tag display, comments, and moderation actions. Uses suggestion history and `/api/suggestions/*`; comments are stored separately from suggestions. |
| [`static/roles.html`](static/roles.html) | Admin role editor and role assignment UI, including previews. Uses `/api/admin/roles` and `/api/admin/assign-role`; role definitions and assignments live in the database. |
| [`static/modmenu.html`](static/modmenu.html) | Moderation/admin dashboard: logs, user lookup, role changes, IP bans, and admin-removal voting. Uses admin/moderation APIs and live moderation WebSocket events. |
| [`static/mod-pfps.html`](static/mod-pfps.html) | Moderator queue for reviewing and managing profile pictures. Uses `/api/mod/profile-images`. |
| [`static/profile-picture.html`](static/profile-picture.html) | Profile-picture editor for drawing or importing a picture and saving it to a profile. Uses profile APIs. |

### Connected services and account data

| File | Purpose and connections |
| --- | --- |
| [`static/fandom.html`](static/fandom.html) | Fandom wiki reader/editor. Uses server routes for Fandom login/session, page retrieval, and edits; the server keeps the upstream wiki session. Saved BotPassword ciphertext is handled by the user credential vault API. |
| [`static/github.htm`](static/github.htm) | GitHub workspace for browsing repositories, files, releases, previews, and source downloads. GitHub API calls are made by the page; encrypted saved-token operations use `/api/user/github-token-vault`. |
| [`static/mail.html`](static/mail.html) | IMAP/POP mail client, credential vault, message list and reader, and Outlook device-code OAuth for IMAP. Uses `/api/mail/*` and `/api/user/mail-credentials`. |
| [`static/irc.html`](static/irc.html) | General-purpose IRC client. Connects to the server's `/irc` WebSocket bridge, which makes the upstream IRC TCP/TLS connection. |
| [`static/lyrics.html`](static/lyrics.html) | Lyrics search and reader. Queries LRCLIB directly from the browser. |
| [`static/changelog.html`](static/changelog.html) | Displays repository commits through `/api/commits`; the server caches GitHub responses in `github_changelog_cache`. |
| [`static/racepedia.html`](static/racepedia.html) | Wikipedia article reader using `/api/wikipedia/:page`; fetched article HTML is cached in the `wikipedia` table. |
| [`static/rekindle.html`](static/rekindle.html) | ReKindle app wrapper with rich-presence reporting. Embeds the external ReKindle site. |
| [`static/readium.html`](static/readium.html) | Readium wrapper with rich-presence reporting. Embeds the external Readium site. |

### Games, tools, and experiments

| File | Purpose and connections |
| --- | --- |
| [`static/EmberkeepUltimate.html`](static/EmberkeepUltimate.html) | Standalone Emberkeep game with offline play, live PvP, and mod support. Its modding guide is [`static/MODDING.md`](static/MODDING.md). Or at least I would say so because aran cut the FUCKING ROUTES. Hiding your APIs and source code won't protect you and your scummy tactics aran. |
| [`static/doodle.html`](static/doodle.html) | Doodle Jump-style game with keyboard/touch controls and leaderboard. Scores use `/api/doodle/*` and `doodle_scores`. |
| [`static/portal-2d.html`](static/portal-2d.html) | Portal-inspired platformer with level editor features, online level packs, demo playback, and official pack support. Uses `/api/portal2d/*`, the `portal-2d` table, and `portal2d_demos`. |
| [`static/portal-2d-editor.html`](static/portal-2d-editor.html) | Sledgehammer editor companion for creating and exporting Portal 2D levels. |
| [`static/oregon_trail.html`](static/oregon_trail.html) | Oregon Trail browser game. Loads game logic from `oregonTrailGame.js`. |
| [`static/about.html`](static/about.html) | About/help page associated with Oregon Trail. |
| [`static/reversi.html`](static/reversi.html) | Reversi game. |
| [`static/cwol.html`](static/cwol.html) | Conway's Game of Life. |
| [`static/calc.html`](static/calc.html) | E-ink-friendly calculator. |
| [`static/pokedex.html`](static/pokedex.html) | Pokédex browser. Loads data from the public PokéAPI and the shared Neko loader. |
| [`static/pet-creator.html`](static/pet-creator.html) | Neko pet editor/publisher. Published pets use `/api/pets` and the `pets` table. |

## Shared browser resources

| File | Purpose |
| --- | --- |
| [`static/common.js`](static/common.js) | Shared backend and WebSocket URL selection, authentication/session helpers, theme and display preference injection, role/presence helpers, and encrypted credential-vault helpers used by apps. |
| [`static/styles.css`](static/styles.css) | Shared site/page layout, responsive behavior, and base visual rules. |
| [`static/bbs.css`](static/bbs.css) | Shared BBS controls, buttons, borders, and legacy app visual conventions. |
| [`static/theme.css`](static/theme.css) | Shared theme variables and user-selectable visual themes. |
| [`static/debug-console.js`](static/debug-console.js) | On-page debug output for environments without developer tools; enabled through the shared debug configuration. |
| [`static/neko-loader.js`](static/neko-loader.js) | Loads and configures the optional Neko pet on pages that include it. |
| [`static/neko.js`](static/neko.js) | Locally hosted Neko pet implementation. Check [`static/LICENSE.md`](static/LICENSE.md) before redistributing or changing the upstream-derived code. |
| [`static/oregonTrailGame.js`](static/oregonTrailGame.js) | Game logic used by `oregon_trail.html`. |
| [`static/eruda.js`](static/eruda.js) | Vendored Eruda debugging console library. |
| [`static/reaction-emoticons.csv`](static/reaction-emoticons.csv) | Editable reaction catalogue used by chat reaction search/selection. Keep its columns and numeric codes aligned with the database constraint and client parser. |
| [`static/favicon.ico`](static/favicon.ico) | Site favicon. |
| [`static/LICENSE.md`](static/LICENSE.md) | Project/library license notes. |
| [`static/MODDING.md`](static/MODDING.md) | Emberkeep modding documentation. |

## Static assets

| File or directory | Used for |
| --- | --- |
| [`static/DTM-Mono.ttf`](static/DTM-Mono.ttf) | Determination Mono font, in the official build, it's used. |
| [`static/pusab.ttf`](static/pusab.ttf) | Pusab font used by Geometry Dash textbox roles and related UI. |
| [`static/assets/fit.json`](static/assets/fit.json) | Doodle game asset/layout metadata. |
| [`static/assets/player.svg`](static/assets/player.svg), [`static/assets/playerUp.svg`](static/assets/playerUp.svg), [`static/assets/playerDown.svg`](static/assets/playerDown.svg), [`static/assets/jetpack.svg`](static/assets/jetpack.svg) | Doodle game player poses and jetpack. |
| [`static/assets/src/`](static/assets/src/) | Source SVG versions of the Doodle game artwork; optimized or runtime copies are in `static/assets/`. |

## Server and database

### Server entry point and HTTP routes

[`index.js`](index.js) creates the Express app, HTTP APIs, WebSocket servers, authentication and authorization checks, provider integrations, and the standalone Render-style listener. It exports the app/database readiness for serverless hosting. Main HTTP route groups:

| Route group | Main purpose |
| --- | --- |
| `/api/register`, `/api/login`, `/api/change-password` | Account creation, login, and password changes. |
| `/api/profile/*`, `/api/user/*-vault` | Profiles and encrypted GitHub, Fandom BotPassword, and mail credential payloads. Legacy GitHub-token endpoint is also present. |
| `/history`, `/dm-history`, `/topic-history`, `/neighborhood-history`, `/suggestions-history` | Paginated history/feed reads. |
| `/api/suggestions/*` | Suggestion creation, edits, deletion, status, and comments. |
| `/api/admin/*`, `/api/mod/*` | Role management, moderation, audit logs, profile-picture queue, IP bans, and admin-removal proposals/votes. |
| `/api/mail/*` | Mail retrieval, Outlook device-code OAuth, token refresh, and OAuth availability. |
| `/api/ai/cloudflare` | Authenticated server-side Cloudflare Workers AI proxy with request validation and per-user rate limiting. |
| `/api/fandom/*` | Fandom login/session, page reads, and wiki edits. |
| `/api/commits` | Cached GitHub commit feed. |
| `/api/wikipedia/:page` | Wikipedia page retrieval and cache. |
| `/api/pets` | Published pet listing and submission. |
| `/api/doodle/*` | Doodle leaderboard and score submission. |
| `/api/portal2d/*` | Portal 2D account info, levels, demos, and official pack endpoints. |
| `/internal/database` | Authenticated database-coordinator interface for serverless or secondary instances. |

The root WebSocket (`/`) handles chat authentication, public/topic/DM/forum messages, reactions, presence, scrshare, and moderation events. The `/irc` WebSocket bridges authenticated browser clients to public IRC servers. Netlify cannot host persistent WebSockets directly; see the Netlify section below.

### Database files and tables

| File/table | Purpose |
| --- | --- |
| [`database-schema.js`](database-schema.js) | Idempotent schema and backfill SQL. Tables: `users`, `profiles`, `profile_images`, `messages`, `dms`, `topics`, `topic_messages`, `message_reactions`, `neighborhood_posts`, `neighborhood_comments`, `roles`, `mod_logs`, `banned_ips`, `admin_removal_proposals`, `admin_removal_votes`, `pets`, `suggestions`, `suggestion_comments`, `doodle_scores`, `portal-2d`, `portal2d_demos`, `wikipedia`, and `github_changelog_cache`. Public and DM messages have optional `reply_to_id` references. It also adds encrypted credential columns to `users`. |
| [`database.js`](database.js) | PostgreSQL pool selection, single-provider mode, dual Neon/Layerbase coordinator, write-ahead journal, replication, baseline checks, recovery, and authenticated remote coordinator client. |
| [`test/database.test.js`](test/database.test.js) | Database configuration and replication tests. Real provider tests require the dedicated `TEST_NEON_DB_URL` and `TEST_LB_DB_URL` environment variables described in `hosting.md`. |

### Hosting adapters

| File | Purpose |
| --- | --- |
| [`netlify.toml`](netlify.toml) | Publishes `static/`, configures the Functions bundler, and sends dynamic requests to the Express function. |
| [`netlify/functions/server.mjs`](netlify/functions/server.mjs) | Adapts the Express app to Netlify Functions and awaits database initialization. |
| [`netlify/edge-functions/render-websocket.ts`](netlify/edge-functions/render-websocket.ts) | Rewrites `common.js` on Netlify so live WebSocket traffic connects to the Render deployment. |
| [`hosting.md`](hosting.md) | Local setup, environment variables, database failover/coordinator operation, hosting notes, and test instructions. Do not put real secrets in this tracked guide. |
| [`run.sh`](run.sh) *(local/ignored)* | Local server launcher and environment setup. It is ignored by Git because it may contain local credentials; document variable names in `hosting.md`, never its secret values. |

## Repository and site metadata

| File | Purpose |
| --- | --- |
| [`README.md`](README.md) | Project overview, usage, team/credits, and links to this map and the hosting guide. |
| [`package.json`](package.json) | Node package metadata, dependencies, and `npm test` script. |
| [`package-lock.json`](package-lock.json) | Locked dependency tree for repeatable installs. |
| [`.gitignore`](.gitignore) | Excludes local secrets, logs, dependencies, runtime data, and local `run.sh`. |
| [`.gitattributes`](.gitattributes) | Git text/binary and line-ending handling. |
| [`CNAME`](CNAME) | Custom domain metadata for static-site hosting. |
| [`site.webmanifest`](site.webmanifest) | Installable-site name, icons, and browser theme metadata. |
| [`kindle-browser-quirk-system.skill`](kindle-browser-quirk-system.skill) | Packaged Kindle browser compatibility reference. |

## Hosting and data flow at a glance

1. A browser loads an app page from `static/` and `common.js` configures its HTTP and WebSocket destinations.
2. HTTP requests reach the Express app in `index.js` (directly on a persistent host or through the Netlify Function adapter).
3. Database operations use the interface created by `database.js`; schema and backfills come from `database-schema.js`.
4. Live social features use the root WebSocket on a persistent server. Netlify's edge function rewrites the browser WebSocket URL to Render.
5. External integrations include GitHub, Fandom, Wikipedia, LRCLIB, PokéAPI, Microsoft OAuth, Cloudflare Workers AI, and user-selected IRC networks. Check the relevant page and server route before changing an integration.

## Maintenance note

Update this map when adding, removing, or renaming an app, shared resource, API group, database table, or hosting adapter. It describes the repository layout; it does not replace the implementation or promise that every listed upstream service is currently available.
