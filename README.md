# Herdr Agents for Stream Deck

A Stream Deck tile that lights up when a coding agent managed by [herdr](https://herdr.dev) is waiting on you, and shows which workspace.

- **Red, flashing** — an agent is blocked on a prompt or permission.
- **Amber, flashing** — an agent finished while you weren't looking.
- **Dark** — nothing waiting; shows how many agents are working.

Press to jump to the agent that has waited longest (blocked first). Press again to cycle through the rest.

## Setup

```bash
npm install
npm run build
npm run link
```

Then drag **Herdr Agents → Waiting Agents** onto a key.

## Configuration

Per tile, in the Property Inspector:

- **Provider** — All, Claude, Codex or Cursor.
- **Workspace** — only watch one herdr workspace (by label); blank watches all.
- **Count finished** — include finished-but-unseen agents, not just blocked ones.
- **Flash** — flash while anything is waiting.
- **Bring forward** — app to activate after focusing (default `Ghostty`; blank to skip).

## How it works

Subscribes to herdr's event stream (`events.subscribe` on `~/.config/herdr/herdr.sock`) and re-reads `herdr agent list` / `herdr workspace list` whenever an event arrives, so the tile updates as soon as herdr sees a change. Events are treated as invalidation signals rather than applied directly, as herdr's docs recommend. If the stream drops it falls back to polling every 2s and resubscribes with backoff; while connected, a 15s poll catches seen-state changes that emit no event.

Looks for `herdr` in `~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`, since Stream Deck doesn't pass your shell's `PATH`.

Focusing runs `herdr agent focus` then `herdr tab focus`. `agent focus` alone selects the pane and marks it seen, but only moves the server's focus — attached herdr clients follow `workspace`/`tab`/`pane focus` only.

## Development

```bash
npm run watch
```

Requires Stream Deck 6.5+, macOS 12+ and herdr 0.9+.
