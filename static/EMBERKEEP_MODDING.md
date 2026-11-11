# Emberkeep Modding Guide

This copy of Emberkeep (extracted from KindleHub, run standalone) ships with a
full mod loader. Mods can change building and troop stats, add rules, run
timers, and inject their own UI. Everything is saved locally in your browser —
no server involved.

---

## Table of contents

1. [Quick start](#quick-start)
2. [How mods are stored](#how-mods-are-stored)
3. [Anatomy of a mod](#anatomy-of-a-mod)
4. [The `api` object](#the-api-object)
5. [Hooks](#hooks)
6. [Patches: building & troop stats](#patches-building--troop-stats)
7. [Events](#events)
8. [The game state](#the-game-state)
9. [Writing UI](#writing-ui)
10. [Example mods](#example-mods)
11. [Limitations](#limitations)

---

## Quick start

1. Open `Emberkeep.html` in Chrome or Firefox (over HTTP if you want live PvP).
2. On the menu, press **Mods**.
3. Press **New mod**, paste one of the [examples](#example-mods), and save.
4. Press **Play** (as guest or signed in). The mod takes effect the next time
   the game opens.

Each mod has an **enabled** toggle. Disabling a mod and reopening the game
restores the original behaviour for the parts that mod touched.

## How mods are stored

Mods live in `localStorage` under the key `kh_emberkeep_mods_v1` as a JSON
array. Each entry looks like:

```json
{
  "id": "m1",
  "name": "Cheap mines",
  "description": "Gold mines cost 1",
  "version": "1.0",
  "enabled": true,
  "code": "function(api){ api.onStart(function(){ api.buildings.mine.cost = function(){ return 1; }; }); }"
}
```

You normally never edit this JSON by hand — the in-app **Mods** manager does it.
But because it is plain JSON, you can back it up or copy mods between browsers.

## Anatomy of a mod

A mod is a JavaScript **factory function** that receives the `api` object:

```js
function(api) {
  // Runs once when the game opens. Register hooks / apply patches here.
  api.onStart(function() {
    // Runs every time the game starts (after the base is built).
  });
}
```

The factory is called with `new Function('api', code)` at game start. Keep it a
single function expression. Anything it returns is ignored; you interact with
the game through `api`.

## The `api` object

`api` is passed to every mod factory. It has:

| Property | Type | What it is |
|---|---|---|
| `api.S` | object | The global save/state object (`S`). |
| `api.state()` | object | Live Emberkeep state (`b`). Mutable — see [game state](#the-game-state). |
| `api.dbg()` | object | `Stronghold._dbg()`, the game's full debug API. |
| `api.buildings` | object | Live building definition table. See [patches](#patches-building--troop-stats). |
| `api.troops` | object | Live troop definition table. |
| `api.heroes` | object | Live hero definition table. |
| `api.spells` | object | Live spell definition table. |
| `api.onStart(fn)` | fn | Register a hook that runs when the game starts. |
| `api.onTick(fn)` | fn | Register a hook that runs ~once a second while the game is open. |
| `api.onStop(fn)` | fn | Register a hook that runs when you leave the game. |
| `api.onScreen(fn)` | fn | Register a hook that runs after each screen render. |
| `api.toast(msg, ms)` | fn | Show a toast notification. |
| `api.save()` | fn | Persist the current state immediately. |
| `api.confirm(msg)` | Promise<bool> | Ask the player Yes/No. |
| `api.log(...args)` | fn | `console.log` prefixed with the mod name. |
| `api.give(gold, elixir, dark, gems)` | fn | Add resources to the current base. |
| `api.addButton(label, fn)` | fn | Add a button to the base screen. |

### `api.buildings`, `api.troops`, `api.heroes`, `api.spells`

These are **live references** to the game's definition tables. Changing a value
here takes effect immediately and is what 90% of mods do. The tables are only
available after the game has started, so access them inside `onStart` (or later).

## Hooks

| Hook | When it runs |
|---|---|
| `api.onStart(fn)` | After the base is created / loaded, before the first screen draws. |
| `api.onTick(fn)` | About once per second, while the game is open. Good for timers, regen, automation. |
| `api.onStop(fn)` | When you leave the game (Back button). |
| `api.onScreen(fn)` | After every screen render. `api.dbg().screen()` tells you which one. |

### Hook helper functions

```js
api.onStart(function() {
  api.toast("Hello from my mod!", 3000);
});

api.onTick(function() {
  // +10 gold every second
  var s = api.state();
  s.gold = (s.gold || 0) + 10;
  api.save();
});

api.onScreen(function() {
  var scr = api.dbg().screen();
  if (scr === "army") console.log("on the army screen");
});
```

## Patches: building & troop stats

Every stat is a plain property or a function of level. You can assign either.

### Building table

Keys: `keep`, `mine`, `well`, `vault`, `tank`, `cannon`, `tower`, `mortar`,
`wall`, `barracks`, `camp`, `drill`, `dvault`, `hut`, `ballista`, `vent`,
`bastion`, `xbow`, `lab`.

Common fields:
- `n` — display name
- `cost(lv)` — gold cost at level `lv`
- `build(lv)` — build time in ms at level `lv`
- `hp(lv)` — hit points at level `lv`
- `cat` — `"core" | "econ" | "def" | "army"`
- `max` — max levels
- Economy: `rate(lv)` (income), `res` (`"gold" | "elix" | "dark"`), `cap(lv)` (storage)
- Defence: `dmg(lv)`, `rng`, `splash`
- `minKeep` — minimum Keep level required

```js
api.onStart(function() {
  var b = api.buildings;

  // Mines produce 10x faster
  b.mine.rate = function(lv) { return 900 * lv; };

  // Walls are free
  b.wall.cost = function() { return 0; };

  // Cannon hits harder
  b.cannon.dmg = function(lv) { return 40 + 20 * lv; };

  // Everything builds instantly
  b.mine.build = b.cannon.build = b.keep.build = function() { return 0; };
});
```

### Troop table

Keys: `grunt`, `archer`, `ram`, `sapper`, `giant`, `raider`, `bomber`,
`healer`, `knight`, `hunter`, `wraith`, `fencer`, `bulwark`.

Fields: `n` (name), `cost` (elixir), `train` (ms), `hp`, `dmg`, `pref`
(`null | "wall" | "def" | "econ"`), `rng` (optional), `splash` (optional).

```js
api.onStart(function() {
  var t = api.troops;

  // Grunts are cheap and tanky
  t.grunt.cost = 1;
  t.grunt.hp = 5000;

  // A new troop? Yes — copy an existing one with a new key.
  t.megaGrunt = {
    n: "Mega Grunt",
    cost: 50,
    train: 8000,
    hp: 8000,
    dmg: 100,
    pref: null
  };
  // (Shows up in the Army screen because the game lists table keys.)
});
```

### Heroes

`api.heroes` is the hero-kind table. It follows the same shape as troops plus
`cost`, `hp(lv)`, `dmg(lv)`.

### Spells

`api.spells` holds spell definitions (`rage`, `heal`, `quake`). Fields: `n`,
`cost`, `dur`, `note` — the exact shape is whatever the game uses; inspect it
with `api.log(api.spells)`.

## Events

The loader fires named events through `api`:

```js
api.on("start", fn);    // same as onStart
api.on("tick", fn);     // same as onTick
api.on("stop", fn);     // same as onStop
api.on("screen", fn);   // same as onScreen
```

## The game state

`api.state()` returns the live Emberkeep state object (`b`). You can read and
write it freely. Common fields:

| Field | Meaning |
|---|---|
| `b.gold`, `b.elix`, `b.dark`, `b.gems` | Resources |
| `b.b` | Array of placed buildings `{t, lv, x, y}` |
| `b.army` | Object of troop counts `{grunt: 3, archer: 2, ...}` |
| `b.trophies` | League cups |
| `b.queue` | Build/train queue entries |
| `b.log` | Raid log |
| `b.shieldUntil` | Shield expiry timestamp |
| `b.hero` | Current hero `{lv, down}` |
| `b.tlv` | Troop research levels `{grunt: 1, ...}` |

Modify and call `api.save()`:

```js
api.onStart(function() {
  var s = api.state();
  s.gold = 1000000;
  s.elix = 1000000;
  s.army = s.army || {};
  s.army.megaGrunt = 10;
  api.save();
});
```

**Tip:** `api.dbg()` exposes helpers: `api.dbg().keepLv()`, `api.dbg().capOf(t)`,
`api.dbg().buildersFree()`, `api.dbg().armyCap()`, `api.dbg().armySize()`, and
many more. Explore it in the console: `Stronghold._dbg()`.

## Writing UI

`api.addButton(label, fn)` appends a button to the base screen:

```js
api.onStart(function() {
  api.addButton("🪙 +100k gold", function() {
    api.state().gold += 100000;
    api.save();
    api.toast("+100k gold", 2000);
  });
});
```

For richer UI, build DOM with the page's `el(tag, attrs, children)` and
`txt(tag, text, attrs)` helpers and append into `#immersiveContent`:

```js
api.onStart(function() {
  var box = el("div", {style: {
    margin: "8px 0", padding: "10px",
    border: "var(--border)", borderRadius: "10px",
    background: "var(--card)"
  }});
  box.appendChild(txt("div", "My mod panel", {style: {fontWeight: "800"}}));
  var btn = txt("button", "Double my gold", {className: "btn small"});
  btn.onclick = function() {
    api.state().gold *= 2;
    api.save();
  };
  box.appendChild(btn);
  document.getElementById("immersiveContent").appendChild(box);
});
```

## Example mods

### 1. Rich start

```js
function(api) {
  api.onStart(function() {
    var s = api.state();
    s.gold = 5000000;
    s.elix = 5000000;
    s.dark = 50000;
    s.gems = 1000;
    api.save();
    api.toast("5M of everything granted!", 3500);
  });
}
```

### 2. Hyper production

```js
function(api) {
  api.onStart(function() {
    var b = api.buildings;
    b.mine.rate = function(lv) { return 900 * lv; };
    b.well.rate = function(lv) { return 900 * lv; };
    b.drill.rate = function(lv) { return 60 * lv; };
    // and a 10% builder speed bonus
    b.hut.build = function(lv) { return 70000 * lv * 0.9; };
    api.toast("Hyper production on.", 2500);
  });
}
```

### 3. Passive income ticker

```js
function(api) {
  api.onTick(function() {
    var s = api.state();
    s.gold = (s.gold || 0) + 100;
    s.elix = (s.elix || 0) + 100;
    if ((s.gold % 10000) < 100) api.save();
  });
}
```

### 4. Infinite troops in camp

```js
function(api) {
  api.onStart(function() {
    api.buildings.camp.slots = function() { return 9999; };
  });
}
```

### 5. God grunt

```js
function(api) {
  api.onStart(function() {
    var t = api.troops.grunt;
    t.cost = 1;
    t.train = 1000;
    t.hp = 50000;
    t.dmg = 500;
    api.toast("God grunt armed.", 2000);
  });
}
```

### 6. Auto Grinder + Defender (built-in example)

This mod is included as a built-in example under **Load example**. It automates:
- **Auto-collect** — collects gold/elixir/dark from mines, tribute, defence bounties, and daily gems every second.
- **Auto-train** — keeps your army camps full with the configured troop composition. Queues training across all barracks.
- **Auto-raid** — on a configurable cooldown, finds the weakest real player base (if signed in) or a bot/boss base and raids it automatically.
- **Auto-defend** — upgrades defensive buildings (cannon, tower, mortar, wall, vent, ballista, bastion, xbow) in priority order, and places new defenses when you have room.

It adds an **Auto** button to the base screen. Click it to open the settings panel where you can toggle each feature on/off and choose the raid mode (Weakest / Boss / Practice).

The mod stores its settings in `api.S.khModAuto`, so they persist across game sessions.

## Limitations

- **Mods run in the page's own context.** A mod can break the game if it
  throws; the loader catches factory errors and shows which mod failed, and
  that mod is skipped.
- **Not sandboxed.** Mod code can do anything the page can (including your
  account). Only load mods you trust, exactly as with any user script.
- **Stat changes apply on game open.** Disabling a mod and reopening the game
  restores original values because the definitions are rebuilt from the bundle
  each launch. State you mutated (resources, army) stays unless you undo it.
- **Screen-specific UI** you inject will stay on the base screen; if the game
  re-renders that screen it is cleared. `onScreen` lets you re-inject.
- Live PvP/clans still need the online API; mods only affect your client.
