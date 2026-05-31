# claude-sessions

A zero-dependency terminal UI for browsing, resuming, moving, and deleting [Claude Code](https://claude.ai/code) sessions.

```
  claude-sessions                         path:/home/you/projects/acme
  [.claude-main]
    /home/you/projects/acme/api
  > booking-overlap-check                 2026-05-11 23:00
    ekyc-japan-fallback                   2026-05-11 22:52
  [.claude-company]
    /home/you/projects/acme/api
    payment-status-check                  2026-05-11 16:10
  ↑↓/jk=nav  /=search  Enter=open  n=new  m=move  d=del  q=quit  [42]
```

## Features

- **Auto-discovers** all `~/.claude*` config directories — works with multiple Claude Code profiles out of the box
- **Live search** across session titles and first messages; results show `[profile] project ›` inline
- **Open in new tab** — press Enter to resume a session in a new terminal tab (kitty, WezTerm, tmux, or custom)
- **New session** — press `n` to open a fresh Claude session in any profile and folder
- **Move sessions** — press `m` to move a session to a different profile, an existing folder, or a custom path
- **Delete sessions** with confirmation (removes both the `.jsonl` file and companion directory)
- **Filter by folder** — pass a path to scope the list to sessions in that directory tree
- Zero runtime dependencies — pure Node.js stdlib

## Install

```sh
# Global install (recommended)
npm install -g cli-claude-sessions

# Or run without installing
npx cli-claude-sessions

# Or manually
curl -fsSL https://raw.githubusercontent.com/vinh0809it/claude-sessions/main/index.js \
  -o ~/.local/bin/claude-sessions && chmod +x ~/.local/bin/claude-sessions
```

Requires Node.js 18+.

## Usage

```sh
claude-sessions                    # Browse all sessions (TUI)
claude-sessions ~/projects/acme    # Filter to a specific folder
claude-sessions --named-only       # Only show /rename'd sessions
claude-sessions --list             # Plain list (pipe-friendly)
claude-sessions --json             # JSON output
claude-sessions -d ~/.claude-work  # Scan a specific config dir
```

### TUI keys

| Key | Action |
|-----|--------|
| `↑` `↓` / `j` `k` | Navigate |
| `PgUp` `PgDn` | Page up / down |
| `g` / `G` | Jump to top / bottom |
| `/` | Search by title or message content |
| `Esc` | Clear search |
| `Enter` | Open session in a new terminal tab |
| `n` | New session (choose profile + folder) |
| `m` | Move session to another profile / folder |
| `d` | Delete session (asks confirmation) |
| `q` / `Ctrl-C` | Quit |

## Multiple profiles

Claude Code supports custom config directories via `CLAUDE_CONFIG_DIR`. `claude-sessions` auto-discovers **all** `~/.claude*` directories, so multiple profiles just work:

```sh
# ~/.bashrc or ~/.zshrc
alias claude-main='CLAUDE_CONFIG_DIR=~/.claude-main claude'
alias claude-work='CLAUDE_CONFIG_DIR=~/.claude-work claude'
```

Sessions are grouped by profile in the UI. Press `m` to move a session to a different profile or folder (including a custom typed path). Press `n` to open a new session in any profile and folder.

## Open in new tab

Press `Enter` on any session to resume it in a new terminal tab. The terminal is auto-detected:

| Terminal | Support | Notes |
|----------|---------|-------|
| **Kitty** | ✅ | Requires `allow_remote_control yes` in `kitty.conf` |
| **WezTerm** | ✅ | Uses `wezterm cli spawn` |
| **tmux** | ✅ | Opens a new window in the current session |
| Others | ⚙️ | Use `CLAUDE_SESSIONS_OPEN_CMD` |

### Custom open command

Set `CLAUDE_SESSIONS_OPEN_CMD` with placeholders `%cmd%`, `%title%`, and `%project%`:

```sh
# Ghostty (or any terminal with a new-tab flag)
export CLAUDE_SESSIONS_OPEN_CMD="ghostty --command=bash -i -c %cmd%"

# iTerm2 via osascript
export CLAUDE_SESSIONS_OPEN_CMD="osascript -e 'tell app \"iTerm\" to create window with default profile command \"bash -i -c %cmd%\"'"

# Force a specific supported terminal
export CLAUDE_SESSIONS_TERMINAL=wezterm
```

## How sessions are stored

Claude Code stores sessions in `~/.claude*/projects/<encoded-path>/<uuid>.jsonl`. Each line is a JSON record. `claude-sessions` reads:

- `type: "custom-title"` → the name set by `/rename`
- First `type: "user"` message → shown as a fallback title
- `cwd` field → the actual project path (used for filtering)

## Contributing

Issues and PRs welcome. The entire tool is a single `index.js` with no build step.

```sh
git clone https://github.com/vinh0809it/claude-sessions
cd claude-sessions
node index.js          # run directly
npm link               # install globally from source
npm test               # run the test suite (Node built-in test runner, no extra deps)
```

## License

[MIT](LICENSE)
