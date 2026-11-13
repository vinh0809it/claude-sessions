# Changelog

## 0.5.0

### New
- **Mouse**: the wheel scrolls, a click selects a session or a tag, a double click opens it. Whatever is under the pointer is highlighted; in kitty the pointer becomes a hand. Hold `Shift` to select text, or turn the mouse off in Settings.
- **Settings** (`,`): where sessions open, mouse, tags layout, sort and preview on start, custom open command. Saved to `~/.config/claude-sessions/config.json`; environment variables still override them.
- **Tags panel**: title prefixes (`keycloak/…`) are shown as tags in a panel above the list that wraps onto more lines, with `▲`/`▼ n more` when some are scrolled away. `←` `→` choose a tag. The `side` layout puts them in a column on the left instead.
- **Search inside conversations**: after the title/path matches, sessions whose conversation contains the text (3+ characters) are added, marked `≈`. It runs in the background and is cancelled when you keep typing.
- **Trash**: `u` undoes the last delete; `t` lists deleted sessions to restore (`Enter`) or delete for good (`x`).
- **Live list**: new and updated sessions show up on their own while the list is open.
- The list is drawn in a frame with column titles (`SESSION`, `FOLDER`, `SIZE`, `UPDATED`).

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
