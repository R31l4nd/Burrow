<script lang="ts">
  // Burrow's mark: a b whose bowl is the burrow, a cursor waiting in it
  // (web/public/icon.svg), on the chosen accent.
  let { size = 28 }: { size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
  <circle cx="256" cy="256" r="256" fill="var(--accent-l)" />
  <g transform="translate(256 256) scale(0.8) translate(-268 -270)">
    <circle cx="268" cy="318" r="63" fill="#0b1510" />
    <path d="M178 110V318" stroke="#f2f5f3" stroke-width="56" stroke-linecap="round" />
    <circle cx="268" cy="318" r="90" fill="none" stroke="#f2f5f3" stroke-width="56" />
    <rect x="254" y="324" width="28" height="36" rx="3" fill="#9fe0b7" />
  </g>
</svg>
