import { randomUUID } from "node:crypto";

/**
 * Minimal shared CDP debugger ownership adapter (C2B.1).
 * Does not own BrowserCore / WebContentsView / Browser Sessions.
 * Operates only on an explicitly bound WebContents-like target.
 */

export type CdpConsumerId =
  | "screenshot"
  | "typeOnly"
  | "screencast"
  | "fileChooser"
  | "collectorNetwork"
  | (string & {});

export type CdpLeaseFailReason =
  | "unexpected-detach"
  | "view-replaced"
  | "destroyed"
  | "released"
  | "acquire-failed";

export type CdpDomainName = "Network";

export type CdpDebuggerMessageHandler = (
  event: unknown,
  method: string,
  params: Record<string, unknown>,
  sessionId: string,
) => void;

/** Electron Debugger subset used by the adapter (mockable). */
export type CdpDebuggerLike = {
  isAttached(): boolean;
  attach(protocolVersion: string): void;
  detach(): void;
  sendCommand(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown>;
  on(event: "message" | "detach", listener: (...args: unknown[]) => void): void;
  removeListener(
    event: "message" | "detach",
    listener: (...args: unknown[]) => void,
  ): void;
  listenerCount?(event: "message" | "detach"): number;
};

export type CdpWebContentsLike = {
  debugger: CdpDebuggerLike;
  isDestroyed(): boolean;
};

export type CdpDebuggerSessionOptions = {
  /** When true (default), last release detaches only if this adapter attached. */
  detachWhenIdle?: boolean;
  protocolVersion?: string;
};

export type CdpDebuggerDiagnostics = {
  generation: number;
  bound: boolean;
  leaseCount: number;
  adapterOwnsAttach: boolean;
  networkTenantCount: number;
  networkOwnedByAdapter: boolean;
  messageListenerCount: number;
  lastError?: string;
};

export type CdpLease = {
  readonly token: string;
  readonly consumer: CdpConsumerId;
  readonly generation: number;
  readonly alive: boolean;
  readonly failReason?: CdpLeaseFailReason;
  release(): Promise<void>;
};

/** BrowserCore binds one session per Meta-browser debugger; Recording looks it up without main.ts wiring. */
const sessionsByDebugger = new WeakMap<object, CdpDebuggerSession>();

export function getCdpSessionForDebugger(
  debuggerApi: object,
): CdpDebuggerSession | undefined {
  return sessionsByDebugger.get(debuggerApi);
}

export function requireCdpSessionForDebugger(
  debuggerApi: object,
): CdpDebuggerSession {
  const session = getCdpSessionForDebugger(debuggerApi);
  if (!session) {
    throw new Error(
      "CdpDebuggerSession: no shared session bound for this WebContents debugger",
    );
  }
  return session;
}

type InternalLease = {
  token: string;
  consumer: CdpConsumerId;
  generation: number;
  alive: boolean;
  failReason?: CdpLeaseFailReason;
  released: boolean;
  messageWrappers: Map<CdpDebuggerMessageHandler, (...args: unknown[]) => void>;
  networkHeld: boolean;
};

export class CdpDebuggerSession {
  private readonly detachWhenIdle: boolean;
  private readonly protocolVersion: string;
  private wc: CdpWebContentsLike | null = null;
  private generation = 0;
  private adapterOwnsAttach = false;
  private networkOwnedByAdapter = false;
  private networkTenants = new Set<string>();
  private leases = new Map<string, InternalLease>();
  private detachListener: ((...args: unknown[]) => void) | null = null;
  private unexpectedDetachHandlers = new Set<
    (info: { reason?: string; generation: number }) => void
  >();
  private chain: Promise<unknown> = Promise.resolve();
  private lastError?: string;
  private invalidating = false;
  /** True while this adapter intentionally calls detach() — ignore the resulting event. */
  private selfDetaching = false;

  constructor(options: CdpDebuggerSessionOptions = {}) {
    this.detachWhenIdle = options.detachWhenIdle !== false;
    this.protocolVersion = options.protocolVersion ?? "1.3";
  }

  diagnostics(): CdpDebuggerDiagnostics {
    let messageListenerCount = 0;
    for (const lease of this.leases.values()) messageListenerCount += lease.messageWrappers.size;
    return {
      generation: this.generation,
      bound: Boolean(this.wc),
      leaseCount: this.leases.size,
      adapterOwnsAttach: this.adapterOwnsAttach,
      networkTenantCount: this.networkTenants.size,
      networkOwnedByAdapter: this.networkOwnedByAdapter,
      messageListenerCount,
      lastError: this.lastError,
    };
  }

  /**
   * Fires on unexpected debugger detach and on view/session invalidation
   * (session-switch / destroy). Does not auto-reattach.
   */
  onUnexpectedDetach(
    handler: (info: { reason?: string; generation: number }) => void,
  ): () => void {
    this.unexpectedDetachHandlers.add(handler);
    return () => {
      this.unexpectedDetachHandlers.delete(handler);
    };
  }

  /**
   * Bind to a concrete WebContents generation.
   * Does not migrate active leases from a previous binding — call onViewWillReplace first.
   */
  bindWebContents(wc: CdpWebContentsLike): void {
    if (this.wc && this.leases.size > 0) {
      throw new Error(
        "CdpDebuggerSession: call onViewWillReplace before binding a new WebContents while leases are active.",
      );
    }
    this.teardownDetachListener();
    if (this.wc) sessionsByDebugger.delete(this.wc.debugger);
    this.wc = wc;
    this.generation += 1;
    this.adapterOwnsAttach = false;
    this.networkOwnedByAdapter = false;
    this.networkTenants.clear();
    this.lastError = undefined;
    sessionsByDebugger.set(wc.debugger, this);
    this.installDetachListener();
  }

  /**
   * Invalidate leases for the current view. Does not auto-bind a replacement.
   * Caller remains responsible for partial capture persistence.
   */
  onViewWillReplace(reason: "session-switch" | "destroy"): void {
    // Bump first so in-flight acquire/enable sees a generation mismatch.
    this.generation += 1;
    const fail: CdpLeaseFailReason =
      reason === "destroy" ? "destroyed" : "view-replaced";
    this.invalidateAll(fail, `view-${reason}`);
    this.teardownDetachListener();
    if (this.wc) sessionsByDebugger.delete(this.wc.debugger);
    this.wc = null;
    this.adapterOwnsAttach = false;
    this.networkOwnedByAdapter = false;
    this.networkTenants.clear();
  }

  acquire(consumer: CdpConsumerId): Promise<CdpLease> {
    return this.enqueue(async () => {
      const gen = this.generation;
      const wc = this.requireWc("acquire");
      if (wc.isDestroyed()) {
        this.lastError = "WebContents destroyed during acquire";
        throw new Error(this.lastError);
      }
      const dbg = wc.debugger;
      const token = randomUUID();
      let attachedByThisAcquire = false;

      try {
        if (!dbg.isAttached()) {
          dbg.attach(this.protocolVersion);
          attachedByThisAcquire = true;
          // First adapter-owned attach for this idle period.
          if (this.leases.size === 0) this.adapterOwnsAttach = true;
        } else if (this.leases.size === 0) {
          // External/legacy consumer already attached — never steal detach later.
          this.adapterOwnsAttach = false;
        }

        this.assertSameGeneration(gen, "acquire");
        if (wc.isDestroyed()) {
          throw new Error("WebContents destroyed during acquire");
        }

        const internal: InternalLease = {
          token,
          consumer,
          generation: gen,
          alive: true,
          released: false,
          messageWrappers: new Map(),
          networkHeld: false,
        };
        this.leases.set(token, internal);
        return this.toPublicLease(internal);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (attachedByThisAcquire && this.leases.size === 0 && this.adapterOwnsAttach) {
          try {
            if (dbg.isAttached()) {
              this.selfDetaching = true;
              try {
                dbg.detach();
              } finally {
                this.selfDetaching = false;
              }
            }
          } catch {
            this.selfDetaching = false;
            /* ignore rollback detach errors */
          }
          this.adapterOwnsAttach = false;
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  async enableDomain(
    lease: CdpLease,
    domain: CdpDomainName,
    params?: Record<string, unknown>,
  ): Promise<void> {
    return this.enqueue(async () => {
      const internal = this.requireAliveLease(lease, "enableDomain");
      if (domain !== "Network") throw new Error(`Unsupported CDP domain: ${domain}`);
      if (internal.networkHeld) return;

      const wc = this.requireWc("enableDomain");
      this.assertSameGeneration(internal.generation, "enableDomain");

      const alreadyTenant = this.networkTenants.size > 0;
      if (alreadyTenant) {
        this.networkTenants.add(internal.token);
        internal.networkHeld = true;
        return;
      }

      // First Network tenant — enable only if we will own the domain lease.
      try {
        await wc.debugger.sendCommand(
          "Network.enable",
          params ?? {
            maxTotalBufferSize: 100_000_000,
            maxResourceBufferSize: 50_000_000,
          },
        );
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        // Failed enable must not leave ownership counts.
        throw error instanceof Error ? error : new Error(String(error));
      }

      this.networkOwnedByAdapter = true;
      this.networkTenants.add(internal.token);
      internal.networkHeld = true;
    });
  }

  async disableDomain(lease: CdpLease, domain: CdpDomainName): Promise<void> {
    return this.enqueue(async () => {
      const internal = this.leases.get(lease.token);
      if (!internal || !internal.networkHeld) return;
      if (domain !== "Network") throw new Error(`Unsupported CDP domain: ${domain}`);

      internal.networkHeld = false;
      this.networkTenants.delete(internal.token);

      if (this.networkTenants.size > 0) return;
      if (!this.networkOwnedByAdapter) return;

      const wc = this.wc;
      if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
        try {
          await wc.debugger.sendCommand("Network.disable");
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
        }
      }
      this.networkOwnedByAdapter = false;
    });
  }

  async sendCommand(
    lease: CdpLease,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    const internal = this.requireAliveLease(lease, "sendCommand");
    const wc = this.requireWc("sendCommand");
    this.assertSameGeneration(internal.generation, "sendCommand");
    if (!wc.debugger.isAttached()) {
      throw new Error("CdpDebuggerSession: debugger is not attached");
    }
    return wc.debugger.sendCommand(method, params, sessionId);
  }

  onMessage(lease: CdpLease, handler: CdpDebuggerMessageHandler): () => void {
    const internal = this.requireAliveLease(lease, "onMessage");
    const wc = this.requireWc("onMessage");
    this.assertSameGeneration(internal.generation, "onMessage");

    const wrapper = (...args: unknown[]) => {
      if (!internal.alive || internal.released) return;
      if (internal.generation !== this.generation) return;
      const event = args[0];
      const method = String(args[1] ?? "");
      const params = (args[2] ?? {}) as Record<string, unknown>;
      const sessionId = String(args[3] ?? "");
      handler(event, method, params, sessionId);
    };

    internal.messageWrappers.set(handler, wrapper);
    wc.debugger.on("message", wrapper);

    return () => {
      const current = this.leases.get(internal.token);
      const wrapped = current?.messageWrappers.get(handler) ?? wrapper;
      current?.messageWrappers.delete(handler);
      try {
        this.wc?.debugger.removeListener("message", wrapped);
      } catch {
        /* ignore */
      }
    };
  }

  private toPublicLease(internal: InternalLease): CdpLease {
    const session = this;
    return {
      get token() {
        return internal.token;
      },
      get consumer() {
        return internal.consumer;
      },
      get generation() {
        return internal.generation;
      },
      get alive() {
        return internal.alive;
      },
      get failReason() {
        return internal.failReason;
      },
      release: () => session.releaseLease(internal.token),
    };
  }

  private releaseLease(token: string): Promise<void> {
    return this.enqueue(async () => {
      const internal = this.leases.get(token);
      if (!internal || internal.released) return; // duplicate release is safe
      internal.released = true;
      internal.alive = false;
      if (!internal.failReason) internal.failReason = "released";

      // Drop this lease's listeners only.
      for (const wrapper of internal.messageWrappers.values()) {
        try {
          this.wc?.debugger.removeListener("message", wrapper);
        } catch {
          /* ignore */
        }
      }
      internal.messageWrappers.clear();

      if (internal.networkHeld) {
        internal.networkHeld = false;
        this.networkTenants.delete(token);
        if (this.networkTenants.size === 0 && this.networkOwnedByAdapter) {
          const wc = this.wc;
          if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
            try {
              await wc.debugger.sendCommand("Network.disable");
            } catch (error) {
              this.lastError = error instanceof Error ? error.message : String(error);
            }
          }
          this.networkOwnedByAdapter = false;
        }
      }

      this.leases.delete(token);

      if (this.leases.size === 0) {
        await this.maybeDetachWhenIdle();
      }
    });
  }

  private async maybeDetachWhenIdle(): Promise<void> {
    if (!this.detachWhenIdle) return;
    if (!this.adapterOwnsAttach) return;
    if (this.leases.size > 0) return;
    if (this.invalidating) {
      // During invalidate we still detach if we own attach (below path).
    }
    const wc = this.wc;
    if (!wc || wc.isDestroyed()) {
      this.adapterOwnsAttach = false;
      return;
    }
    try {
      if (wc.debugger.isAttached()) {
        this.selfDetaching = true;
        try {
          wc.debugger.detach();
        } finally {
          this.selfDetaching = false;
        }
      }
    } catch (error) {
      this.selfDetaching = false;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.adapterOwnsAttach = false;
  }

  private invalidateAll(reason: CdpLeaseFailReason, detail: string): void {
    this.invalidating = true;
    try {
      const gen = this.generation;
      const dbg = this.wc?.debugger;
      for (const internal of this.leases.values()) {
        internal.alive = false;
        internal.released = true;
        internal.failReason = reason;
        for (const wrapper of internal.messageWrappers.values()) {
          try {
            dbg?.removeListener("message", wrapper);
          } catch {
            /* ignore */
          }
        }
        internal.messageWrappers.clear();
        internal.networkHeld = false;
      }
      this.leases.clear();
      this.networkTenants.clear();

      // Do not Network.disable / detach on unexpected detach — debugger already gone.
      // On view replace, avoid detaching a debugger we do not own; if we own it and WC still alive, detach.
      if (reason === "view-replaced" || reason === "destroyed") {
        if (this.networkOwnedByAdapter && dbg?.isAttached()) {
          void dbg.sendCommand("Network.disable").catch(() => undefined);
        }
        this.networkOwnedByAdapter = false;
        if (this.adapterOwnsAttach && this.detachWhenIdle && this.wc && !this.wc.isDestroyed()) {
          try {
            if (dbg?.isAttached()) {
              this.selfDetaching = true;
              try {
                dbg.detach();
              } finally {
                this.selfDetaching = false;
              }
            }
          } catch {
            this.selfDetaching = false;
          }
        }
        this.adapterOwnsAttach = false;
      } else if (reason === "unexpected-detach") {
        this.networkOwnedByAdapter = false;
        this.adapterOwnsAttach = false;
      }
      for (const handler of this.unexpectedDetachHandlers) {
        try {
          handler({ reason: detail, generation: gen });
        } catch {
          /* ignore subscriber errors */
        }
      }
      this.lastError = detail;
    } finally {
      this.invalidating = false;
    }
  }

  private installDetachListener(): void {
    const wc = this.wc;
    if (!wc) return;
    this.detachListener = (...args: unknown[]) => {
      if (this.selfDetaching) return;
      const reason =
        typeof args[0] === "string"
          ? args[0]
          : typeof (args[0] as { reason?: string })?.reason === "string"
            ? (args[0] as { reason: string }).reason
            : "detach";
      // Never auto-reattach.
      this.invalidateAll("unexpected-detach", reason);
    };
    wc.debugger.on("detach", this.detachListener);
  }

  private teardownDetachListener(): void {
    if (!this.detachListener) return;
    try {
      this.wc?.debugger.removeListener("detach", this.detachListener);
    } catch {
      /* ignore */
    }
    this.detachListener = null;
  }

  private requireWc(op: string): CdpWebContentsLike {
    if (!this.wc) {
      throw new Error(`CdpDebuggerSession: not bound (${op})`);
    }
    return this.wc;
  }

  private requireAliveLease(lease: CdpLease, op: string): InternalLease {
    const internal = this.leases.get(lease.token);
    if (!internal || !internal.alive || internal.released) {
      throw new Error(
        `CdpDebuggerSession: lease is not alive for ${op}` +
          (internal?.failReason ? ` (${internal.failReason})` : ""),
      );
    }
    return internal;
  }

  private assertSameGeneration(gen: number, op: string): void {
    if (gen !== this.generation || !this.wc) {
      throw new Error(`CdpDebuggerSession: WebContents replaced during ${op}`);
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    // Keep chain alive even when tasks fail.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
