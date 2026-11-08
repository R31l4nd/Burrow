<script lang="ts">
  // Line icons (24x24, stroke). Kept inline so the app ships no icon font.
  const paths = {
    server: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
    key: 'M7.5 20.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10.7 13.3L21 3M17.5 6.5l2.5 2.5M14.5 9.5l2 2',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    plus: 'M12 5v14M5 12h14',
    search: 'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.35-4.35',
    back: 'M19 12H5M12 19l-7-7 7-7',
    more: 'M12 6h.01M12 12h.01M12 18h.01',
    star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    'arrow-up': 'M12 19V5M5 12l7-7 7 7',
    'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
    'arrow-right': 'M5 12h14M12 5l7 7-7 7',
    'chevron-left': 'M15 18l-6-6 6-6',
    'chevron-down': 'M6 9l6 6 6-6',
    'chevron-up': 'M6 15l6-6 6 6',
    enter: 'M9 10l-5 5 5 5M20 4v7a4 4 0 0 1-4 4H4',
    backspace: 'M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM18 9l-6 6M12 9l6 6',
    send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
    format: 'M4 6h16M4 12h10M4 18h14',
    minus: 'M5 12h14',
    grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
    clipboard: 'M9 4h6v3H9zM9 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-3',
    columns: 'M4 4h16v16H4zM12 4v16',
    maximize: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    minimize: 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',
    'fold-all': 'M7 20l5-5 5 5M7 4l5 5 5-5',
    'unfold-all': 'M7 15l5 5 5-5M7 9l5-5 5 5',
    // Image updates (checked, found): an arrow down in a circle, not the reload arrows.
    updates: 'M12 8v8M8 12l4 4 4-4M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    pin: 'M12 17v5M9 3h6l-1 6 4 4H6l4-4z',
    swap: 'M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
    dot: 'M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
    'arrow-down': 'M12 5v14M5 12l7 7 7-7',
    chevron: 'M9 18l6-6-6-6',
    download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
    // Bringing something in (hosts from an ssh config, a key): an arrow into a frame.
    import: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
    phone: 'M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
    code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16',
    // A-Z: lines from long to short beside an arrow down.
    'sort-az': 'M4 6h9M4 12h6M4 18h3M18 5v14M15 16l3 3 3-3',
    keyboard: 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8',
    box: 'M21 8l-9-5-9 5v8l9 5 9-5zM3 8l9 5 9-5M12 13v8',
    apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    reload: 'M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5',
    fingerprint: 'M12 11v3M8.5 7.5A5 5 0 0 1 17 11v2a13 13 0 0 1-1 5M7 11a5 5 0 0 1 .4-2M7 14a14 14 0 0 0 1 5M12 14a18 18 0 0 1-1.5 7M4 9a9 9 0 0 1 16 0M20 13v1',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-4 4-6 8-6s7 2 8 6',
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-5M12 8h.01',
    bug: 'M8 9a4 4 0 0 1 8 0v6a4 4 0 0 1-8 0zM12 11v8M4 13h4M16 13h4M5 7l3 2M19 7l-3 2M5 19l3-2M19 19l-3-2',
    trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
    edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    close: 'M18 6L6 18M6 6l12 12',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
    mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
    chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12z',
    'bell-off': 'M13.7 21a2 2 0 0 1-3.4 0M18.6 13A17.9 17.9 0 0 1 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.3-5M2 2l20 20',
    play: 'M7 4l13 8-13 8z',
    stop: 'M6 6h12v12H6z',
    filter: 'M3 5h18l-7 8v6l-4-2v-4z',
    layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12',
    check: 'M20 6L9 17l-5-5',
    checkAll: 'M18 6L7 17l-5-5M22 10l-7.5 7.5L13 16',
    checkNone: 'M5 5h14v14H5z',
    alert: 'M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    terminal: 'M4 17l6-6-6-6M12 19h8',
    bolt: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
    sparkle: 'M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.5l-1.8-5L5 9.7l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8zM5 3l.6 1.6L7 5.2l-1.4.6L5 7.4l-.6-1.6L3 5.2l1.4-.6z',
    help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',
    upload: 'M12 21V9M7 14l5-5 5 5M5 3h14',
    file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
    image: 'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
    camera: 'M3 8a2 2 0 0 1 2-2h2.5l1.5-2h6l1.5 2H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4',
    music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
    archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
    share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
    link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
    save: 'M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v6h8V3M7 21v-7h10v7',
    undo: 'M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3',
    redo: 'M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  } as const;

  let { name, size = 22 }: { name: keyof typeof paths; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill={name === 'star' ? 'currentColor' : 'none'}
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"><path d={paths[name]} /></svg>
