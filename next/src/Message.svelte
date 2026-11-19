<script>
  // One message of a bridged chat: quote, body, time, reactions, and on hover the quick reactions and reply.
  import * as C from './lib/core.js';
  import { findIn, fileSize, download, ui } from './lib/text.svelte.js';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';
  import Text from './Text.svelte';
  let { r, m, ev, grouped, last, group, tick } = $props();

  const d = $derived.by(() => {
    tick;
    const gone = C.isRedacted(m, ev);
    const replyId = ev.content?.['m.relates_to']?.['m.in_reply_to']?.event_id;
    const quoted = replyId && m.byId.get(replyId);
    const c = gone ? {} : C.contentOf(m, ev);
    const kind = gone ? 'gone' : ev.type === 'm.sticker' || c.msgtype === 'm.image' ? 'image'
      : c.msgtype === 'm.video' ? 'video' : c.msgtype === 'm.audio' ? 'audio' : c.msgtype === 'm.file' ? 'file' : 'text';
    const w = Math.min(c.info?.w || 320, 320);
    const hgt = c.info?.w && c.info?.h ? Math.min(Math.round(w * c.info.h / c.info.w), 420) : 200;
    return {
      mine: ev.sender === C.S.userId,
      gone, c, kind, w, hgt,
      reply: replyId && !gone ? { id: replyId, who: quoted && C.memberName(r, quoted.sender), text: quoted && C.messageSummary(m, quoted) } : null,
      name: C.memberName(r, ev.sender),
      avatar: r.members.get(ev.sender)?.avatar,
      url: kind === 'image' ? C.media(c.url, 480) : kind === 'video' ? C.media(c.info?.thumbnail_url, 480) : kind === 'audio' ? C.media(c.url) : '',
      text: String(c.body || '').replace(/^(> .*\n)+\n/, ''),
      caption: c.filename && c.body && c.body !== c.filename ? c.body : '',
      edited: m.edits.has(ev.event_id) && !gone,
      reacts: [...(m.reactions.get(ev.event_id) || [])].map(([key, who]) => ({ key, n: who.length, me: who.includes(C.S.userId), title: who.map((id) => C.memberName(r, id)).join(', ') })),
      quick: C.quickReacts().map((key) => ({ key, me: m.ownReacts.has(`${ev.event_id}|${key}`) })),
      focus: C.S.focusEvent === ev.event_id,
      find: findIn(ev),
      acts: C.S.actsFor === ev.event_id,
    };
  });

  const reply = () => { C.S.replyTo = { room: r.id, event: ev.event_id }; C.S.focusComposer = true; C.render(); };
  // Touch screens have no hover: a tap on the message shows its bar.
  function tap(e) {
    if (!matchMedia('(hover: none)').matches || e.target.closest('a, button')) return;
    C.S.actsFor = C.S.actsFor === ev.event_id ? null : ev.event_id;
    C.render();
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="msg" class:mine={d.mine} class:grouped class:last class:pending={ev.pending} class:focus={d.focus} class:acts={d.acts}
  data-event={ev.event_id} onclick={tap}>
  {#if !d.mine && group && !grouped}<div class="who">{d.name}</div>{/if}
  <div class="line">
    {#if !d.mine}
      <span class="face">{#if last}<Avatar mxc={d.avatar} name={d.name} size={28} {tick} />{/if}</span>
    {/if}
    <div class="bubble" class:media={d.kind === 'image' || d.kind === 'video'}>
      {#if d.reply}
        <button class="quote" onclick={() => C.jumpTo(r, d.reply.id)}>
          {#if d.reply.who}<b>{d.reply.who}</b><span>{d.reply.text}</span>{:else}<span>Odpoveď na správu</span>{/if}
        </button>
      {/if}
      {#if d.kind === 'gone'}
        <i class="gone">Správa bola odstránená</i>
      {:else if d.kind === 'image' || d.kind === 'video'}
        <button class="pic" style:width="{d.w}px" style:height="{d.hgt}px" onclick={() => (ui.image = { mxc: d.c.url, mime: d.c.info?.mimetype || (d.kind === 'video' ? 'video/mp4' : '') })}>
          {#if d.url}<img src={d.url} alt={d.c.body || ''} />{/if}
          {#if d.kind === 'video'}<span class="play"><Icon name="play" size={22} /></span>{/if}
        </button>
      {:else if d.kind === 'audio'}
        {#if d.url}<audio controls src={d.url} preload="metadata"></audio>{:else}<i class="gone">Zvuková správa…</i>{/if}
      {:else if d.kind === 'file'}
        <button class="file" onclick={() => download(d.c.url, d.c.filename || d.c.body)}>
          <Icon name="file" size={20} /><span><b>{d.c.filename || d.c.body || 'Súbor'}</b>{#if d.c.info?.size}<small>{fileSize(d.c.info.size)}</small>{/if}</span>
        </button>
      {:else}
        <div class="text">{#if d.c.msgtype === 'm.emote'}* {d.name} {/if}<Text text={d.text} find={d.find} /></div>
      {/if}
      {#if d.caption}<div class="text caption"><Text text={d.caption} /></div>{/if}
      <span class="time">{d.edited ? 'upravené, ' : ''}{ev.pending ? 'odosielam' : C.timeLabel(ev.origin_server_ts)}</span>
    </div>
    {#if !d.gone && !ev.pending}
      <div class="bar">
        {#each d.quick as q (q.key)}
          <button class="q" class:me={q.me} onclick={() => C.toggleReact(r, ev, q.key)}>{q.key}</button>
        {/each}
        <button class="q rep" title="Odpovedať (Ctrl+R)" onclick={reply}><Icon name="reply" size={17} /></button>
      </div>
    {/if}
  </div>
  {#if d.reacts.length}
    <div class="reacts">
      {#each d.reacts as x (x.key)}
        <button class="chip" class:me={x.me} title={x.title} onclick={() => C.toggleReact(r, ev, x.key)}>{x.key}{#if x.n > 1}<span>{x.n}</span>{/if}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .msg { display: flex; flex-direction: column; align-items: flex-start; padding: 0 16px; margin-top: 10px; }
  .msg.grouped { margin-top: 2px; }
  .msg.mine { align-items: flex-end; }
  .who { margin: 0 0 3px 50px; font-size: 0.8rem; color: var(--muted); }
  .line { position: relative; display: flex; align-items: flex-end; gap: 8px; max-width: min(78%, 640px); }
  .face { width: 28px; flex: none; display: grid; }

  .bubble { position: relative; min-width: 0; padding: 8px 12px 6px; border-radius: 18px; background: var(--raise); overflow-wrap: anywhere; }
  .mine .bubble { background: var(--accent); color: var(--on-accent); }
  /* Messages in a row hug each other on the sender's side. */
  .msg:not(.mine).grouped .bubble { border-top-left-radius: 6px; }
  .msg:not(.mine):not(.last) .bubble { border-bottom-left-radius: 6px; }
  .mine.grouped .bubble { border-top-right-radius: 6px; }
  .mine:not(.last) .bubble { border-bottom-right-radius: 6px; }
  .bubble.media { padding: 4px; }
  .pending .bubble { opacity: 0.6; }
  .focus .bubble { box-shadow: 0 0 0 2px var(--link); }

  .text { white-space: pre-wrap; }
  .caption { padding: 6px 8px 0; }
  .mine .text :global(a) { color: inherit; }
  .gone { color: var(--muted); }
  .mine .gone { color: inherit; opacity: 0.75; }
  .time { float: right; margin: 6px 0 -2px 10px; font-size: 0.7rem; opacity: 0.6; white-space: nowrap; }
  .media .time { position: absolute; right: 10px; bottom: 8px; margin: 0; padding: 1px 7px; border-radius: 9px; background: rgb(0 0 0 / 0.5); color: #fff; opacity: 1; }

  .quote { display: grid; width: 100%; margin: 0 0 6px; padding: 5px 10px; border: 0; border-left: 3px solid currentColor; border-radius: 8px; background: rgb(127 127 127 / 0.16); text-align: left; font-size: 0.86rem; }
  .quote span { opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .media .quote { margin: 4px 4px 6px; width: auto; }

  .pic { position: relative; display: block; padding: 0; border: 0; border-radius: 14px; overflow: hidden; background: rgb(127 127 127 / 0.2); max-width: 100%; }
  .pic img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .play { position: absolute; inset: 0; margin: auto; width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; background: rgb(0 0 0 / 0.55); color: #fff; }
  .file { display: flex; align-items: center; gap: 10px; border: 0; background: none; padding: 2px 0; text-align: left; }
  .file span { display: grid; }
  .file small { opacity: 0.7; }
  audio { display: block; max-width: 260px; }

  /* The bar sits on the bubble's top edge, so the cursor reaches it without leaving the message. */
  .bar { position: absolute; bottom: calc(100% - 8px); left: 36px; z-index: 2; display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: var(--side); border: 1px solid var(--line); box-shadow: var(--shadow); visibility: hidden; }
  .mine .bar { left: auto; right: 0; }
  .line:hover .bar, .acts .bar { visibility: visible; }
  .q { width: 32px; height: 32px; border: 0; border-radius: 50%; background: none; font-size: 1.05rem; display: grid; place-items: center; color: var(--muted); }
  .q:hover { background: var(--hover); }
  .q.me { background: color-mix(in srgb, var(--accent) 22%, transparent); }

  .reacts { display: flex; flex-wrap: wrap; gap: 4px; margin: -4px 0 0 46px; position: relative; z-index: 1; }
  .mine .reacts { margin: -4px 6px 0 0; }
  .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; border: 2px solid var(--bg); background: var(--raise); font-size: 0.9rem; }
  .chip span { font-size: 0.78rem; color: var(--muted); }
  .chip.me { background: color-mix(in srgb, var(--accent) 28%, var(--raise)); }
</style>
