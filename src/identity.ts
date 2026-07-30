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
  /**
   * Sound off. Belongs to the *person*, not the kitchen: four players sharing
   * a room do not share a pair of headphones, and one of them muting the game
   * on everybody else's screen would be a strange thing for a mute button to do.
   */
  muted: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function newToken(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const FALLBACK: Identity = { name: "", token: "", room: "", muted: false };

export function loadIdentity(): Identity {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...FALLBACK, token: newToken() };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...FALLBACK, token: newToken() };
    // Field by field, because this is another machine's data as far as we are
    // concerned: it was written by a version of the game we may not be.
    const fields = parsed;
    return {
      name: typeof fields.name === "string" ? fields.name.slice(0, 16) : "",
      token: typeof fields.token === "string" && fields.token ? fields.token : newToken(),
      room: typeof fields.room === "string" ? fields.room : "",
      muted: fields.muted === true,
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
