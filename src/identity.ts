/**
 * What this *browser* remembers about the person using it.
 *
 * The kitchen itself moved to the server the moment the game became multiplayer
 * — a layout kept per-browser would mean four players each holding a different
 * opinion about where the oven is. What is genuinely per-person stays here:
 * your name today, your appearance and control preferences later.
 *
 * localStorage rather than IndexedDB: this is a handful of short strings read
 * once at startup, and the synchronous API means the join screen has nothing to
 * wait for.
 */

const KEY = "cookd.identity";

export type Identity = {
  name: string;
  /**
   * Stable per browser, so a dropped connection can reclaim the same chef
   * rather than arriving as a stranger. Not a credential — it identifies a
   * seat, not a person, and the worst it can do is take back your own cook.
   */
  token: string;
  /** Last room joined, so a bare URL returns you to your friends. */
  room: string;
};

function newToken(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const FALLBACK: Identity = { name: "", token: "", room: "" };

export function loadIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...FALLBACK, token: newToken() };
    const parsed = JSON.parse(raw) as Partial<Identity>;
    return {
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 16) : "",
      token: typeof parsed.token === "string" && parsed.token ? parsed.token : newToken(),
      room: typeof parsed.room === "string" ? parsed.room : "",
    };
  } catch {
    // Private browsing, disabled storage, corrupt value: play as a stranger
    // rather than refusing to start.
    // Private browsing or disabled storage: a token that lasts as long as the
    // tab still lets a reconnect inside that tab reclaim its chef.
    return { ...FALLBACK, token: newToken() };
  }
}

export function saveIdentity(identity: Identity): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    /* not worth interrupting play for */
  }
}
