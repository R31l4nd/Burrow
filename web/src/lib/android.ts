import { PortBridge, type Port } from './port.js';

// The bridge to the Android app. The app injects `BurrowAndroid` (a
// WebMessageListener, only into pages of the configured server origin); see
// port.ts for the message format. In a normal browser there is no bridge
// and `android` is null.

export interface AndroidInfo {
  version: string;
  versionCode: number;
  deviceId: number | null;
  deviceName: string;
  /** Profiles per app tab (own cookies) are supported by this WebView. */
  profiles: boolean;
  /** Screenshots of the app are allowed (off by default). */
  screenshots: boolean;
  /** A test build: always allowed, not a setting. */
  screenshotsFixed: boolean;
  /** A shake of the phone reports a problem (on by default). */
  shake: boolean;
  /** Android's own menu over the terminal's selection (apps from 1.8.0). */
  selectionMenu?: boolean;
  /** A WireGuard QR code read with the camera (wgScan; apps from 1.26.0). */
  qrCamera?: boolean;
  /** The phone's own files on the Files page (phone*; apps from 2.0.0). */
  phoneFiles?: boolean;
  /** "All files" can be switched on (phoneAllFiles*; apps from 2.7.0 on Android 11 and later). */
  phoneAllFiles?: boolean;
  /** Delete, rename and a new folder on the phone (phoneDelete, phoneRename, phoneMkdir; apps from 2.18.0). */
  phoneChange?: boolean;
  /** Archives as folders and unpacked, open with (the chooser), share (phoneArchive*, phoneUnpack, phoneShare; apps from 2.19.0; report 99d993). */
  phoneArchives?: boolean;
  /** forgetDevice, wgSave and setScreenshots(true) are asked by the app itself, which answers {cancelled} on No (apps from 2.19.0). */
  asksItself?: boolean;
  /** The home screen widget (widget*; apps from 2.11.0). */
  widget?: boolean;
}

/** How the widget gets its numbers away from home: the tunnel up for a moment, the last ones, or by push. */
export type WidgetAway = 'tunnel' | 'last' | 'push';

/** A folder of the phone the person granted (Android's folder picker); lost: Android no longer lets the app in. */
export interface PhoneRoot {
  id: string;
  name: string;
  writable: boolean;
  lost: boolean;
  /** A storage volume of "All files" (report 862305), not a folder picked; switched off instead of removed. */
  all?: boolean;
}

/** "All files": whether Android has it at all (11+), whether it gave the app the permission, and whether the person switched it on. */
export interface AllFilesStatus {
  available: boolean;
  granted: boolean;
  on: boolean;
}

/** A file or folder in a granted folder: its path is "/<folder id>/<names>". */
export interface PhoneEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size: number;
  mtime: string | null;
  mime: string;
  writable: boolean;
  /** May be deleted, or renamed (apps from 2.18.0; report 6eaf00). */
  deletable?: boolean;
  renamable?: boolean;
}

export interface PhoneListing {
  path: string;
  /** "/" at a granted folder's top (the list of folders). */
  parent: string | null;
  root: { id: string; name: string };
  names: string[];
  /** New files may be made here (a host's file copied in). */
  canCreate: boolean;
  /** More entries than the app lists (5000). */
  truncated: boolean;
  entries: PhoneEntry[];
}

/** What is in a folder of an archive of the phone (zip, jar, apk, tar, tar.gz). */
export interface PhoneArchive {
  /** The archive's own path, and the folder inside it ("" its top). */
  path: string;
  inner: string;
  name: string;
  /** More entries than the app lists. */
  truncated: boolean;
  entries: { name: string; path: string; type: 'dir' | 'file'; size: number; mtime: string | null; mime: string }[];
}

export interface PhoneText {
  path: string;
  content: string;
  hash: string;
  size: number;
  mtime: string | null;
  writable: boolean;
}

/** A file the app holds (shared into Burrow, or edited in another app). */
export interface NativeFile {
  token: string;
  name: string;
  mime: string;
  size: number;
}

/** A download the app runs itself: a page's download link, or an app update. */
export interface NativeDownload {
  id: number;
  name: string;
  kind: 'file' | 'update';
  state: 'running' | 'done' | 'failed' | 'stopped';
  done: number;
  /** -1 when the server does not say. */
  total: number;
  error: string | null;
  secondsLeft: number | null;
}

export interface ChangedFile extends NativeFile {
  hostId: number;
  path: string;
}

class Bridge extends PortBridge {
  info = () => this.call<AndroidInfo>('info');
  /** A new Keystore key that needs a fingerprint for every use; returns its SPKI. */
  createKey = () => this.call<{ publicKey: string }>('createKey');
  saveDevice = (deviceId: number) => this.call('saveDevice', { deviceId });
  /** Text made here (an exported log) saved in the phone's Downloads/Burrow: a blob link goes nowhere in the app (AUDIT2 AND-11). */
  saveText = (name: string, text: string) => this.call('saveText', { name, text });
  /** Sign a Burrow device message after a fingerprint; rejects when cancelled. */
  sign = (message: string) => this.call<{ signature: string }>('sign', { message });
  forgetDevice = () => this.call<{ cancelled: true } | null>('forgetDevice');
  // The app fetches the file itself (with this page's cookie) and picks
  // the type from the name. An edited file comes back as "fileChanged".
  openWith = (p: { url: string; name: string; hostId: number; path: string; editable: boolean }) => this.call('openWith', p);
  share = (p: { url: string; name: string }) => this.call('share', p);
  sharedFiles = () => this.call<NativeFile[]>('sharedFiles');
  /** Up to `length` bytes of a held file, base64. */
  read = (token: string, offset: number, length: number) => this.call<{ data: string }>('read', { token, offset, length });
  release = (token: string) => this.call('release', { token });
  transfers = (active: number, label: string) => this.call('transfers', { active, label });
  shortcuts = (hosts: { id: number; name: string }[]) => this.call('shortcuts', { hosts });
  openApp = (app: { id: number; name: string; url: string }) => this.call('openApp', app);
  /** The ids of the apps open as tabs in the app now. */
  openApps = () => this.call<number[]>('openApps');
  /** The OpenSSH line of the app's direct-route key (made on first use). */
  sshPublicKey = () => this.call<{ publicKey: string }>('sshPublicKey');
  /** Fetch the direct route's offline cache from Burrow now. */
  syncDirect = () => this.call('syncDirect');
  /** The direct route's page; with a host, a session to it right away. */
  openDirect = (hostId?: number) => this.call('openDirect', hostId ? { hostId } : {});
  setScreenshots = (allow: boolean) => this.call('setScreenshots', { allow });
  /** The page as it is on the screen now, at most `maxWidth` pixels wide (a JPEG data URL); apps from 2.9.2. */
  screenshot = (maxWidth: number) => this.call<{ picture: string; width: number; height: number }>('screenshot', { maxWidth });
  /** The colour of the page's top (its title bar on a phone): the app paints the status bar above it alike. */
  chrome = (top: string) => this.call('chrome', { top });
  /** A shake reports a problem: on or off on this phone; the app sends "shake". */
  setShake = (on: boolean) => this.call('setShake', { on });
  /** Burrow's own push: where it reaches this phone (UnifiedPush), or null when off. */
  pushState = () => this.call<{ url: string; p256dh: string; auth: string } | null>('pushState');
  /** On, through the phone's UnifiedPush distributor; the address follows as "pushEndpoint". */
  pushRegister = (vapid: string) => this.call('pushRegister', { vapid });
  pushUnregister = () => this.call('pushUnregister');
  /** The home screen widget: how it gets its numbers away from home, and whether one is placed (apps from 2.11.0). */
  widgetState = () => this.call<{ away: WidgetAway; placed: boolean }>('widgetState');
  setWidgetAway = (away: WidgetAway) => this.call('setWidgetAway', { away });
  /** The widget's own key (apps from 2.12.0): reads the widget's counts once the app's sign-in ran out. */
  widgetKey = () => this.call<{ publicKey: string }>('widgetKey');
  /** A newer app from this Burrow: downloaded, checked against its SHA-256, and handed to Android's installer. */
  installUpdate = (sha256: string) => this.call<{ state: 'permission' | 'installing' }>('installUpdate', { sha256 });
  /** The app's own downloads (apps from 1.10.0); changes follow as "downloads". */
  downloads = () => this.call<NativeDownload[]>('downloads');
  stopDownload = (id: number) => this.call('stopDownload', { id });
  retryDownload = (id: number) => this.call('retryDownload', { id });
  /** While a terminal is shown: plain keyboard input, the volume keys as keys, the screen kept on. */
  terminal = (mode: { input: boolean; keys: boolean; screen: boolean }) => this.call('terminal', mode);
  /** Android's floating menu (Copy, Paste, Select all) over this box of the page, or gone with null; picks come back as "selectionAction". */
  selectionMenu = (box: { x: number; y: number; w: number; h: number } | null) => this.call('selectionMenu', box ?? {});
  // The app's own WireGuard (phase 13): the configuration goes to the phone
  // only (never to Burrow), and comes back only as a summary without the key.
  wgStatus = () => this.call<WireGuardStatus>('wgStatus');
  wgSave = (conf: string) => this.call<{ error: string | null } | { cancelled: true }>('wgSave', { conf });
  /** The camera reads the QR code and the app keeps it; the page gets only whether it worked. */
  wgScan = () => this.call<{ error?: string | null; cancelled?: boolean }>('wgScan');
  wgRemove = () => this.call('wgRemove');
  wgTargets = (viaBurrow: boolean, hosts: string[]) => this.call<WireGuardStatus>('wgTargets', { viaBurrow, hosts });
  // The phone's own files (Files -> This phone): only folders the person
  // picked in Android's folder picker. What these return stays on the page;
  // nothing goes to Burrow unless a file is copied to a host.
  phoneRoots = () => this.call<PhoneRoot[]>('phoneRoots');
  /** Android's folder picker, starting at the phone's Documents or Download folder. */
  phoneAddRoot = (start: 'documents' | 'downloads' | '') => this.call<{ id: string; name: string; writable: boolean } | { cancelled: true }>('phoneAddRoot', { start });
  /** Off the list, and its permission given back to Android. */
  phoneRemoveRoot = (id: string) => this.call('phoneRemoveRoot', { id });
  phoneAllFiles = () => this.call<AllFilesStatus>('phoneAllFiles');
  /** On: Android's "All files access" screen first when the app does not have it yet. */
  phoneSetAllFiles = (on: boolean) => this.call<AllFilesStatus>('phoneSetAllFiles', { on });
  /** Android's own screen for the permission (to take it back there). */
  phoneAllFilesSettings = () => this.call('phoneAllFilesSettings');
  phoneList = (path: string) => this.call<PhoneListing>('phoneList', { path });
  /** A text file up to 5 MB, with the SHA-256 a save is checked against. */
  phoneText = (path: string) => this.call<PhoneText>('phoneText', { path });
  phoneSaveText = (path: string, content: string, baseHash: string) => this.call<PhoneText | { conflict: true }>('phoneSaveText', { path, content, baseHash });
  /** Files held by token, read with read(): to show ("view"), or to upload ("upload": the share page lists them). */
  phoneHold = (paths: string[], purpose: 'view' | 'upload') => this.call<NativeFile[]>('phoneHold', { paths, purpose });
  /** Another app of the phone shows it (a PDF, a video). */
  phoneOpen = (path: string, chooser = false) => this.call('phoneOpen', { path, chooser });
  /** Android's share list for these files. */
  phoneShare = (paths: string[]) => this.call('phoneShare', { paths });
  phoneArchive = (path: string, inner: string) => this.call<PhoneArchive>('phoneArchive', { path, inner });
  /** One file of an archive, shown by another app. */
  phoneArchiveOpen = (path: string, inner: string, chooser = false) => this.call('phoneArchiveOpen', { path, inner, chooser });
  /** Unpacked into a new folder beside it; "phoneProgress" events with this id say how far. */
  phoneUnpack = (path: string, id: string) => this.call<{ path: string; files: number }>('phoneUnpack', { path, id });
  /** Deleted after the app's own question, not the page's (report 6eaf00): cancelled when the person said no there. */
  phoneDelete = (paths: string[]) => this.call<{ deleted: number } | { cancelled: true }>('phoneDelete', { paths });
  /** Renamed in its folder: its path then. */
  phoneRename = (path: string, name: string) => this.call<{ path: string }>('phoneRename', { path, name });
  /** A new folder in [dir]: its path. */
  phoneMkdir = (dir: string, name: string) => this.call<{ path: string }>('phoneMkdir', { dir, name });
  /** A host's file (Burrow's own address) downloaded by the app into a granted folder; its progress follows as "downloads". */
  phoneSaveFrom = (p: { url: string; name: string; dir: string }) => this.call<{ id: number }>('phoneSaveFrom', p);
}

export interface WireGuardStatus {
  configured: boolean;
  /** Up now (away from home). */
  active: boolean;
  viaBurrow: boolean;
  /** Other host names through the tunnel: app tabs, direct-route hosts. */
  hosts: string[];
  error: string | null;
  /** This WebView can send only some addresses through the tunnel. */
  proxyOverride: boolean;
  lastHandshake?: number;
  address?: string;
  endpoint?: string;
  allowedIps?: string;
}

const port = (globalThis as { BurrowAndroid?: Port }).BurrowAndroid;
export const android: Bridge | null = port ? new Bridge(port) : null;
// The app can only push events (a file edited elsewhere) once the page has
// sent something: say hello right away.
void android?.call('hello').catch(() => {});

// The direct route's page runs on the app's own origin, with its own
// storage: it gets this device's language, theme and terminal settings.
if (android) {
  const keys = ['burrow.locale', 'burrow.appearance', 'burrow.terminal'];
  const values: Record<string, string> = {};
  try {
    for (const k of keys) {
      const v = localStorage.getItem(k);
      if (v !== null) values[k] = v;
    }
  } catch {
    // Nothing to hand over.
  }
  void android.call('uiPrefs', { values }).catch(() => {});
}

let infoCache: Promise<AndroidInfo | null> | null = null;
export function androidInfo(): Promise<AndroidInfo | null> {
  infoCache ??= android ? android.info().catch(() => null) : Promise.resolve(null);
  return infoCache;
}
export const refreshAndroidInfo = () => {
  infoCache = null;
  return androidInfo();
};

/** Something the upload queue can read in pieces: a File, or a file the app holds. */
export interface UploadSource {
  name: string;
  size: number;
  slice(start: number, end: number): Blob | Promise<Blob>;
}

export function nativeSource(f: NativeFile): UploadSource {
  return {
    name: f.name,
    size: f.size,
    // In 1 MiB messages: large strings over the bridge are slow to copy.
    async slice(start, end) {
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (let at = start; at < Math.min(end, f.size); ) {
        const { data } = await android!.read(f.token, at, Math.min(1 << 20, end - at));
        const bin = atob(data);
        if (!bin.length) break;
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        parts.push(bytes);
        at += bytes.length;
      }
      return new Blob(parts);
    },
  };
}

/**
 * Tells Burrow this phone's widget key, once per start, when this phone is
 * paired and signed in with its own key (Burrow takes it only then). Failing
 * is quiet: the widget then asks with the app's sign-in only.
 */
export async function syncWidgetKey(put: (url: string, body: unknown) => Promise<unknown>): Promise<boolean> {
  const info = await androidInfo();
  if (!android || !info?.widget || !info.deviceId) return false;
  try {
    const { publicKey } = await android.widgetKey();
    await put(`/api/account/devices/${info.deviceId}/widget-key`, { publicKey });
    return true;
  } catch {
    return false;
  }
}
