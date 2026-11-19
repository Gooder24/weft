<script>
  // Message text: links clickable, search words marked. Kept on one line so no whitespace sneaks in.
  import { segments } from './lib/text.svelte.js';
  let { text, find = '' } = $props();
  const parts = $derived(segments(text, find));
</script>

{#each parts as p}{#if p.t === 'a'}<a href={p.s} target="_blank" rel="noreferrer" onclick={(e) => e.stopPropagation()}>{p.s}</a>{:else if p.t === 'mark'}<mark class="found">{p.s}</mark>{:else}{p.s}{/if}{/each}

<style>
  /* avoid-ai-design-ignore-file: K7 (focus ring is global, app.css :focus-visible) */
  a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
  .found { background: none; color: inherit; font-weight: inherit; text-decoration: underline 2px var(--link); text-underline-offset: 3px; }
</style>
