import streamDeck from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** Stream Deck launches plugins without the login shell's PATH, so resolve herdr explicitly. */
const HERDR_CANDIDATES = [
    path.join(os.homedir(), ".local/bin/herdr"),
    "/opt/homebrew/bin/herdr",
    "/usr/local/bin/herdr",
];

const POLL_MS = 2000;
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
 * One shared poller for every tile: `herdr agent list` is cheap (a socket round
 * trip), and polling survives herdr server restarts without reconnect logic.
 */
export class HerdrMonitor {
    private static instance: HerdrMonitor | null = null;

    static getInstance(): HerdrMonitor {
        return (this.instance ??= new HerdrMonitor());
    }

    private listeners = new Set<Listener>();
    private timer: NodeJS.Timeout | null = null;
    private inFlight = false;
    private last: Snapshot | null = null;
    private herdrPath: string = HERDR_CANDIDATES[0];

    get latest(): Snapshot | null {
        return this.last;
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        if (this.last) listener(this.last);
        if (!this.timer) {
            this.poll();
            this.timer = setInterval(() => this.poll(), POLL_MS);
        }
        return () => {
            this.listeners.delete(listener);
            if (this.listeners.size === 0 && this.timer) {
                clearInterval(this.timer);
                this.timer = null;
            }
        };
    }

    /** Re-poll right away, e.g. after focusing an agent so its `done` clears promptly. */
    poll(): void {
        if (this.inFlight) return;
        this.inFlight = true;
        Promise.all([this.run(["agent", "list"]), this.run(["workspace", "list"])])
            .then(([agentsOut, workspacesOut]) => {
                const agents: HerdrAgent[] = JSON.parse(agentsOut)?.result?.agents ?? [];
                const workspaces: WorkspaceLabels = new Map(
                    (JSON.parse(workspacesOut)?.result?.workspaces ?? []).map((w: any) => [w.workspace_id, w.label]),
                );
                this.emit({ ok: true, agents, workspaces });
            })
            .catch((err) => this.emit({ ok: false, error: String(err?.message ?? err) }))
            .finally(() => (this.inFlight = false));
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
