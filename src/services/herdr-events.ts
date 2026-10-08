import net from "node:net";
import os from "node:os";
import path from "node:path";

const SOCKET_PATH = process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), ".config/herdr/herdr.sock");

/** Events that can change which agents exist or how their workspace is labelled. */
const LIFECYCLE_EVENTS = [
    "pane.created",
    "pane.closed",
    "pane.exited",
    "pane.updated",
    "pane.agent_detected",
    "workspace.created",
    "workspace.renamed",
    "workspace.closed",
];

/**
 * A herdr `events.subscribe` connection, used purely as an invalidation signal:
 * herdr's docs recommend re-reading state on each event rather than applying
 * payloads, since events and snapshots share no sequence boundary.
 */
export class HerdrEventStream {
    private socket: net.Socket | null = null;
    private buffer = "";

    constructor(
        private readonly onEvent: () => void,
        /** Called when herdr acknowledges the subscription. */
        private readonly onSubscribed: (paneCount: number) => void,
        /** Called once when the stream ends for any reason (closed, rejected, `events_lost`). */
        private readonly onClosed: (reason: string) => void,
    ) {}

    get connected(): boolean {
        return this.socket !== null;
    }

    /** `pane.agent_status_changed` must name a pane, so the caller passes the current agent panes. */
    open(agentPaneIds: string[]): void {
        this.close();
        const subscriptions = [
            ...LIFECYCLE_EVENTS.map((type) => ({ type })),
            ...agentPaneIds.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
        ];
        const socket = net.createConnection(SOCKET_PATH);
        this.socket = socket;
        this.buffer = "";
        let closedReason = "connection closed";

        socket.setEncoding("utf8");
        socket.on("connect", () => {
            socket.write(`${JSON.stringify({ id: "sub", method: "events.subscribe", params: { subscriptions } })}\n`);
        });
        socket.on("data", (chunk: string) => {
            this.buffer += chunk;
            let newline: number;
            while ((newline = this.buffer.indexOf("\n")) >= 0) {
                const line = this.buffer.slice(0, newline).trim();
                this.buffer = this.buffer.slice(newline + 1);
                if (!line) continue;
                let message: any;
                try {
                    message = JSON.parse(line);
                } catch {
                    continue;
                }
                if (message.error) {
                    closedReason = message.error.code ?? message.error.message ?? "subscription error";
                    socket.destroy();
                    return;
                }
                if (message.id === "sub" && message.result) this.onSubscribed(agentPaneIds.length);
                // The acknowledgement and every pushed event alike mean "re-read now".
                this.onEvent();
            }
        });
        socket.on("error", (err) => (closedReason = err.message));
        socket.on("close", () => {
            if (this.socket !== socket) return;
            this.socket = null;
            this.onClosed(closedReason);
        });
    }

    close(): void {
        const socket = this.socket;
        this.socket = null;
        socket?.destroy();
    }
}
