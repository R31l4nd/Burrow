// Request/response and events over a WebMessage port injected by the
// Android app (a WebMessageListener object such as `BurrowAndroid`).
// Messages are JSON: requests { id, method, params } answered with
// { id, result } or { id, error }, and events { event, data } pushed by the
// app.

export interface Port {
  postMessage(message: string): void;
  onmessage: ((e: { data: string }) => void) | null;
}

type Handler = (data: unknown) => void;

export class PortBridge {
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #listeners = new Map<string, Set<Handler>>();

  constructor(private readonly port: Port) {
    port.onmessage = (e) => {
      let m: { id?: number; result?: unknown; error?: string; event?: string; data?: unknown };
      try {
        m = JSON.parse(e.data) as typeof m;
      } catch {
        return;
      }
      if (m.event) {
        for (const fn of this.#listeners.get(m.event) ?? []) fn(m.data);
        return;
      }
      const p = m.id !== undefined ? this.#pending.get(m.id) : undefined;
      if (!p) return;
      this.#pending.delete(m.id!);
      if (m.error !== undefined) p.reject(new Error(m.error));
      else p.resolve(m.result);
    };
  }

  call<T = void>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, fn: Handler): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
}
