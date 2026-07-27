# Deploying cookd

Runbook for `cookd.vhtm.eu` on the `vhtm-eu` VM. Conventions come from
[`Jason-vh/vhtm.eu`](https://github.com/Jason-vh/vhtm.eu); this file only covers
what is specific to cookd.

| | |
| --- | --- |
| Domain | `cookd.vhtm.eu` |
| VM port | `3010` |
| Deploy dir | `/home/exedev/apps/cookd` |
| Runner | `gh-actions-runner-cookd.service`, label `cookd-prod` |
| Compose project | `cookd` |
| Database | **none** |

## What makes cookd different from the other apps

**No Postgres.** The only persistent state is one small JSON file per kitchen,
written a few times a day. Being able to `cat` and `rm` a save is worth more
than any query ability we would use, so convention 4 (one DB per app) is
deliberately skipped — there is nothing to put in a database.

**State lives in a Docker volume,** `cookd-saves`, mounted at `/app/saves`. This
matters more than it looks: every deploy rebuilds the container, and without the
volume each push would silently reset everyone's kitchen. If you ever move the
app, move the volume.

**WebSockets.** The client and the game socket share one origin — Caddy's
`reverse_proxy` upgrades transparently, so the snippet is the same one line
every other app uses. The only untested link in the chain is exe.dev's edge; see
[smoke test](#smoke-test).

**One process, one instance.** The server holds every live kitchen in memory and
is deliberately not horizontally scalable. Restarting it drops everyone for a
moment; they reconnect, and the layout is restored from disk. Anyone mid-day
loses that day's progress, not their kitchen.

## First-time setup

1. **Port** — `3010`, already added to the
   [inventory](https://github.com/Jason-vh/vhtm.eu/blob/main/apps/README.md).
2. **DNS** — at Porkbun: `cookd.vhtm.eu CNAME vhtm-eu.exe.xyz`, then register
   with the edge:
   ```bash
   ssh exe.dev domain add vhtm-eu cookd.vhtm.eu
   ```
3. **Runner** — on the VM as `exedev`, follow
   [infra/README.md](https://github.com/Jason-vh/vhtm.eu/blob/main/infra/README.md#adding-a-new-runner)
   with `<repo>` = `cookd`, label `cookd-prod`.
4. **Secrets** — none. cookd has no database and no API keys.
5. Push to `main`.

## Smoke test

```bash
# On the VM: is the container serving?
curl -s localhost:3010/health

# From anywhere: does the edge pass a WebSocket upgrade through?
curl -isS -o /dev/null -w '%{http_code}\n' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://cookd.vhtm.eu/ws
```

A `101` means the upgrade went through end to end. Anything else (`200`, `400`,
`502`) means something in the chain is terminating the upgrade — check Caddy
first, then the edge. **If the edge does not pass WebSockets, that is the one
thing that would block this deployment**, and it is worth testing before
anything else.

Then open <https://cookd.vhtm.eu>, join a kitchen, and open the same link in a
second browser.

## Health

`GET /health` returns live rooms:

```json
{ "ok": true, "rooms": [{ "code": "MAIN", "players": 3, "clients": 2, "day": 4 }] }
```

## Debugging

```bash
cd /home/exedev/apps/cookd
docker compose --env-file .env.production logs -f --tail=100
docker compose --env-file .env.production ps
docker compose --env-file .env.production restart

# Saved kitchens
docker run --rm -v cookd_cookd-saves:/s alpine ls -la /s
docker run --rm -v cookd_cookd-saves:/s alpine cat /s/MAIN.json

# Wipe one kitchen (players get the default layout back next join)
docker run --rm -v cookd_cookd-saves:/s alpine rm /s/MAIN.json
```

The volume is namespaced by the compose project, hence `cookd_cookd-saves`.

## Rollback

There are no migrations and no schema, so rollback is just an older image:

```bash
cd /home/exedev/apps/cookd
git checkout <previous-sha>
docker compose --env-file .env.production up -d --build
```

Saves are forward- and backward-compatible within a `schema` version; if the
level layout changes, old saves are discarded on load by design rather than
restoring appliances into a kitchen that moved around them.
