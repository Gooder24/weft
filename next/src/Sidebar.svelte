<script>
  // The inbox on the left: the open view with its menu, disconnected accounts, and one row per chat.
  import * as C from './lib/core.js';
  import { ui } from './lib/text.svelte.js';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  let { tick, shown, pool, loading } = $props();

  const head = $derived.by(() => {
    tick; ui.menu;
    const hidden = C.hiddenApps();
    return {
      hidden,
      boxId: C.S.box,
      showAll: C.S.showAll,
      box: C.BOXES.find(([id]) => id === C.S.box)[1],
      filter: C.S.box === 'inbox' && !C.S.showAll ? 'Neprečítané' : 'Všetky',
      without: C.APPS.filter((a) => hidden.has(a.id)).map((a) => a.name).join(', '),
    };
  });

  // An account that lost its connection gets a bar on top, as in Beeper; its chats get no new messages.
  const banners = $derived.by(() => {
    tick;
    const down = [];
    const edu = C.S.logins[0];
    if (edu && edu.state?.state_event && !['CONNECTED', 'CONNECTING'].includes(edu.state.state_event)) down.push(C.APPS[0]);
    for (const app of C.LINKS) {
      const logins = C.S.links[app.id];
      const state = logins?.[0]?.state?.state_event;
      const orphaned = logins?.length === 0 && [...C.S.rooms.values()].some((r) => r.app === app.id);
      if (orphaned || (state && !['CONNECTED', 'CONNECTING', 'BACKFILLING'].includes(state))) down.push(C.APPS.find((a) => a.id === app.id) || app);
    }
    return down.filter((a) => !C.S.dismissed?.has(a.id));
  });

  const rows = $derived.by(() => {
    tick;
    return shown.map((e) => ({ e, app: C.APPS.find((a) => a.id === e.app), preview: preview(e), sel: C.S.selected === e.key }));
  });

  function preview(e) {
    if (e.kind === 'thread') {
      const t = e.thread;
      const last = t.replies.at(-1);
      const text = (last ? `${C.nameOf(last.sender)}: ${C.bodyOf(last)}` : C.bodyOf(t.root)).replace(/\s+/g, ' ');
      return t.replies.length ? `${t.replies.length + 1} · ${text}` : text;
    }
    const ev = e.lastMsg;
    if (!ev) return '';
    const r = e.room;
    const who = ev.sender === C.S.userId ? 'Ty: ' : C.dmPartner(r) ? '' : `${C.firstName(C.memberName(r, ev.sender))}: `;
    return who + C.messageSummary(C.roomModel(r), ev);
  }

  const dismiss = (id) => { (C.S.dismissed ||= new Set()).add(id); C.render(); };
</script>

<aside class="side">
  <header>
    <button class="view" onclick={(e) => { e.stopPropagation(); ui.menu = !ui.menu; }} aria-expanded={ui.menu}>
      <b>{head.box}</b>
      <span>{head.filter}{head.without ? `, bez ${head.without}` : ''}</span>
      <Icon name="down" size={14} />
    </button>
    {#if ui.menu}
      <div class="menu" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
        {#each C.BOXES as [id, label]}
          <button role="menuitemradio" aria-checked={head.boxId === id} onclick={() => { C.setBox(id); ui.menu = false; }}>
            <span class="tick">{#if head.boxId === id}<Icon name="check" size={15} />{/if}</span>{label}
          </button>
        {/each}
        <hr />
        {#each C.APPS as app}
          <button role="menuitemcheckbox" aria-checked={!head.hidden.has(app.id)} onclick={() => C.toggleApp(app.id)}>
            <span class="tick">{#if !head.hidden.has(app.id)}<Icon name="check" size={15} />{/if}</span><img src={app.icon} alt="" />{app.name}
          </button>
        {/each}
        <hr />
        <button role="menuitemcheckbox" aria-checked={!head.showAll} onclick={() => C.setShowAll(!head.showAll)}>
          <span class="tick">{#if !head.showAll}<Icon name="check" size={15} />{/if}</span>Len neprečítané<kbd>Ctrl+Shift+S</kbd>
        </button>
      </div>
    {/if}
  </header>

  <div class="list">
    {#each banners as app (app.id)}
      <div class="banner">
        <img src={app.icon} alt="" /><span>{app.name} je odpojený</span>
        <button title="Skryť" onclick={() => dismiss(app.id)}><Icon name="close" size={14} /></button>
      </div>
    {/each}

    {#each rows as { e, app, preview, sel } (e.key)}
      <button class="row" class:unread={e.unread} class:sel onclick={() => C.select(e.key)}>
        <span class="pic">
          {#if e.kind === 'thread'}
            <span class="edu" class:notice={e.thread.root.content.msgtype === 'm.notice'}>
              <Icon name={e.thread.root.content.msgtype === 'm.notice' ? 'bell' : 'envelope'} size={20} />
            </span>
          {:else}
            <Avatar mxc={C.roomAvatar(e.room)} name={e.title} size={44} {tick} />
          {/if}
          {#if app}<img class="badge" src={app.icon} alt={app.name} />{/if}
        </span>
        <span class="meta">
          <span class="top">
            <span class="name">{e.title}</span>
            <time>{e.sortTs ? C.listDate(e.sortTs) : ''}</time>
          </span>
          <span class="bottom">
            <span class="prev">{preview}</span>
            {#if e.count > 1}<b class="count">{e.count > 99 ? '99+' : e.count}</b>{:else if e.unread}<b class="dot"></b>{/if}
          </span>
        </span>
      </button>
    {/each}

    {#if loading && !shown.length}
      <p class="empty">Sťahujem správy…</p>
    {:else if !pool.length}
      <p class="empty">{head.boxId === 'inbox' ? 'Zatiaľ žiadne správy.' : 'Nič tu nie je.'}</p>
    {:else if !shown.length}
      <div class="zero">
        <b>Všetko máš prečítané</b>
        <p>Staršie chaty sú v <button onclick={() => C.setBox('archive')}>Archíve</button> a v <button onclick={() => C.setBox('low')}>Nízkej priorite</button>.</p>
      </div>
    {/if}
  </div>
</aside>

<style>
  .side { display: flex; flex-direction: column; min-height: 0; background: var(--side); border-right: 1px solid var(--line); }
  header { position: relative; padding: 12px 10px 6px; }
  .view { display: flex; align-items: baseline; gap: 8px; max-width: 100%; border: 0; background: none; padding: 6px 10px; border-radius: 10px; text-align: left; }
  .view:hover { background: var(--hover); }
  .view b { font-size: 1.2rem; font-weight: 700; }
  .view span { color: var(--muted); font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .view :global(svg) { color: var(--muted); align-self: center; flex: none; }

  .menu { position: absolute; z-index: 20; top: 52px; left: 10px; min-width: 240px; padding: 6px; background: var(--side); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); }
  .menu button { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: none; padding: 7px 10px; border-radius: 9px; text-align: left; }
  .menu button:hover, .menu button:focus-visible { background: var(--hover); }
  .menu img { width: 16px; height: 16px; border-radius: 4px; }
  .menu kbd { margin-left: auto; font: inherit; font-size: 0.78rem; color: var(--muted); }
  .menu hr { border: 0; border-top: 1px solid var(--line); margin: 5px 6px; }
  .tick { width: 16px; display: grid; place-items: center; color: var(--accent); }

  .list { flex: 1; overflow-y: auto; padding: 2px 8px 12px; }
  .banner { display: flex; align-items: center; gap: 10px; margin: 4px 2px 8px; padding: 9px 10px 9px 12px; border-radius: 12px; background: color-mix(in srgb, var(--danger) 13%, var(--side)); font-size: 0.92rem; }
  .banner img { width: 18px; height: 18px; border-radius: 5px; }
  .banner span { flex: 1; }
  .banner button { border: 0; background: none; color: var(--muted); padding: 4px; border-radius: 8px; display: grid; }
  .banner button:hover { background: var(--hover); }

  .row { display: flex; gap: 12px; align-items: center; width: 100%; padding: 9px 10px; border: 0; border-radius: 14px; background: none; text-align: left; }
  .row:hover { background: var(--hover); }
  .row.sel { background: var(--raise); }
  .pic { position: relative; flex: none; display: grid; }
  .edu { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: #3d7a4f; color: #fff; }
  .edu.notice { background: #b5772a; }
  .badge { position: absolute; right: -3px; bottom: -3px; width: 18px; height: 18px; border-radius: 6px; border: 2px solid var(--side); background: var(--side); }
  .row.sel .badge { border-color: var(--raise); background: var(--raise); }
  .meta { flex: 1; min-width: 0; display: grid; gap: 2px; }
  .top, .bottom { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 550; }
  time { flex: none; color: var(--muted); font-size: 0.78rem; }
  .prev { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); font-size: 0.9rem; }
  .unread .name { font-weight: 750; }
  .unread .prev { color: var(--ink); }
  .unread time { color: var(--accent); }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); flex: none; }
  .count { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--accent); color: var(--on-accent); font-size: 0.75rem; display: grid; place-items: center; flex: none; }

  .empty { margin: 40px 16px; text-align: center; color: var(--muted); }
  .zero { margin: 56px 16px; text-align: center; }
  .zero b { display: block; font-size: 1.05rem; margin-bottom: 6px; }
  .zero p { margin: 0; color: var(--muted); font-size: 0.92rem; }
  .zero button { border: 0; background: none; padding: 0; color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
</style>
