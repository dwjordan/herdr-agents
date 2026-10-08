import streamDeck from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { HerdrEventStream } from "./herdr-events";

/** Stream Deck launches plugins without the login shell's PATH, so resolve herdr explicitly. */
const HERDR_CANDIDATES = [
    path.join(os.homedir(), ".local/bin/herdr"),
    "/opt/homebrew/bin/herdr",
    "/usr/local/bin/herdr",
];

/** While the event stream is down, fall back to plain polling. */
const FALLBACK_POLL_MS = 2000;
/** Safety net while streaming, e.g. for seen-state changes that emit no event. */
const STREAMING_POLL_MS = 15000;
const RESUBSCRIBE_MIN_MS = 1000;
const RESUBSCRIBE_MAX_MS = 30000;
const EXEC_TIMEOUT_MS = 5000;

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface HerdrAgent {
    agent: string;
    agent_status: AgentStatus;
    pane_id: string;
    tab_id?: string;
    cwd?: string;
    focused?: boolean;
    state_change_seq?: number;
    terminal_title_stripped?: string;
    workspace_id?: string;
}

/** workspace_id -> display label, e.g. "w1" -> "my-app". */
export type WorkspaceLabels = Map<string, string>;

export type Snapshot = { ok: true; agents: HerdrAgent[]; workspaces: WorkspaceLabels } | { ok: false; error: string };

type Listener = (snapshot: Snapshot) => void;

/**
 * One shared source of herdr state for every tile. A herdr event subscription
 * triggers an immediate re-read; polling covers the gaps when the stream is down.
 */
export class HerdrMonitor {
    private static instance: HerdrMonitor | null = null;

    static getInstance(): HerdrMonitor {
        return (this.instance ??= new HerdrMonitor());
    }

    private listeners = new Set<Listener>();
    private timer: NodeJS.Timeout | null = null;
    private inFlight = false;
    private pollAgain = false;
    private last: Snapshot | null = null;
    private herdrPath: string = HERDR_CANDIDATES[0];

    private readonly events = new HerdrEventStream(
        () => this.onStreamEvent(),
        (paneCount) => streamDeck.logger.info(`[herdr-agents] event stream subscribed (${paneCount} agent panes)`),
        (reason) => this.onStreamClosed(reason),
    );
    /** Agent panes the open stream watches; null when no stream is open. */
    private subscribedPanes: string | null = null;
    private resubscribeDelay = RESUBSCRIBE_MIN_MS;
    private resubscribeNotBefore = 0;

    get latest(): Snapshot | null {
        return this.last;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        if (this.last) listener(this.last);
        if (this.listeners.size === 1) this.poll();
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0) this.stop();
        };
    }

    /** Re-read now, e.g. after focusing an agent so its `done` clears promptly. */
    poll(): void {
        if (this.inFlight) {
            // An event arrived mid-read; the read may predate it, so read once more.
            this.pollAgain = true;
            return;
        }
        this.inFlight = true;
        this.pollAgain = false;
        Promise.all([this.run(["agent", "list"]), this.run(["workspace", "list"])])
            .then(([agentsOut, workspacesOut]) => {
                const agents: HerdrAgent[] = JSON.parse(agentsOut)?.result?.agents ?? [];
                const workspaces: WorkspaceLabels = new Map(
                    (JSON.parse(workspacesOut)?.result?.workspaces ?? []).map((w: any) => [w.workspace_id, w.label]),
                );
                this.emit({ ok: true, agents, workspaces });
                this.syncStream(agents);
            })
            .catch((err) => this.emit({ ok: false, error: String(err?.message ?? err) }))
            .finally(() => {
                this.inFlight = false;
                if (this.listeners.size === 0) return;
                if (this.pollAgain) this.poll();
                else this.schedule();
            });
    }

    private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.poll(), this.events.connected ? STREAMING_POLL_MS : FALLBACK_POLL_MS);
    }

    private stop(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.subscribedPanes = null;
        this.events.close();
    }

    /** (Re)open the stream when it is down or the set of agent panes has changed. */
    private syncStream(agents: HerdrAgent[]): void {
        if (this.listeners.size === 0) return;
        const panes = agents.map((a) => a.pane_id).sort();
        const key = panes.join(",");
        if (this.events.connected && key === this.subscribedPanes) return;
        if (!this.events.connected && Date.now() < this.resubscribeNotBefore) return;
        this.subscribedPanes = key;
        this.events.open(panes);
    }

    private onStreamEvent(): void {
        this.resubscribeDelay = RESUBSCRIBE_MIN_MS;
        this.poll();
    }

    private onStreamClosed(reason: string): void {
        this.subscribedPanes = null;
        if (this.listeners.size === 0) return;
        streamDeck.logger.info(`[herdr-agents] event stream closed (${reason}); polling until it reopens`);
        // Back off so a server that keeps rejecting the subscription isn't hammered.
        this.resubscribeNotBefore = Date.now() + this.resubscribeDelay;
        this.resubscribeDelay = Math.min(this.resubscribeDelay * 2, RESUBSCRIBE_MAX_MS);
        this.schedule();
    }

    /**
     * `agent focus` picks the pane inside its tab and marks it seen, but only moves
     * the server's focus. Attached clients keep their own view and follow just
     * `workspace`/`tab`/`pane focus`, so finish with `tab focus` to bring the window there.
     */
    async focus(agent: HerdrAgent): Promise<void> {
        await this.run(["agent", "focus", agent.pane_id]);
        if (agent.tab_id) await this.run(["tab", "focus", agent.tab_id]);
        this.poll();
    }

    private emit(snapshot: Snapshot): void {
        if (!snapshot.ok && this.last?.ok !== false) {
            streamDeck.logger.warn(`[herdr-agents] herdr unavailable: ${snapshot.error}`);
        }
        this.last = snapshot;
        for (const listener of this.listeners) listener(snapshot);
    }

    private run(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            execFile(this.herdrPath, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
                if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
                    const next = HERDR_CANDIDATES[HERDR_CANDIDATES.indexOf(this.herdrPath) + 1];
                    if (next) {
                        this.herdrPath = next;
                        this.run(args).then(resolve, reject);
                        return;
                    }
                    this.herdrPath = HERDR_CANDIDATES[0];
                    reject(new Error("herdr not found"));
                    return;
                }
                if (err) reject(err);
                else resolve(stdout);
            });
        });
    }
}
