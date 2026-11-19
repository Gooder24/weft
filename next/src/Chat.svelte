<script>
  // An open bridged chat: name floating on top, messages by day, the box to write in.
  import * as C from './lib/core.js';
  import Avatar from './Avatar.svelte';
  import Composer from './Composer.svelte';
  import Icon from './Icon.svelte';
  import Message from './Message.svelte';
  let { r, tick } = $props();
  let scroller = $state();

  const d = $derived.by(() => {
    tick;
    const m = C.roomModel(r);
    const partner = C.dmPartner(r);
    const rows = [];
    let day = '';
    for (let i = 0; i < m.messages.length; i++) {
      const ev = m.messages[i];
      const prev = m.messages[i - 1];
      const next = m.messages[i + 1];
      const label = C.dayLabel(ev.origin_server_ts);
      if (label !== day) rows.push({ day: label, key: `day ${ev.event_id}` });
      const near = (a, b) => a && b && a.sender === b.sender && b.origin_server_ts - a.origin_server_ts < 5 * 60e3 && C.dayLabel(a.origin_server_ts) === C.dayLabel(b.origin_server_ts);
      rows.push({ ev, key: ev.event_id, grouped: label === day && near(prev, ev), last: !near(ev, next) });
      day = label;
    }
    const mineLast = m.messages.findLast((ev) => ev.sender === C.S.userId && !ev.pending);
    const readers = mineLast ? C.joinedPeople(r).filter(([id]) => {
      const at = r.events.get(r.receipts.get(id));
      return at && at.origin_server_ts >= mineLast.origin_server_ts;
    }) : [];
    const app = C.APPS.find((a) => a.id === r.app);
    return {
      m, rows, app, partner,
      title: C.roomTitle(r),
      avatar: C.roomAvatar(r),
      seen: !readers.length ? '' : partner ? 'Videné' : `Videli: ${readers.map(([id]) => C.firstName(C.memberName(r, id))).join(', ')}`,
      people: C.joinedPeople(r).length + 1,
      start: r.historyDone ? 'Začiatok chatu' : r.loading ? 'Načítavam staršie správy…' : '',
    };
  });

  // A short chat loads its history right away; a longer one when scrolled near its top.
  $effect(() => {
    tick;
    if (!r.historyDone && !r.loading && d.m.messages.length < 30) setTimeout(() => C.loadRoomHistory(r));
  });
  function scrolled() {
    // The list is bottom-anchored (column-reverse), so scrollTop counts up from the end and goes negative.
    if (scroller.scrollHeight + scroller.scrollTop - scroller.clientHeight < 300) C.loadRoomHistory(r);
  }

  // A message opened from search or a quote comes into view once.
  $effect(() => {
    tick;
    const id = C.S.focusEvent;
    if (!id || C.S.focusScrolled === id || !scroller) return;
    const el = scroller.querySelector(`[data-event="${CSS.escape(id)}"]`);
    if (el) { el.scrollIntoView({ block: 'center' }); C.S.focusScrolled = id; }
  });

  function send(archive) {
    C.sendChat(r).then(() => archive && C.toggleArchive(C.entryOf(r.id)));
  }
</script>

<section class="chat">
  <header>
    <button class="back" title="Späť" onclick={C.closeThread}><Icon name="back" size={20} /></button>
    <div class="who" title={[d.app?.name, d.partner ? '' : `${d.people} ľudí`].filter(Boolean).join(', ')}>
      <Avatar mxc={d.avatar} name={d.title} size={30} {tick} />
      <b>{d.title}</b>
      {#if d.app}<img src={d.app.icon} alt={d.app.name} />{/if}
    </div>
  </header>
  <div class="scroll" bind:this={scroller} onscroll={scrolled}>
    <div class="msgs">
      <p class="start">{d.start}</p>
      {#each d.rows as row (row.key)}
        {#if row.day}
          <p class="day"><span>{row.day}</span></p>
        {:else}
          <Message {r} m={d.m} ev={row.ev} grouped={row.grouped} last={row.last} group={!d.partner} {tick} />
        {/if}
      {/each}
      {#if d.seen}<p class="seen">{d.seen}</p>{/if}
    </div>
  </div>
  <Composer draftKey={r.id} roomId={r.id} {send} {tick} />
</section>

<style>
  /* avoid-ai-design-ignore-file: K3, K7 (blur: the name pill floats over scrolling messages, as in Beeper) */
  .chat { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); }
  /* No header bar, as in Beeper: picture and name float in a pill above the messages. */
  header { position: absolute; z-index: 5; top: 10px; left: 0; right: 0; display: flex; justify-content: center; pointer-events: none; }
  .who { pointer-events: auto; display: flex; align-items: center; gap: 8px; max-width: calc(100% - 120px); padding: 4px 14px 4px 4px; border-radius: 999px; background: color-mix(in srgb, var(--side) 88%, transparent); backdrop-filter: blur(10px); border: 1px solid var(--line); box-shadow: var(--shadow); }
  .who b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 650; }
  .who img { width: 16px; height: 16px; border-radius: 5px; flex: none; }
  .back { display: none; pointer-events: auto; position: absolute; left: 10px; top: 2px; width: 36px; height: 36px; border: 0; border-radius: 50%; background: var(--side); box-shadow: var(--shadow); place-items: center; }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column-reverse; }
  .msgs { padding: 64px 0 6px; }
  .start { margin: 0 0 8px; text-align: center; color: var(--muted); font-size: 0.82rem; min-height: 1em; }
  .day { display: flex; justify-content: center; margin: 18px 0 6px; }
  .day span { padding: 3px 12px; border-radius: 999px; background: var(--raise); color: var(--muted); font-size: 0.78rem; }
  .seen { margin: 4px 20px 0; text-align: right; color: var(--muted); font-size: 0.75rem; }

  @media (max-width: 700px) and (hover: none) {
    .back { display: grid; }
  }
</style>
