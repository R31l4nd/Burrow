<script lang="ts">
  import { brokenPictures } from '../lib/brokenpictures.js';
  import { needsReading, type Changelog, type Release } from '@burrow/shared';
  import { errorMessage, get } from '../lib/api.js';
  import { dateOnly, t } from '../lib/i18n/index.svelte.js';
  import { markdownToHtml } from '../lib/markdown.js';
  import { releaseImageAllowed } from '@burrow/shared';
  import Dialog from './Dialog.svelte';

  // What is new in one image or several: the release notes of each one's
  // GitHub repository after the version on the host. What to read before
  // updating comes first, once, over all of them; then per image each
  // version, newest first, its notes as formatted text (escaped: never HTML
  // from the notes, links only to http(s)). Several at once (reports 26c0fa,
  // bd2d76): each image's versions folded under its name.

  type ChangelogItem = { hostId: number; image: string };

  let { items, onclose }: { items: ChangelogItem[] | null; onclose: () => void } = $props();

  type Read = { item: ChangelogItem; log: Changelog | null; error: string };
  let reads = $state<Read[]>([]);

  $effect(() => {
    const list = items;
    reads = (list ?? []).map((item) => ({ item, log: null, error: '' }));
    if (!list) return;
    list.forEach((item, i) => {
      get<Changelog>(`/api/docker/${item.hostId}/changelog?image=${encodeURIComponent(item.image)}`).then(
        (c) => items === list && (reads[i]!.log = c),
        (err: unknown) => items === list && (reads[i]!.error = errorMessage(err)),
      );
    });
  });

  // "ghcr.io/org/app:1.2" -> "app": the name a person knows it by.
  // GitHub's pictures in the notes, through Burrow (report 64498b); others stay links.
  const picture = (src: string) => (releaseImageAllowed(src) ? `/api/changelog/image?url=${encodeURIComponent(src)}` : null);
  const short = (img: string) => img.replace(/@.*$/, '').replace(/:[^/:]*$/, '').split('/').pop() || img;
  const several = $derived(reads.length > 1);
  const releasesOf = (r: Read) => r.log?.releases ?? [];
  // Everything to read first, with the image (when several) and the version it comes from.
  const mustRead = $derived(
    reads.flatMap((r) =>
      releasesOf(r).flatMap((rel) => [...rel.flags.breaking.map((line) => ({ who: short(r.item.image), v: rel.name, line })), ...(rel.flags.major && !rel.flags.breaking.length ? [{ who: short(r.item.image), v: rel.name, line: t('changelog.majorLine') }] : [])]),
    ),
  );
  const worth = $derived(reads.flatMap((r) => releasesOf(r).flatMap((rel) => rel.flags.important.map((line) => ({ who: short(r.item.image), v: rel.name, line })))));
  // Grouped by image and version: its name once, its lines under it (report 588254: the name before
  // every line). Worth knowing: a few lines each, the rest in its notes below.
  type Line = { who: string; v: string; line: string };
  const grouped = (lines: Line[]) =>
    lines.reduce<{ head: string; lines: string[] }[]>((out, m) => {
      const head = several ? `${m.who} ${m.v}` : m.v;
      if (out.at(-1)?.head === head) out.at(-1)!.lines.push(m.line);
      else out.push({ head, lines: [m.line] });
      return out;
    }, []);
  const WORTH_LINES = 3;
  // An address in a line: in the type of machine text, broken where it must (report 588254: it ran off
  // the screen); the words around it stay whole.
  const pieces = (line: string) => line.split(/(<?https?:\/\/\S+)/).filter(Boolean).map((text) => ({ text, address: /^<?https?:\/\//.test(text) }));
  const loading = $derived(reads.some((r) => !r.log && !r.error));
  // Open at first, for one image: the newest, and every one with something to
  // read first. For several all folded: the boxes above say what to read.
  const openAtFirst = (r: Release, i: number) => !several && (i === 0 || needsReading(r.flags));
  const title = $derived(several ? t('changelog.whatsNewN', { n: reads.length }) : t('changelog.whatsNew', { name: reads[0] ? short(reads[0].item.image) : '' }));
  const summary = (log: Changelog) => {
    const rels = log.releases;
    if (!rels.length) return t('changelog.none');
    // Why not (report 9190c5): the image says no version, or one that is not among the releases.
    if (!log.matched) return log.version ? t('changelog.notFound', { v: log.version }) : t('changelog.latest');
    return rels.length === 1 ? t('changelog.oneNewer', { v: rels[0]!.name }) : t('changelog.newer', { n: rels.length, from: rels[rels.length - 1]!.name, to: rels[0]!.name });
  };
</script>

{#snippet lineOf(line: string)}{#each pieces(line) as p, k (k)}{#if p.address}<span class="mono address">{p.text}</span>{:else}{p.text}{/if}{/each}{/snippet}

<Dialog tour={several ? 'changelogs' : 'changelog'} size="wide" open={items !== null && items.length > 0} {title} {onclose}>
  <div class="stack" data-testid="changelog">
    {#if mustRead.length}
      <section class="box bad" data-testid="changelog-breaking">
        <h3>{t('changelog.readFirst')}</h3>
        <ul class="groups">
          {#each grouped(mustRead) as g, i (i)}
            <li><span class="v">{g.head}</span> <ul>{#each g.lines as line, j (j)}<li>{@render lineOf(line)}</li>{/each}</ul></li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if worth.length}
      <section class="box warn" data-testid="changelog-important">
        <h3>{t('changelog.worthKnowing')}</h3>
        <ul class="groups">
          {#each grouped(worth) as g, i (i)}
            <li data-testid="worth-group">
              <span class="v">{g.head}</span> <ul>{#each g.lines.slice(0, WORTH_LINES) as line, j (j)}<li>{@render lineOf(line)}</li>{/each}</ul>
              {#if g.lines.length > WORTH_LINES}<span class="dim small">{t('changelog.moreInNotes', { n: g.lines.length - WORTH_LINES })}</span>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}
    {#if several && loading}<p class="dim small">{t('changelog.reading', { n: reads.filter((r) => r.log || r.error).length, total: reads.length })}</p>{/if}

    {#each reads as r (r.item.hostId + ' ' + r.item.image)}
      <section class="img" class:several data-testid="changelog-image">
        {#if several}<h3 class="iname">{short(r.item.image)}</h3>{/if}
        <p class="image mono small dim">{r.item.image}</p>
        {#if r.error}
          <p class="alert error small">{r.error}</p>
        {:else if !r.log}
          <p class="dim small">{t('common.loading')}</p>
        {:else}
          <p class="summary" class:dim={!r.log.releases.length}>{summary(r.log)}</p>
          {#each r.log.releases as rel, i (rel.tag)}
            <details class="rel" open={openAtFirst(rel, i)} data-testid="release">
              <summary data-testid="release-head">
                <span class="name">{rel.name}</span>
                {#if rel.flags.breaking.length}<span class="tag bad" data-testid="release-breaking">{t('changelog.tagBreaking')}</span>
                {:else if rel.flags.major}<span class="tag bad">{t('changelog.tagMajor')}</span>{/if}
                {#if rel.flags.important.length}<span class="tag warn">{t('changelog.tagImportant')}</span>{/if}
                {#if rel.publishedAt}<span class="when">{dateOnly(rel.publishedAt)}</span>{/if}
              </summary>
              {#if rel.body.trim()}
                <!-- markdownToHtml escapes everything; links only to http(s); GitHub's pictures through Burrow (web/src/lib/markdown.ts). -->
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <div class="body" use:brokenPictures data-testid="changelog-body">{@html markdownToHtml(rel.body.trim(), { links: true, image: picture, pictureLabel: t('changelog.picture') })}</div>
              {:else}
                <p class="dim small">{t('changelog.noNotes')}</p>
              {/if}
              <a class="small" href={rel.url} target="_blank" rel="noopener noreferrer">{t('changelog.onGithub', { v: rel.name })}</a>
            </details>
          {/each}
          <a class="small" href={r.log.url} target="_blank" rel="noopener noreferrer">{t('changelog.all')}</a>
        {/if}
      </section>
    {/each}
  </div>
</Dialog>

<style>
  .img {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  /* Each image of several under its own name, apart from the next. */
  .img.several + .img.several {
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .iname {
    margin: 0;
    font-size: 1rem;
    text-transform: none;
    letter-spacing: normal;
    color: var(--text);
  }
  .image {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .img:not(.several) > .image:first-child {
    margin-top: -6px;
  }
  .summary {
    margin: 0;
    font-weight: 600;
  }
  /* Under an image's own name the count is a plain line. */
  .several .summary {
    font-weight: 400;
    font-size: 0.88rem;
  }
  .box {
    border-radius: 10px;
    padding: 10px 12px;
    border: 1px solid;
  }
  .box.bad {
    border-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 8%, transparent);
  }
  .box.warn {
    border-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 8%, transparent);
  }
  .box h3 {
    margin: 0 0 6px;
    font-size: 0.9rem;
    /* A heading of its own, not the app's small section label. */
    text-transform: none;
    letter-spacing: normal;
    color: var(--text);
    font-weight: 700;
  }
  .box ul {
    margin: 0;
    padding-left: 18px;
    font-size: 0.88rem;
    overflow-wrap: break-word;
  }
  /* Each image and version a group: its name, its lines under it, a line between groups. */
  .box ul.groups {
    list-style: none;
    padding-left: 0;
  }
  .groups > li + li {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, currentColor 15%, transparent);
  }
  /* A long address in a line wraps inside the box (report 588254). */
  .address {
    overflow-wrap: anywhere;
    font-size: 0.82rem;
  }
  .groups ul {
    margin-top: 2px;
  }
  .groups ul li + li {
    margin-top: 2px;
  }
  .v {
    font-weight: 700;
  }
  /* The app's own folding header (app.css): each version a row, its notes below. */
  .rel[open] {
    padding-bottom: 6px;
  }
  .rel[open] > summary {
    margin-bottom: 8px;
  }
  .rel > :not(summary) {
    margin-left: 14px;
    margin-right: 6px;
  }
  .name {
    font-weight: 700;
  }
  /* A label and a date stay whole (report 0d33eb: "breakin|g" in Edge at 125%); the row wraps between them instead. */
  .when,
  .tag {
    white-space: nowrap;
  }
  .when {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .tag {
    font: 700 0.68rem var(--font);
    border-radius: 5px;
    padding: 1px 8px;
    border: 1px solid currentColor;
  }
  .tag.bad {
    color: var(--danger);
  }
  .tag.warn {
    color: var(--warn);
  }
  .body {
    font-size: 0.88rem;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .body :global(h2),
  .body :global(h3),
  .body :global(h4) {
    font-size: 0.92rem;
    margin: 12px 0 4px;
    text-transform: none;
    letter-spacing: normal;
    color: var(--text);
  }
  .body > :global(:first-child) {
    margin-top: 0;
  }
  /* A picture in the notes: within the dialog's width, its own proportions. */
  .body :global(img) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: 6px 0;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }
  .body :global(p) {
    margin: 4px 0;
  }
  .body :global(ul),
  .body :global(ol) {
    margin: 4px 0;
    padding-left: 20px;
  }
  .body :global(li + li) {
    margin-top: 2px;
  }
  .body :global(code) {
    font-family: var(--mono);
    font-size: 0.82rem;
    background: var(--bg-sunken);
    border-radius: 4px;
    padding: 0 4px;
  }
  .body :global(pre) {
    background: var(--bg-sunken);
    border-radius: 6px;
    padding: 8px;
    overflow: auto;
  }
  .body :global(pre code) {
    background: none;
    padding: 0;
  }
  .body :global(blockquote) {
    margin: 6px 0;
    padding-left: 10px;
    border-left: 3px solid var(--border);
    color: var(--text-dim);
  }
</style>
