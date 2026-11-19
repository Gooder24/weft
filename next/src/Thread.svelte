<script>
  // An open EduPage message: the whole first message, every reply as a bubble, and the reply box.
  import * as C from './lib/core.js';
  import { findIn } from './lib/text.svelte.js';
  import Composer from './Composer.svelte';
  import Icon from './Icon.svelte';
  import Text from './Text.svelte';
  let { t, tick } = $props();
  let scroller = $state();

  const d = $derived.by(() => {
    tick;
    const { root } = t;
    const notice = root.content.msgtype === 'm.notice';
    return {
      notice,
      title: C.titleOf(t),
      when: `${C.dayLabel(root.origin_server_ts)} ${C.timeLabel(root.origin_server_ts)}`,
      body: C.bodyOf(root),
      find: findIn(root),
      replies: t.replies.map((x) => ({
        ev: x,
        bot: x.content[C.MARK] === 0,
        mine: x.sender === C.S.userId,
        name: C.nameOf(x.sender),
        text: C.bodyOf(x),
        find: findIn(x),
        when: x.pending ? 'odosielam' : `${C.shortDate(x.origin_server_ts)} ${C.timeLabel(x.origin_server_ts)}`,
      })),
    };
  });

  // A message opened from search: its marked words come into view once.
  $effect(() => {
    tick;
    if (!C.S.focusEvent || C.S.focusScrolled === C.S.focusEvent || !scroller) return;
    const el = scroller.querySelector('mark.found');
    if (el) { el.scrollIntoView({ block: 'center' }); C.S.focusScrolled = C.S.focusEvent; }
  });
</script>

<section class="thread">
  <header>
    <button class="back" title="Späť" onclick={C.closeThread}><Icon name="back" size={20} /></button>
    <div class="who">
      <span class="edu" class:notice={d.notice}><Icon name={d.notice ? 'bell' : 'envelope'} size={16} /></span>
      <b>{d.title}</b>
      <img src="/edupage.png" alt="EduPage" />
    </div>
  </header>
  <div class="scroll" bind:this={scroller}>
    <article>
      <div class="letter">
        <p class="when">{d.when}</p>
        <div class="text"><Text text={d.body} find={d.find} /></div>
      </div>
      {#each d.replies as x (x.ev.event_id)}
        <div class="reply" class:mine={x.mine} class:bot={x.bot} class:pending={x.ev.pending}>
          {#if !x.bot && !x.mine}<span class="name">{x.name}</span>{/if}
          <div class="bubble"><span class="text"><Text text={x.text} find={x.find} /></span><span class="time">{x.when}</span></div>
        </div>
      {/each}
    </article>
  </div>
  {#if !d.notice}
    <Composer draftKey={t.id} placeholder="Napíš odpoveď…" send={() => C.sendReply(t.id)} {tick} />
  {/if}
</section>

<style>
  /* avoid-ai-design-ignore-file: K3, K7 (blur: the name pill floats over scrolling messages, as in Beeper) */
  .thread { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); }
  header { position: absolute; z-index: 5; top: 10px; left: 0; right: 0; display: flex; justify-content: center; pointer-events: none; }
  .who { pointer-events: auto; display: flex; align-items: center; gap: 8px; max-width: calc(100% - 120px); padding: 4px 14px 4px 4px; border-radius: 999px; background: color-mix(in srgb, var(--side) 88%, transparent); backdrop-filter: blur(10px); border: 1px solid var(--line); box-shadow: var(--shadow); }
  .who b { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 650; }
  .who img { width: 16px; height: 16px; border-radius: 5px; flex: none; }
  .edu { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: #3d7a4f; color: #fff; flex: none; }
  .edu.notice { background: #b5772a; }
  .back { display: none; pointer-events: auto; position: absolute; left: 10px; top: 2px; width: 36px; height: 36px; border: 0; border-radius: 50%; background: var(--side); box-shadow: var(--shadow); place-items: center; }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; }
  article { max-width: 760px; margin: 0 auto; padding: 64px 16px 8px; }
  /* The first message reads like a letter: full width, not a bubble. */
  .letter { padding: 16px 18px; border-radius: 18px; background: var(--side); border: 1px solid var(--line); }
  .when { margin: 0 0 8px; color: var(--muted); font-size: 0.8rem; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; }
  .reply { display: flex; flex-direction: column; align-items: flex-start; margin-top: 10px; }
  .reply.mine { align-items: flex-end; }
  .name { margin: 0 0 3px 12px; font-size: 0.8rem; color: var(--muted); }
  .bubble { max-width: 78%; padding: 8px 12px 6px; border-radius: 18px; background: var(--raise); }
  .mine .bubble { background: var(--accent); color: var(--on-accent); }
  .bot .bubble { background: none; border: 1px dashed var(--line); color: var(--muted); }
  .pending .bubble { opacity: 0.6; }
  .time { float: right; margin: 6px 0 -2px 10px; font-size: 0.7rem; opacity: 0.6; white-space: nowrap; }

  @media (max-width: 700px) and (hover: none) {
    .back { display: grid; }
  }
</style>
