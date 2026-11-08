import { android, type AllFilesStatus } from './android.js';
import { ask } from './confirm.svelte.js';
import { t } from './i18n/index.svelte.js';
import { phoneFailure } from './phonefiles.js';
import { toast } from './ui.svelte.js';

/**
 * "All files" switched on or off (report 862305), as the person chose: on only after a warning
 * that says what it gives the page, then Android's own screen; off at once, with where Android's
 * permission is taken back. The status after, or null when nothing changed.
 */
export async function switchAllFiles(on: boolean): Promise<AllFilesStatus | null> {
  if (!android) return null;
  try {
    if (on) {
      if (!(await ask({ text: t('phone.allFilesWarn'), confirm: t('phone.allFilesOn'), danger: true }))) return null;
      const s = await android.phoneSetAllFiles(true);
      toast(s.on ? t('phone.allFilesIsOn') : t('phone.allFilesRefused'), s.on ? 'info' : 'error');
      return s;
    }
    const s = await android.phoneSetAllFiles(false);
    toast(t('phone.allFilesIsOff'));
    return s;
  } catch (err) {
    toast(phoneFailure(err).message, 'error');
    return null;
  }
}
