<script>
  // Round picture of a chat or person: their avatar, or initials on a color of their own.
  import { media, hue, initialsOf } from './lib/core.js';
  let { mxc = '', name = '', size = 40, tick = 0 } = $props();
  const url = $derived.by(() => { tick; return media(mxc, size > 48 ? 96 : 64); });
</script>

{#if url}
  <img class="av" src={url} alt="" style:width="{size}px" style:height="{size}px" />
{:else}
  <span class="av initials" style:width="{size}px" style:height="{size}px" style:font-size="{Math.round(size * 0.38)}px"
    style:background="hsl({hue(name)} 42% 52%)">{initialsOf(name)}</span>
{/if}

<style>
  .av { flex: none; border-radius: 50%; object-fit: cover; display: grid; place-items: center; }
  .initials { color: #fff; font-weight: 700; letter-spacing: 0.02em; user-select: none; }
</style>
