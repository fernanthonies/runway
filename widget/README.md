# Runway iOS widget

A home- and lock-screen widget showing what's left this week and this month.
It runs inside [Scriptable](https://apps.apple.com/app/scriptable/id1405459188)
(free), so there's no Xcode project, no Apple developer account, and no signing
that expires.

`runway-widget.js` reads `GET /api/widget` and renders it. That endpoint exists
so the widget doesn't have to reimplement the mint/amber/red thresholds — the
state ships with the numbers (`state_for()` in `main.py`, the server-side twin
of `stateClass()` in `static/app.js`; change one and change the other).

## Install

1. Install Scriptable from the App Store.
2. Set `HOST` at the top of `runway-widget.js` to your Runway address. It
   currently points at `http://192.168.1.172:8100` (the Mac mini). For the Pi
   deploy it's `http://<pi-ip>:8100`, or `http://runway.lan:8100` if you added
   the Pi-hole DNS record.
3. Get the script onto the phone — easiest is to open Scriptable, tap **+**,
   and paste the file contents. Name it **Runway**.
4. Run it once inside Scriptable. iOS will ask for **Local Network** permission;
   allow it, or every fetch fails silently from then on. You should see a
   preview of the medium layout.
5. Long-press the home screen → **+** → **Scriptable** → pick a size → add it.
   Then tap the placed widget and set **Script** to *Runway* and
   **When Interacting** to *Run Script* (or *Open URL* if you'd rather it open
   the web UI).

For the lock screen: long-press the lock screen → **Customize** → tap a widget
slot → **Scriptable**. The rectangular slot is the useful one.

## What each size shows

| Family | Shows |
|---|---|
| `small` | Week remaining + meter, month remaining, timestamp |
| `medium` | Both windows with meters and `spent of allowance`, timestamp |
| `accessoryRectangular` | Week and month on two lines (lock screen) |
| `accessoryCircular` | Week remaining, whole dollars |
| `accessoryInline` | Week remaining, beside the clock |

Lock screen widgets are rendered monochrome by iOS, so the state is carried by
text there rather than by color.

## Offline behaviour

Runway is LAN-only, so off the home network the fetch fails. The widget then
draws the last payload it successfully fetched, drops the background tint, and
labels the footer `offline · <time>` in amber. If it has never fetched
successfully there's no cache, and it says so instead of showing a stale zero.

The cache is a single JSON file in Scriptable's library directory.

## Troubleshooting

The widget names the failure rather than blaming the network for everything:

| On the widget | Means |
|---|---|
| `Server said 404` | Runway is running but has no `/api/widget` route — the image predates it. `docker compose up -d --build` (a plain `restart` won't do it; code is baked into the image). |
| `Server said 5xx` | The route exists and threw. Check `docker compose logs`. |
| `Runway unreachable` | Nothing answered: wrong `HOST`, off the LAN, server down, or Local Network permission was never granted to Scriptable. |
| `offline · <time>` in the footer | Normal — showing the last good numbers because this fetch failed. |

Check the server from a Mac on the same network before suspecting the phone:

```bash
curl -s http://<host>:8100/api/widget
```

If that returns JSON and the phone still can't reach it, it's the phone side —
open Scriptable and run the script directly, which surfaces the real error and
re-triggers the Local Network prompt.

## Refresh cadence

`refreshAfterDate` asks for a reload every 15 minutes, but **iOS decides** — a
widget gets a budget of roughly a few dozen refreshes a day, and the system
throttles by battery and usage. A transaction you log at 2pm may not appear for
a while. That's inherent to WidgetKit, not something the endpoint can fix,
which is why the timestamp is always on the face of the widget.

## Testing changes without a phone

`main.py` can be exercised directly:

```bash
cp data/budget.db /tmp/probe.db
BUDGET_DB=/tmp/probe.db .venv/bin/uvicorn main:app --port 8123
curl -s localhost:8123/api/widget
```

Vary `PUT /api/settings` `monthly_budget` to push the windows through the four
states — `ok`, `low` (≤20% left), `neg`, and `unset` (budget is 0).

The Scriptable script itself is plain JS against a small API surface
(`ListWidget`, `DrawContext`, `Request`, `FileManager`), so it can be run under
node with those globals stubbed if you want to check layout logic before
copying it over.
