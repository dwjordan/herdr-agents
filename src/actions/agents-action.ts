import streamDeck, {
    action,
    DidReceiveSettingsEvent,
    KeyDownEvent,
    SingletonAction,
    WillAppearEvent,
    WillDisappearEvent,
} from "@elgato/streamdeck";
import { execFile } from "node:child_process";
import path from "node:path";
import { HerdrAgent, HerdrMonitor, Snapshot, WorkspaceLabels } from "../services/herdr-monitor";
import { TileLevel, TileRenderer } from "../ui/tile-renderer";

type Settings = {
    /** "all", or a herdr agent label such as "claude", "codex", "cursor". */
    provider?: string;
    /** Workspace label to watch (case-insensitive); blank watches every workspace. */
    workspace?: string;
    /** Count finished-but-unseen agents, not just blocked ones. */
    includeDone?: boolean;
    flash?: boolean;
    /** App to bring forward after focusing the pane; blank leaves focus alone. */
    activateApp?: string;
};

type Tile = {
    action: { setImage(image: string): Promise<void>; showAlert(): Promise<void> };
    settings: Settings;
    waiting: HerdrAgent[];
    lastFocused?: string;
};

const FLASH_MS = 700;
const DEFAULT_APP = "Ghostty";

const PROVIDER_LABELS: Record<string, string> = {
    all: "Agents",
    claude: "Claude",
    codex: "Codex",
    cursor: "Cursor",
};

@action({ UUID: "com.dwjordan.herdr-agents.waiting" })
export class AgentsAction extends SingletonAction<Settings> {
    private readonly monitor = HerdrMonitor.getInstance();
    private readonly renderer = new TileRenderer();
    private tiles = new Map<string, Tile>();
    private unsubscribe: (() => void) | null = null;
    private flashTimer: NodeJS.Timeout | null = null;
    private flashOn = false;

    override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
        this.tiles.set(ev.action.id, { action: ev.action as any, settings: ev.payload.settings ?? {}, waiting: [] });
        if (!this.unsubscribe) {
            this.unsubscribe = this.monitor.subscribe((snapshot) => this.drawAll(snapshot));
        } else if (this.monitor.latest) {
            await this.draw(ev.action.id, this.monitor.latest);
        }
    }

    override async onWillDisappear(ev: WillDisappearEvent<Settings>): Promise<void> {
        this.tiles.delete(ev.action.id);
        if (this.tiles.size === 0) {
            this.unsubscribe?.();
            this.unsubscribe = null;
            this.setFlashing(false);
        }
    }

    override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
        const tile = this.tiles.get(ev.action.id);
        if (!tile) return;
        tile.settings = ev.payload.settings ?? {};
        if (this.monitor.latest) await this.draw(ev.action.id, this.monitor.latest);
    }

    /**
     * Jump to the agent that has waited longest. Repeated presses cycle through
     * the rest, since a blocked agent stays blocked until it is answered.
     */
    override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
        const tile = this.tiles.get(ev.action.id);
        if (!tile) return;
        if (tile.waiting.length === 0) {
            this.monitor.poll();
            return;
        }

        const lastIndex = tile.waiting.findIndex((a) => a.pane_id === tile.lastFocused);
        const target = tile.waiting[(lastIndex + 1) % tile.waiting.length];
        tile.lastFocused = target.pane_id;

        try {
            await this.monitor.focus(target);
            const app = (tile.settings.activateApp ?? DEFAULT_APP).trim();
            if (app) execFile("/usr/bin/open", ["-a", app]);
        } catch (err) {
            streamDeck.logger.error(`[herdr-agents] focus ${target.pane_id} failed: ${err}`);
            await ev.action.showAlert();
        }
    }

    private async drawAll(snapshot: Snapshot): Promise<void> {
        await Promise.all([...this.tiles.keys()].map((id) => this.draw(id, snapshot)));
        const anyWaiting = [...this.tiles.values()].some((t) => t.settings.flash !== false && t.waiting.length > 0);
        this.setFlashing(anyWaiting);
    }

    private async draw(id: string, snapshot: Snapshot): Promise<void> {
        const tile = this.tiles.get(id);
        if (!tile) return;
        const provider = tile.settings.provider ?? "all";
        const label = PROVIDER_LABELS[provider] ?? provider;

        if (!snapshot.ok) {
            tile.waiting = [];
            await this.paint(tile, { level: "offline", label, waiting: 0, working: 0, flashOn: false });
            return;
        }

        const includeDone = tile.settings.includeDone !== false;
        const workspace = tile.settings.workspace?.trim().toLowerCase();
        const mine = snapshot.agents.filter(
            (a) =>
                (provider === "all" || a.agent === provider) &&
                (!workspace || workspaceName(a, snapshot.workspaces).toLowerCase() === workspace),
        );
        tile.waiting = mine
            .filter((a) => a.agent_status === "blocked" || (includeDone && a.agent_status === "done"))
            .sort((a, b) => rank(a) - rank(b) || (a.state_change_seq ?? 0) - (b.state_change_seq ?? 0));

        const level: TileLevel = tile.waiting.some((a) => a.agent_status === "blocked")
            ? "blocked"
            : tile.waiting.length > 0
              ? "done"
              : "quiet";

        const lastIndex = tile.waiting.findIndex((a) => a.pane_id === tile.lastFocused);
        const next = tile.waiting[(lastIndex + 1) % Math.max(tile.waiting.length, 1)];

        await this.paint(tile, {
            level,
            label,
            waiting: tile.waiting.length,
            working: mine.filter((a) => a.agent_status === "working").length,
            workspace: next ? workspaceName(next, snapshot.workspaces) : undefined,
            moreWorkspaces: Math.max(new Set(tile.waiting.map((a) => a.workspace_id)).size - 1, 0),
            flashOn: tile.settings.flash !== false && this.flashOn,
        });
    }

    private async paint(tile: Tile, data: Parameters<TileRenderer["render"]>[0]): Promise<void> {
        const svg = this.renderer.render(data);
        await tile.action.setImage(`data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`);
    }

    private setFlashing(on: boolean): void {
        if (on && !this.flashTimer) {
            this.flashTimer = setInterval(() => {
                this.flashOn = !this.flashOn;
                if (this.monitor.latest) void this.drawAll(this.monitor.latest);
            }, FLASH_MS);
        } else if (!on && this.flashTimer) {
            clearInterval(this.flashTimer);
            this.flashTimer = null;
            this.flashOn = false;
        }
    }
}

/** Blocked agents are waiting on a decision, so they jump the queue. */
function rank(agent: HerdrAgent): number {
    return agent.agent_status === "blocked" ? 0 : 1;
}

function workspaceName(agent: HerdrAgent, workspaces: WorkspaceLabels): string {
    const label = agent.workspace_id ? workspaces.get(agent.workspace_id) : undefined;
    return label ?? (agent.cwd ? path.basename(agent.cwd) : agent.agent);
}
