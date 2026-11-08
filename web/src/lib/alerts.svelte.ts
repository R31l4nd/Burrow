import { get } from './api.js';

// Unread alerts, for the count on the Containers tab.
export const alertState = $state<{ unread: number }>({ unread: 0 });

export async function loadAlertCount(): Promise<void> {
  try {
    alertState.unread = (await get<{ n: number }>('/api/alerts/unread')).n;
  } catch {
    // Offline or signed out: keep the last count.
  }
}
