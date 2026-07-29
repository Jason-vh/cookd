# Deploying cookd

Runbook for `cookd.vhtm.eu`, which runs alone on the `cookd` exe.dev VM in
Frankfurt.

| | |
| --- | --- |
| Domain | `cookd.vhtm.eu` (CNAME → `cookd.exe.xyz`) |
| VM | `cookd`, region `fra` |
| VM port | `3010` |
| Deploy dir | `/home/exedev/cookd` |
| Runner | `gh-actions-runner-cookd.service`, label `cookd-prod` |
| Compose project | `cookd` |
| Database | **none** |

## Why its own VM

cookd used to share the `vhtm-eu` box with eight other apps. That box is in
Los Angeles, and cookd is the only thing on it where a round trip is felt
rather than measured: every keystroke is a simulation input, and prediction can
hide latency only up to a point. Frankfurt is roughly 150 ms closer for the
people who actually play it.

Having the VM to itself removes most of the vhtm.eu apparatus. There is no
shared Caddy, so no `deploy/caddy.snippet` and no host matching — the exe.dev
proxy forwards straight to the container. There is no port inventory, so `3010`
is just a number both ends agree on. There is no shared Postgres, so no
`apps-net`. What is left is a Dockerfile, a compose file and a workflow.

**The container must not bind loopback.** The exe.dev proxy reaches the VM over
`eth0`, not from inside it, so `127.0.0.1:3010:3000` — correct on the shared box,
where Caddy was the only client — answers nothing here. This is the one line
that does not survive the move unchanged.

## What makes cookd different from the other apps

**No Postgres.** The only persistent state is one small JSON file per kitchen,
written a few times a day. Being able to `cat` and `rm` a save is worth more
than any query ability we would use, so there is nothing to put in a database.

**State lives in a Docker volume,** `cookd-saves`, mounted at `/app/saves`. This
matters more than it looks: every deploy rebuilds the container, and without the
volume each push would silently reset everyone's kitchen. If you ever move the
app, move the volume.

**WebSockets.** The client and the game socket share one origin, and the exe.dev
edge passes the upgrade through untouched — verified end to end, see
[smoke test](#smoke-test).

**One process, one instance.** The server holds every live kitchen in memory and
is deliberately not horizontally scalable. Restarting it drops everyone for a
moment; they reconnect, and the layout is restored from disk. Anyone mid-day
loses that day's progress, not their kitchen.

## First-time setup

1. **VM** — `ssh exe.dev new --name=cookd`, with the account region set to
   `fra` (`ssh exe.dev set-region fra`). Regions are per account, so this only
   works if new VMs are meant to land in Frankfurt.
2. **Proxy** — point it at the app port and open it up:
   ```bash
   ssh exe.dev share port cookd 3010
   ssh exe.dev share set-public cookd   # otherwise visitors get an exe.dev login
   ```
3. **DNS** — at Porkbun: `cookd.vhtm.eu CNAME cookd.exe.xyz`, then register with
   the edge once DNS resolves:
   ```bash
   ssh exe.dev domain add cookd cookd.vhtm.eu
   ```
   A domain can only be registered on one VM, so remove it from the old one
   first. Until it is registered the edge answers `421 Misdirected Request`.
4. **Runner** — on the VM as `exedev`, install a self-hosted runner for this
   repo labeled `cookd-prod`, as `gh-actions-runner-cookd.service`.
5. **Secrets** — none. cookd has no database and no API keys.
6. Push to `main`.

If SSH to the VM says *"Please complete registration by running: ssh exe.dev"*
while `ssh exe.dev` itself works, your agent is offering the wrong key. Pin the
identity for the VMs too:

```
Host exe.dev *.exe.xyz
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
```

## Smoke test

```bash
# On the VM: is the container serving?
curl -s localhost:3010/health

# From anywhere: does the edge pass a WebSocket upgrade through?
curl -isS --http1.1 \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://cookd.vhtm.eu/ws
```

`--http1.1` is not optional. HTTP/2 has no `Upgrade:` mechanism, so curl
negotiates h2, the headers are ignored, and you get a perfectly healthy-looking
`200` that proves nothing. A `101` means the upgrade went through end to end.
Anything else means something in the chain is terminating it.

Then open <https://cookd.vhtm.eu>, join a kitchen, and open the same link in a
second browser.

## Health

`GET /health` returns counts, deliberately not room codes:

```json
{ "ok": true, "rooms": 1, "maxRooms": 200, "clients": 0, "behind": 0, "dropped": 0 }
```

## Debugging

```bash
cd /home/exedev/cookd
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

## Moving the saves to another box

The only state, and the only step of a migration that cannot be redone:

```bash
# on the old VM
docker run --rm -v cookd_cookd-saves:/s -v /tmp:/b alpine tar czf /b/saves.tgz -C /s .
# via your workstation
scp old.exe.xyz:/tmp/saves.tgz . && scp saves.tgz new.exe.xyz:/tmp/
# on the new VM, once the first deploy has created the volume
docker run --rm -v cookd_cookd-saves:/s -v /tmp:/b alpine tar xzf /b/saves.tgz -C /s
```

## Rollback

There are no migrations and no schema, so rollback is just an older image:

```bash
cd /home/exedev/cookd
git checkout <previous-sha>
docker compose --env-file .env.production up -d --build
```

Saves are forward- and backward-compatible within a `schema` version; if the
level layout changes, old saves are discarded on load by design rather than
restoring appliances into a kitchen that moved around them.
