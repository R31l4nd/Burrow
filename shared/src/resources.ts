import { z } from 'zod';

// A host's Docker images, volumes and networks, with the containers that use
// each (Portainer, Dockhand and Arcane have such pages; docs/PRIOR-ART.md).

export interface ImageResource {
  /** sha256:... */
  id: string;
  /** "nginx:1.27"; empty for a dangling image. */
  tags: string[];
  sizeBytes: number;
  created: string | null;
  /** Container names (stopped ones too) that run it. */
  usedBy: string[];
}

export interface VolumeResource {
  name: string;
  driver: string;
  /** The compose project that made it, from its labels. */
  project: string | null;
  usedBy: string[];
}

export interface NetworkResource {
  id: string;
  name: string;
  driver: string;
  /** bridge, host, none: Docker's own, never removed. */
  builtin: boolean;
  usedBy: string[];
}

export interface DockerResources {
  hostId: number;
  images: ImageResource[];
  volumes: VolumeResource[];
  networks: NetworkResource[];
  /** Burrow's own compose project on this host, if it runs here: its things are never removed. */
  selfProject: string | null;
  /** What uses them could not be read: then nothing counts as unused (AUDIT2 DO-11). */
  usageUnknown?: boolean;
}

export const pruneInput = z.object({
  images: z.array(z.string().regex(/^sha256:[0-9a-f]{64}$/)).max(500).default([]),
  volumes: z.array(z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).max(500).default([]),
  networks: z.array(z.string().regex(/^[0-9a-f]{12,64}$/)).max(200).default([]),
});

export interface PruneResult {
  removed: { images: string[]; volumes: string[]; networks: string[] };
  /** Not removed: in use again, Burrow's own, gone, or Docker said no. */
  skipped: { kind: 'image' | 'volume' | 'network'; id: string; why: string }[];
  /** Bytes freed by the images removed (volumes are not measured). */
  freedBytes: number;
}

/** What nothing uses now and may go (never Burrow's own, never Docker's networks). */
export function unused(r: DockerResources): { images: ImageResource[]; volumes: VolumeResource[]; networks: NetworkResource[] } {
  if (r.usageUnknown) return { images: [], volumes: [], networks: [] };
  return {
    images: r.images.filter((i) => !i.usedBy.length),
    volumes: r.volumes.filter((v) => !v.usedBy.length && (!r.selfProject || v.project !== r.selfProject)),
    networks: r.networks.filter((n) => !n.usedBy.length && !n.builtin && (!r.selfProject || !n.name.startsWith(`${r.selfProject}_`))),
  };
}
