// Stashed drafts („Odložené“): account data `sk.karchi.stash`, shared by every window and device and by `weft`.
// { items: [{ id, room, body, files?, at, pos, by?, relay?, from? }], gone: { [item id]: ms when removed } }
// Only two operations exist, and both can be checked in any copy: add an item, remove an item (a tombstone in
// `gone`). Editing or moving is a new item plus removing the old one; two windows editing the same item give two
// items (both `from` the same id: both versions show). Applying an operation twice changes nothing, so a window
// may apply its operations again to whatever the server holds until it sees them there; no write can undo another.
export const STASH = 'sk.karchi.stash';
export const GONE_MS = 30 * 864e5; // tombstones kept this long; agent drafts older than this are never taken in

/** Whether `op` shows in `state` (an add whose item is there or already removed, a removal that is there). */
export function stashHas(state, op) {
  const gone = state?.gone || {};
  if (op.op === 'add') return op.item.id in gone || !!state?.items?.some((it) => it.id === op.item.id);
  return op.id in gone && !state?.items?.some((it) => it.id === op.id);
}

/** The stash after `ops`, for any state (a missing or malformed one is empty). */
export function applyStash(state, ops, now = Date.now()) {
  const gone = {};
  for (const [id, ts] of Object.entries(state?.gone && typeof state.gone === 'object' ? state.gone : {})) {
    if (typeof ts === 'number' && now - ts < GONE_MS) gone[id] = ts;
  }
  let items = Array.isArray(state?.items) ? state.items.filter((it) => it && typeof it.id === 'string' && typeof it.room === 'string') : [];
  for (const op of ops) {
    if (op.op === 'add' && !(op.item.id in gone) && !items.some((it) => it.id === op.item.id)) items = [...items, op.item];
    else if (op.op === 'del' && !(op.id in gone)) gone[op.id] = op.at || now;
  }
  return { items: items.filter((it) => !(it.id in gone)), gone };
}

/** A chat's stash (several rooms for a merged chat), on top what was stashed last or moved up. */
export function stashOf(state, rooms) {
  const set = new Set(rooms);
  const items = (state?.items || []).filter((it) => set.has(it.room));
  // Versions made from the same item at once (two windows edited it): each says there is another.
  const from = new Map();
  for (const it of items) if (it.from) from.set(it.from, (from.get(it.from) || 0) + 1);
  return items.map((it) => (it.from && from.get(it.from) > 1 ? { ...it, twin: true } : it))
    .sort((a, b) => (b.pos ?? b.at ?? 0) - (a.pos ?? a.at ?? 0) || (a.id < b.id ? -1 : 1));
}
