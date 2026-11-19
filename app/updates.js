// A window compares the release it actually loaded, including an offline start, with the server.
export const loadedRelease = (url) => new URL(url).pathname.match(/^\/releases\/([a-f0-9]{20})\//)?.[1] || '';
export function createUpdates({ url, request = fetch, ready, changed, reload }) {
  const loaded = loadedRelease(url);
  let available = false, next = '', checking = null;
  function check() {
    if (checking) return checking;
    checking = (async () => {
      try {
        const response = await request('/release.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) return;
        const doc = await response.json();
        next = /^[a-f0-9]{20}$/.test(doc.id) ? doc.id : '';
        available = !!next && next !== loaded;
        changed(available);
      } catch { /* Offline keeps the loaded release and any known update. */ }
      finally { checking = null; }
    })();
    return checking;
  }
  function apply() { if (available && ready()) { reload(next); return true; } return false; }
  return { check, apply };
}
