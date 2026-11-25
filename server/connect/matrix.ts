// The homeserver as the appservice sees it: the bot and the ghosts act with the appservice's token, Karchi himself
// (joining a new chat, reading old items) with the double puppet's.

export class MatrixError extends Error {
  constructor(readonly status: number, readonly errcode: string, message: string) {
    super(`${status} ${errcode} ${message}`);
  }
}

type Query = Record<string, string | number>;

export class Matrix {
  constructor(
    readonly homeserver: string,
    readonly asToken: string,
    readonly puppetToken: string,
    readonly admin: string, // Karchi's Matrix id
    readonly bot: string,
  ) {}

  get server() {
    return this.admin.slice(this.admin.indexOf(':') + 1);
  }

  /** user: who acts (the bot by default; null for /register, which takes no user_id). */
  async call(method: string, path: string, body?: unknown, opts: { user?: string | null; query?: Query } = {}) {
    const user = opts.user === undefined ? this.bot : opts.user;
    const params = new URLSearchParams(Object.entries({ ...(user ? { user_id: user } : {}), ...opts.query }).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${this.homeserver}/_matrix/client/v3${path}${params.size ? `?${params}` : ''}`, {
      method,
      headers: { Authorization: `Bearer ${user === this.admin ? this.puppetToken : this.asToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const data: Record<string, unknown> = await res.json().catch(() => ({}));
    if (!res.ok) throw new MatrixError(res.status, String(data.errcode ?? ''), String(data.error ?? ''));
    return data;
  }

  /** The Matrix id an owner token belongs to (Weft's requests to /_connect/ carry Karchi's token). */
  async whoami(token: string) {
    const res = await fetch(`${this.homeserver}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return '';
    const data: { user_id?: unknown } = await res.json();
    return typeof data.user_id === 'string' ? data.user_id : '';
  }
}

/** A token from an appservice registration file (as_token, hs_token). */
export function registrationToken(yaml: string, key: string) {
  const found = yaml.match(new RegExp(`^${key}:\\s*['"]?([^'"\\s]+)`, 'm'))?.[1];
  if (!found) throw new Error(`no ${key} in the registration`);
  return found;
}
