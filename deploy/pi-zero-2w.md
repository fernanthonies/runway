# Deploying Runway to a Raspberry Pi Zero 2 W

Native systemd deploy, no Docker. Sized for a 512 MB Zero 2 W already running
Pi-hole.

Why not Docker here: dockerd + containerd idle at 60–90 MB RSS, which is real
money against 512 MB, and this app buys almost nothing from containers — two
pip dependencies, both prebuilt wheels, and no build step. Running natively
also means frontend changes deploy with a `git pull` instead of an image
rebuild. If Pi-hole is *already* containerized on this Pi, the daemon is a sunk
cost and `docker compose up -d --build` is the simpler choice instead.

## 0. Prerequisites

Use **64-bit Pi OS Lite**. Two reasons:

- Desktop (LXDE) would eat most of the free RAM on its own.
- On arm64, `pip install` gets prebuilt wheels for `pydantic-core`, `uvloop`,
  and `httptools`. On 32-bit Pi OS (`armv7l`) wheel coverage is spottier and
  pip may fall back to compiling Rust from source — slow, and liable to OOM.

Set the timezone first, because it drives the budget math:

```bash
sudo raspi-config nonint do_change_timezone America/New_York
timedatectl        # confirm
```

The weekly window is "most recent Sunday through Saturday" and the monthly
window is the current calendar month, both derived from the system clock at
request time. Wrong timezone means the resets happen at the wrong midnight.

## 1. Install

```bash
sudo apt update
sudo apt install -y git python3-venv

git clone https://github.com/fernanthonies/runway.git ~/runway
cd ~/runway

python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt
```

Pi OS Bookworm ships Python 3.11 and Trixie ships 3.13; either satisfies the
3.10+ `X | None` syntax used throughout, so the system Python is fine.

Bookworm enforces PEP 668 (`externally-managed-environment`), which is why the
venv is mandatory rather than optional — don't `pip install` globally.

## 2. Install the service

The unit ships with `pi` hardcoded in four places, which is almost certainly
wrong for you: Pi OS Bookworm and later dropped the default `pi` account in
favour of a user you name at imaging time. Patch it after copying rather than
editing by hand:

```bash
sudo cp ~/runway/deploy/runway.service /etc/systemd/system/runway.service
sudo sed -i "s|^User=pi$|User=$USER|; s|^Group=pi$|Group=$(id -gn)|; s|/home/pi/runway|$HOME/runway|g" /etc/systemd/system/runway.service

# confirm before enabling
grep -E '^(User|Group|WorkingDirectory|ExecStart)=' /etc/systemd/system/runway.service

sudo systemctl daemon-reload
sudo systemctl enable --now runway
```

The shell expands `$USER`, `$HOME`, and `id -gn` before `sudo` runs, so they
resolve to your account rather than root's.

## 3. Verify

```bash
systemctl status runway
curl -s localhost:8100/api/summary
```

`/api/summary` returning JSON means the DB was created and the budget math
runs. Then open `http://<pi-ip>:8100` from another machine on the LAN, click
the gear, and set the monthly budget.

Port 8100 is free on the Pi — Pi-hole's admin UI owns :80 and pihole-FTL owns
:53. 8100 just keeps the URL identical to the Docker setup on the Mac.

Optional nicety: add a Pi-hole local DNS record (`runway.lan` → the Pi's IP)
so you can use `http://runway.lan:8100`.

## 4. Updating

```bash
cd ~/runway
git pull
.venv/bin/pip install -r requirements.txt   # only if requirements changed
sudo systemctl restart runway
```

Frontend-only changes (`static/*.js`, `static/*.css`) need **no restart** —
uvicorn serves `static/` off disk, unlike the Docker image where assets are
baked in at build time. A browser refresh is enough; `RevalidatingStaticFiles`
sends `Cache-Control: no-cache` so the browser revalidates rather than serving
a stale `app.js`.

## 5. Back up the database

`data/budget.db` lives on the SD card, and `data/backups/` (the snapshots
`POST /api/reset` writes) sits right beside it. SD cards fail, and nothing in
the app prunes or replicates either. Copy them off the Pi on a schedule.

Use SQLite's backup command rather than `cp` — it's consistent even if a write
lands mid-copy:

```bash
# On the Pi, into a staging file:
sqlite3 ~/runway/data/budget.db ".backup /tmp/budget-backup.db"

# Then pull it to another machine (substitute your Pi username):
rsync <user>@<pi-ip>:/tmp/budget-backup.db ~/backups/runway/budget-$(date +%F).db
```

Requires `sudo apt install sqlite3` (the CLI is separate from Python's
`sqlite3` module). Wire it to a cron job or systemd timer once you're happy
with it.

## Logs

```bash
journalctl -u runway -f
```

Every request writes an access-log line to journald, i.e. to the SD card. At
single-user traffic that's negligible, but if you'd rather cut the writes,
append `--no-access-log` to `ExecStart=` and reload.
