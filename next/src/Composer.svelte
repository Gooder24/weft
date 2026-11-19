<script>
  // The message box at the bottom of a chat: Enter sends, Shift+Enter is a new line, Ctrl+Enter sends and archives.
  import * as C from './lib/core.js';
  import { fileSize } from './lib/text.svelte.js';
  import Icon from './Icon.svelte';
  let { draftKey, roomId = null, placeholder = 'Napíš správu…', send, tick } = $props();
  let area = $state();
  let picker = $state();

  const d = $derived.by(() => {
    tick;
    const r = roomId && C.S.rooms.get(roomId);
    const m = r && C.roomModel(r);
    const ev = r && C.S.replyTo?.room === r.id ? m.byId.get(C.S.replyTo.event) : null;
    return {
      reply: ev ? { who: C.memberName(r, ev.sender), text: C.messageSummary(m, ev) } : null,
      file: roomId ? C.S.attach.get(roomId) : null,
    };
  });

  // The box shows the draft; typing writes it at once, so it differs only when the core changed it (sent, failed).
  $effect(() => {
    tick;
    const want = C.S.drafts.get(draftKey) || '';
    if (area && area.value !== want) area.value = want;
  });

  // Asked for by Ctrl+R, a reply button or a picked file.
  $effect(() => {
    tick;
    if (C.S.focusComposer && area) { area.focus({ preventScroll: true }); C.S.focusComposer = false; }
  });

  function keydown(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return;
    e.preventDefault();
    send(e.ctrlKey || e.metaKey);
  }
  function pick(e) {
    const f = e.target.files[0];
    if (f) { C.S.attach.set(roomId, f); C.S.focusComposer = true; C.render(); }
    e.target.value = '';
  }
</script>

<div class="compose">
  {#if d.reply}
    <div class="note">
      <span>Odpovedáš <b>{d.reply.who}</b>: {d.reply.text}</span>
      <button title="Zrušiť (Esc)" onclick={() => { C.S.replyTo = null; C.render(); }}><Icon name="close" size={15} /></button>
    </div>
  {/if}
  {#if d.file}
    <div class="note">
      <span>Príloha <b>{d.file.name}</b>, {fileSize(d.file.size)}, odíde so správou</span>
      <button title="Odobrať prílohu" onclick={() => { C.S.attach.delete(roomId); C.render(); }}><Icon name="close" size={15} /></button>
    </div>
  {/if}
  <div class="pill">
    {#if roomId}
      <input type="file" hidden bind:this={picker} onchange={pick} />
      <button class="round" title="Pridať prílohu" onclick={() => picker.click()}><Icon name="plus" size={20} /></button>
    {/if}
    <textarea bind:this={area} rows="1" {placeholder} data-compose
      oninput={(e) => C.S.drafts.set(draftKey, e.target.value)} onkeydown={keydown}></textarea>
    <button class="round send" title="Odoslať (Enter)" onclick={() => send(false)}><Icon name="send" size={19} /></button>
  </div>
</div>

<style>
  .compose { padding: 6px 16px 14px; }
  .note { display: flex; align-items: center; gap: 8px; margin: 0 8px 6px; padding: 6px 6px 6px 12px; border-radius: 12px; background: var(--raise); font-size: 0.88rem; }
  .note span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .note button { border: 0; background: none; padding: 5px; border-radius: 8px; display: grid; color: var(--muted); }
  .note button:hover { background: var(--hover); }
  .pill { display: flex; align-items: flex-end; gap: 4px; padding: 5px; border-radius: 24px; background: var(--side); border: 1px solid var(--line); }
  .pill:focus-within { border-color: color-mix(in srgb, var(--accent) 60%, var(--line)); }
  textarea { flex: 1; min-width: 0; border: 0; outline: 0; resize: none; background: none; color: inherit; font: inherit; line-height: 1.4; padding: 7px 6px; field-sizing: content; min-height: 36px; max-height: 200px; box-sizing: border-box; }
  textarea::placeholder { color: var(--muted); }
  .round { flex: none; width: 36px; height: 36px; border: 0; border-radius: 50%; background: none; display: grid; place-items: center; color: var(--muted); }
  .round:hover { background: var(--hover); }
  .send { background: var(--accent); color: var(--on-accent); }
  .send:hover { background: color-mix(in srgb, var(--accent) 85%, #fff); }
</style>
