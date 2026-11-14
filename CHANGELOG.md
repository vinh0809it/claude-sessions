# Changelog

## 0.6.0

### New
- **Fork** (`F`): resume a session into a new session id (`--fork-session`), leaving the original as it is.
- **Pins** (`*`): pinned sessions show a `★` and stay at the top of their profile. Saved to `~/.config/claude-sessions/pins.json`.
- **Token usage** in the preview: input (and how much came from cache), output, replies and models. Each reply is counted once (Claude Code writes one line per content block), subagent transcripts are included, and turns before a `/compact` still count. A session continued in a new file only covers that file.
- **Open from the command line**: `claude-sessions -o <query>` resumes the session whose title or id matches, without the TUI; with several matches it lists them.

### Changed
- `f` searches only what you and Claude wrote, not tool output, so file contents and logs no longer produce noise. Closing its popup shows the preview with the matching messages, the text highlighted.

### Fixed
- While searching, the `[profile]` tags are padded to one width so the columns stay aligned.

## 0.5.0

### New
- **Mouse**: the wheel scrolls, a click selects a session or a tag, a double click opens it. Whatever is under the pointer is highlighted; in kitty the pointer becomes a hand. Hold `Shift` to select text, or turn the mouse off in Settings.
- **Settings** (`,`): where sessions open, mouse, tags layout, sort and preview on start, custom open command. Saved to `~/.config/claude-sessions/config.json`; environment variables still override them.
- **Tags panel**: title prefixes (`keycloak/…`) are shown as tags in a panel above the list that wraps onto more lines, with `▲`/`▼ n more` when some are scrolled away. `←` `→` choose a tag. The `side` layout puts them in a column on the left instead.
- **Find inside conversations** (`f`): a popup where you type the text; the list behind shows the sessions whose conversation contains it. It searches in the background, shows progress and the number found, and restarts as you type. `/` still searches titles, first messages and folders only.
- **Trash**: `u` undoes the last delete; `t` lists deleted sessions to restore (`Enter`), permanently delete one (`x`) or delete them all (`X`).
- **Live list**: new and updated sessions show up on their own while the list is open.
- The list is drawn in a frame with column titles (`SESSION`, `FOLDER`, `SIZE`, `UPDATED`).
- Footer: actions on the left; trash, settings and help on the right.

### Changed
- `←` `→` now choose a tag (in 0.4.x they did the same through a single tag row).
- A terminal that's too small (under 40×8) shows a note instead of a broken layout; on short screens the Tags panel and preview shrink first.

### Fixed
- Short terminals with the preview on no longer draw the panels over each other.

## 0.4.3
- Tags from title prefixes; finding `claude` outside PATH (alias installs, `~/.claude/local`, Windows); new tabs in Ptyxis and GNOME Terminal; opening in place when a tab can't be opened; selection color from the terminal background; inline errors for typed paths.

## 0.4.2
- Don't force `CLAUDE_CONFIG_DIR` for the default profile (it made a logged-in install ask to log in).

## 0.4.1
- Move picker folders and resuming moved sessions.

## 0.4.0
- Split into modules under `lib/`.
