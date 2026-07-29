<!-- Running cookd anywhere. The vhtm.eu runbook is in deploy/README.md. -->

# Deploying

One process serves everything:

```bash
bun install
bun run build          # produces dist/
PORT=8080 bun run serve
```

`server/index.ts` serves `dist/` and the game socket from the same origin, so
there is no CORS, no second host and no separate static bucket. Put it behind
TLS (Caddy, nginx, a tunnel — anything that upgrades websockets) and point a
domain at it.

- `PORT` — listen port (default 5273).
- `COOKD_SAVE_DIR` — where room saves are written (default `./saves`).
- `GET /health` — room and client counts, and two load signals: `behind`
  (ticks a room could not keep up with) and `dropped` (frames skipped for a
  backed-up socket). Deliberately **not** room codes — see the note at the
  bottom of this file.

Unknown paths fall back to `index.html`, so `/#KITCHEN` links work on a cold
load. A single instance is a single point of failure, which is fine at this size as
long as it restarts: saves are on disk and a room reloads itself when the first
player rejoins. It is also a deliberate ceiling — rooms live in a module-level
`Map` and saves are local files, so a second instance would need room-to-node
routing and shared storage. `MAX_ROOMS` caps it at 200; `/health` reports the
numbers that would say the box is filling up.

In Docker:

```bash
docker compose up -d --build
```

**Mount a volume at the save directory.** Every deploy rebuilds the container,
and without one each push silently resets everyone's kitchen — the single most
important line in `docker-compose.yml`.

The live deployment is `cookd.vhtm.eu`; its runbook, ports and first-time setup
are in [`deploy/README.md`](../deploy/README.md).

**A room code is the only thing standing between a stranger and your
kitchen**, and anyone in a room can reset it. Codes are four characters from an
unambiguous alphabet; treat a shared link like a shared document.

Two things narrow that: `/health` does not list live room codes, so codes
cannot be harvested, and every connection has a message budget, so `reset` —
which rebuilds a world, broadcasts a layout and writes to disk — cannot be sent
in a loop. Neither is authentication. If a kitchen ever needs to be genuinely
private, that is a decision about what a room *is*, not a patch to this file.

---

Next:

- [multiplayer.md](multiplayer.md) — what is being deployed
- [../deploy/README.md](../deploy/README.md) — the cookd.vhtm.eu runbook

[Back to the README](../README.md).
