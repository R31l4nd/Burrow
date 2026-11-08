import { android, androidInfo } from './android.js';
import { get } from './api.js';

// A newer Android app on this Burrow than the one running: said once per
// version with a message, and as a dot on Settings until updated
// (Settings -> Android has the button).

export interface Apk {
  versionName: string;
  versionCode: number;
  sha256: string;
  size: number;
}

export const appUpdate = $state<{ apk: Apk | null }>({ apk: null });

/** Looks once (in the app only); returns the newer APK's version when it is new to this phone. */
export async function checkAppUpdate(): Promise<string | null> {
  if (!android) return null;
  const [info, a] = await Promise.all([androidInfo(), get<{ apk: Apk | null }>('/api/android')]);
  appUpdate.apk = info && a.apk && a.apk.versionCode > info.versionCode ? a.apk : null;
  if (!appUpdate.apk) return null;
  const key = 'burrow.appUpdateTold';
  try {
    if (localStorage.getItem(key) === appUpdate.apk.versionName) return null;
    localStorage.setItem(key, appUpdate.apk.versionName);
  } catch {
    // Not remembered: said again next time.
  }
  return appUpdate.apk.versionName;
}

/** Download and hand to Android's installer (apps from 1.5.1 on); older apps get the plain download. */
export async function installAppUpdate(apk: Apk, appVersionCode: number): Promise<'permission' | 'installing' | 'download'> {
  if (!android || appVersionCode < 10501) {
    location.href = '/api/android/burrow.apk';
    return 'download';
  }
  const r = await android.installUpdate(apk.sha256);
  return r.state;
}
