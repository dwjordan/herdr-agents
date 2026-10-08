const COLORS = {
    background: "#1A1C20",
    text: "#F2F4F7",
    label: "#8D94A0",
    dim: "#4A505A",
    blocked: "#F2564F",
    blockedBg: "#3A1A1A",
    done: "#E5A12E",
    doneBg: "#33280F",
    working: "#5BA8F2",
};

const SANS = "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif";

export type TileLevel = "blocked" | "done" | "quiet" | "offline";

export interface TileData {
    level: TileLevel;
    /** Header, e.g. "AGENTS" or "CODEX". */
    label: string;
    /** Agents needing attention (blocked + done). */
    waiting: number;
    working: number;
    /** Workspace of the agent a press will jump to. */
    workspace?: string;
    /** Further waiting workspaces beyond the one shown. */
    moreWorkspaces?: number;
    /** Alternate frame for flashing a waiting tile. */
    flashOn: boolean;
}

export class TileRenderer {
    render(data: TileData, size = 144): string {
        const cx = size / 2;
        const waiting = data.level === "blocked" || data.level === "done";
        const accent = data.level === "blocked" ? COLORS.blocked : data.level === "done" ? COLORS.done : COLORS.dim;
        const tint = data.level === "blocked" ? COLORS.blockedBg : COLORS.doneBg;
        const fill = waiting && data.flashOn ? tint : COLORS.background;

        // Full-bleed and square: the key hardware rounds the corners itself, and any
        // radius drawn here won't match its mask.
        let body = `<rect width="${size}" height="${size}" fill="${fill}" />`;
        if (waiting) {
            const sw = data.flashOn ? 8 : 3;
            body += `<rect x="${sw / 2}" y="${sw / 2}" width="${size - sw}" height="${size - sw}" fill="none" stroke="${accent}" stroke-width="${sw}" />`;
        }

        body += this.text(data.label.toUpperCase(), cx, 28, 14, COLORS.label, 600, 1.5);

        if (data.level === "offline") {
            body += this.text("herdr", cx, 78, 26, COLORS.dim, 700);
            body += this.text("offline", cx, 112, 18, COLORS.label, 500);
            return this.svg(size, body);
        }

        if (waiting) {
            // The workspace is the headline: it says where to go, the count is secondary.
            body += this.text(String(data.waiting), cx, 76, 44, accent, 800);
            body += this.text(this.truncate(data.workspace ?? data.level, 12), cx, 108, 21, COLORS.text, 700);
            const status = data.moreWorkspaces ? `${data.level} · +${data.moreWorkspaces} more` : data.level;
            body += this.text(status, cx, 130, 14, accent, 600);
            return this.svg(size, body);
        }

        body += this.text("0", cx, 92, 58, COLORS.dim, 800);
        const caption = data.working > 0 ? `${data.working} working` : "all quiet";
        body += this.text(caption, cx, 124, 17, data.working > 0 ? COLORS.working : COLORS.label, 500);

        return this.svg(size, body);
    }

    private text(value: string, x: number, y: number, size: number, color: string, weight: number, spacing = 0): string {
        return `<text x="${x}" y="${y}" text-anchor="middle" font-family="${SANS}" font-size="${size}" font-weight="${weight}" letter-spacing="${spacing}" fill="${color}">${this.escape(value)}</text>`;
    }

    private truncate(value: string, max: number): string {
        return value.length > max ? `${value.slice(0, max - 1)}…` : value;
    }

    private escape(value: string): string {
        return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    private svg(size: number, body: string): string {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;
    }
}
