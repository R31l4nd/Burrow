import { t } from './i18n/index.svelte.js';

/** Docker's health states in words; anything else as Docker says it. */
export function healthLabel(h: string): string {
  return h === 'healthy' ? t('containers.health.healthy') : h === 'unhealthy' ? t('containers.health.unhealthy') : h === 'starting' ? t('containers.health.starting') : h;
}
