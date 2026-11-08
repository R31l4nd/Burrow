// The Android app's direct SSH route: what Burrow hands the phone for use
// when Burrow itself cannot be reached (GET /api/android/cache).

export interface DirectHost {
  id: number;
  name: string;
  address: string;
  port: number;
  username: string;
  groupId: number | null;
  favorite: boolean;
  color: string | null;
  encoding: string | null;
  /** The host keys Burrow trusts for this address and port. */
  hostKeys: { keyType: string; keyB64: string; fingerprint: string }[];
  history: { command: string; count: number; lastAt: string }[];
}

export interface DirectCache {
  generatedAt: string;
  deviceId: number;
  hosts: DirectHost[];
  snippets: { id: number; name: string; command: string; description: string | null; hostId: number | null; groupId: number | null }[];
  groups: { id: number; name: string; parentId: number | null }[];
}

export interface DeviceHostResult {
  hostId: number;
  hostName: string;
  ok: boolean;
  message?: string;
}
