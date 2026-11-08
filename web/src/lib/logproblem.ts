import { t } from './i18n/index.svelte.js';

/**
 * Why a log source could not be read, in words: docker's own text ("Error response from daemon:
 * No such container: name") stood in a red box above the log (report 931cd0). What is not known
 * here stays as the server said it, without docker's prefix.
 */
export function sourceProblem(message: string): string {
  if (/no such container/i.test(message)) return t('logs.goneContainer');
  return message.replace(/^Error response from daemon:\s*/i, '');
}
