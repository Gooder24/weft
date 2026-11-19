<script>
  // The whole window. The logic (sync, bridges, inbox states, sending) is the old app's, in lib/core.js;
  // every change there calls render(), which bumps `tick`, and everything below recomputes from it.
  import { onMount } from 'svelte';
  import * as C from './lib/core.js';
  import { ui } from './lib/text.svelte.js';
  import Sidebar from './Sidebar.svelte';
  import Chat from './Chat.svelte';
  import Thread from './Thread.svelte';
  import Icon from './Icon.svelte';

  let tick = $state(0);
  onMount(() => {
    const off = C.onRender(() => tick++);
    C.boot();
    return off;
  });

  const view = $derived.by(() => {
    tick;
    if (C.S.view !== 'main') return { screen: C.S.view, error: C.S.error };
    let list = C.entries();
    let open = list.find((e) => e.key === C.S.selected) || null;
    if (open) {
      if (open.kind === 'thread') C.markSeen(open.thread);
      else C.markRoomRead(open.room);
      const o = open;
      setTimeout(() => C.clearOnOpen(o));
      // Reading it changes the list: the chat leaves Unread at once, as in Beeper.
      if (open.unread) {
        list = C.entries();
        open = list.find((e) => e.key === o.key) || o;
      }
    }
    const { mine, pool, shown } = C.visibleEntries(list);
    return {
      screen: 'main', open, pool, shown,
      loading: !(C.S.roomId && C.S.historyDone),
      waiting: !open && !!C.S.selected,
      unread: mine.filter((e) => e.unread && C.inBox('inbox')(e)).length,
    };
  });

  $effect(() => {
    document.title = view.unread ? `(${view.unread}) Weft` : 'Weft';
    if (view.screen === 'main') C.markRead();
  });

  const image = $derived.by(() => {
    tick;
    if (!ui.image) return null;
    return { url: C.media(ui.image.mxc), video: ui.image.mime?.startsWith('video/') };
  });

  // Esc steps back; Ctrl+E archive, Ctrl+Shift+E archive all read, Ctrl+Shift+U read/unread, Ctrl+U next unread,
  // Ctrl+R reply, Ctrl+Tab and Ctrl+1–9 move in the list, Ctrl+Shift+S unread/all. Typing goes into the open chat.
  function keydown(e) {
    if (C.S.view !== 'main') return;
    const mod = (e.ctrlKey || e.metaKey) && !e.altKey;
    const key = e.key.toLowerCase();
    const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '');
    const run = (fn) => { e.preventDefault(); fn(); };
    if (key === 'escape' && ui.image) run(() => (ui.image = null));
    else if (key === 'escape' && ui.menu) run(() => (ui.menu = false));
    else if (mod && e.shiftKey && key === 's') run(() => C.setShowAll(!C.S.showAll));
    else if (mod && !e.shiftKey && key === 'e') run(() => C.toggleArchive(C.selectedEntry()));
    else if (mod && e.shiftKey && key === 'e') run(C.archiveAllRead);
    else if (mod && e.shiftKey && key === 'u') run(() => C.toggleRead(C.selectedEntry()));
    else if (mod && !e.shiftKey && key === 'u') run(C.nextUnread);
    else if (mod && !e.shiftKey && key === 'r') run(C.replyToLast);
    else if (e.ctrlKey && key === 'tab') run(() => C.moveSelection(e.shiftKey ? -1 : 1));
    // By key position, not the character: on a Slovak keyboard the number row gives + ľ š č ť ž ý á í.
    else if (e.ctrlKey && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code)) run(() => { const x = view.shown?.[Number(e.code.slice(5)) - 1]; if (x) C.select(x.key); });
    else if (e.ctrlKey && e.altKey && key === 'arrowleft') run(() => history.back());
    else if (e.ctrlKey && e.altKey && key === 'arrowright') run(() => history.forward());
    else if (key === 'escape' && C.S.replyTo) run(() => { C.S.replyTo = null; C.render(); });
    else if (key === 'escape' && typing) run(() => document.activeElement.blur());
    else if (key === 'escape' && C.S.selected) run(() => C.select(null));
    else if (key === 'escape' && C.S.box !== 'inbox') run(() => C.setBox('inbox'));
    else if (!typing && !mod && !e.altKey && e.key.length === 1 && C.S.selected) document.querySelector('[data-compose]')?.focus();
  }
</script>

<svelte:window onkeydown={keydown} onclick={() => { if (ui.menu) ui.menu = false; }} />

{#if view.screen === 'main'}
  <div class="shell" class:has-sel={view.open || view.waiting}>
    <Sidebar {tick} shown={view.shown} pool={view.pool} loading={view.loading} />
    {#if view.open?.kind === 'room'}
      {#key view.open.key}<Chat r={view.open.room} {tick} />{/key}
    {:else if view.open?.kind === 'thread'}
      {#key view.open.key}<Thread t={view.open.thread} {tick} />{/key}
    {:else}
      <main class="none"><p>{view.waiting ? 'Otváram chat…' : 'Vyber chat vľavo.'}</p></main>
    {/if}
  </div>
{:else}
  <main class="alone">
    {#if view.screen === 'loading'}
      <p>Načítavam…</p>
    {:else}
      <p>{view.error || 'Táto verzia zatiaľ nevie prihlásiť.'} Prihlás sa v <a href="/">Správach</a> a vráť sa sem.</p>
    {/if}
  </main>
{/if}

{#if ui.image}
  <div class="lightbox" role="dialog" aria-label="Obrázok" tabindex="-1" onclick={() => (ui.image = null)} onkeydown={() => {}}>
    {#if image?.url}
      {#if image.video}
        <!-- svelte-ignore a11y_media_has_caption -->
        <video src={image.url} controls autoplay onclick={(e) => e.stopPropagation()}></video>
      {:else}
        <img src={image.url} alt="" />
      {/if}
    {:else}
      <p>Načítavam…</p>
    {/if}
    <button class="close" title="Zavrieť (Esc)"><Icon name="close" size={20} /></button>
  </div>
{/if}

<style>
  /* avoid-ai-design-ignore-file: K7 (focus ring is global, app.css :focus-visible) */
  .shell { display: grid; grid-template-columns: minmax(260px, 320px) 1fr; height: 100%; }
  .shell > :global(*) { min-height: 0; }
  .none, .alone { display: grid; place-items: center; color: var(--muted); }
  .alone { height: 100%; padding: 24px; text-align: center; }
  .alone a { color: var(--link); }

  .lightbox { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; background: rgb(0 0 0 / 0.82); color: #fff; }
  .lightbox img, .lightbox video { max-width: 94vw; max-height: 92vh; border-radius: 12px; }
  .close { position: absolute; top: 14px; right: 14px; width: 40px; height: 40px; border: 0; border-radius: 50%; background: rgb(255 255 255 / 0.14); color: #fff; display: grid; place-items: center; }

  /* Phone: one pane at a time. */
  @media (max-width: 700px) and (hover: none) {
    .shell { grid-template-columns: 1fr; }
    .shell.has-sel > :global(.side) { display: none; }
    .shell:not(.has-sel) > :global(:not(.side)) { display: none; }
  }
  /* Half a laptop screen: the chat on top, the list below, both in sight. */
  @media (max-width: 700px) and (hover: hover) and (pointer: fine) {
    .shell { grid-template-columns: 1fr; grid-template-rows: 1fr; }
    .shell.has-sel { grid-template-rows: 62% 38%; }
    .shell.has-sel > :global(.side) { order: 2; border-right: 0; border-top: 1px solid var(--line); }
    .shell:not(.has-sel) > :global(:not(.side)) { display: none; }
  }
</style>
