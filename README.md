# Un-Reader BBS

A retro, brutalist, e-ink style Bulletin Board System (BBS) designed for ultra-low latency, crisp legibility, and high modularity. Un-Reader provides a classic, text-heavy community experience optimized for standard browsers as well as low-refresh-rate devices like e-readers.

---

## Usage

go to: https://unreader-2lz0.onrender.com or https://unreader.netlify.app (More backups set up later.)

## Key Features

- **Unified Dashboard Portal**: The central entrypoint that handles authentication, live session tracking, and display preferences.
- **Chat Space**: Direct-message channels and public chats with instant profile popups.
- **Topic Rooms**: Dynamically categorized custom discussion tags.
- **Neighbourhood Forum**: Classic message board for structured posts and nested comment trees.
- **Moderation Console**: Admin search tools, system bans, timeouts, and live auditor activity logs.
- **Inline Mod Mode**: Dedicated float controls across Chat, Topics, and Neighbourhood allowing authorized moderators to purge/restore posts inline.
- **Display Adaptability**: Direct theme synchronization including Dark Mode, Bold High-Contrast, and Monospace Typography. (@SuprUsr123 rewired them back now, god that took so long to implement them back in)
- **Profile Picture Editor**: Draw or import custom profile pictures with a built-in editor.
- **Portal-Inspired 2D Platformer**: A mini-game that runs directly in the browser, complete with physics and level progression. (`portal-2d` table, `/api/portal2d/*`)

---

## App Architecture & File Mapping

- [index.html](index.html) - Homepage Dashboard Portal
- [chat.html](chat.html) - Messaging space (Public & DMs)
- [topics.html](topics.html) - Custom room directories
- [neighbourhood.html](neighbourhood.html) - Forum board & commentary
- [modmenu.html](modmenu.html) - Admin moderation console
- [mod-pfps.html](mod-pfps.html) - Profile picture moderation & management
- [profile-picture.html](profile-picture.html) - Profile picture editor (Draw or import)
- [rekindle.html](rekindle.html) - Shortcut to what made this all possible!
- [readium.html](readium.html) - Free advertising spot! I don't expect him to pay me back, just... it's a cool project.
- [suggestions.html](suggestions.html) - User feedback & feature requests
- [portal-2d.html](portal-2d.html) - Portal-inspired 2D platformer. (`portal-2d` table, `/api/portal2d/*`)
- [index.js](index.js) - Express & WebSocket PostgreSQL backend
- [github.htm](github.htm) - Cody's custom GitHub client optimized for Kindles
- [fandom.html](fandom.html) - A Fandom wiki reader for Kindles, with no ads or intrusive popups!
---

## Development Team

Brought to life by a small team of dedicated developers:

- **[tock-dev](https://github.com/tock-dev)**
- **[KodiGamingYT](https://github.com/KodiGamingYT)**
- **[SuprUsr124](https://github.com/SuprUsr123)**
---

## Ex-members:

- ~**[HackerAUG](https://github.com/HackerAUG)**~ Removed from dev team after some drama. He kinda just threatened us to delete the entire project.
---

## Credits

Special thanks and appreciation to:

- **[KodiGamingYT](https://github.com/KodiGamingYT)** — Designed and developed the updated homepage dashboard (`index.html`), introducing unified styling, preferences, and modular portal cards.
On another note, he added a streaming system (Not in use, but is being ported to Kindles). Worked on Dark Mode (Fixed by SuprUsr124) and a GitHub client.

- **[SuprUsr124](https://github.com/SuprUsr123)** — Beta Tester, Maintainer (tock almost left the site 4 dead, at least he got his mac back and fixed bugs) (oh that was mb sorry guys - tock), Oregon Trail (Kindle Web Port), Reversi (Kindle Web Port), Portal: The Kindle Version (a remake), Rewrote Pokedex, fixed Dark Mode, and very minor additions.


## HOW TO HOST YOUR OWN RELEASE
Visit [Hosting](hosting.md) to host your own version for testing.
