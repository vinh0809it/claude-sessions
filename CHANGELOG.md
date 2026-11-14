# Changelog

## 0.7.0

A robustness release, after an audit of the whole code base.

### Fixed
- **Search shows a PROFILE column title** above the `[profile]` tags it adds to each row.
- **Delete confirmation named the wrong session**: after marking one session (the cursor moves on), the prompt showed the session under the cursor while `y` deleted the marked one.
- **Pasted text ran as commands**: a paste with a newline (e.g. into `/` search) could open, or with `d`/`y` in it delete, a session. Pastes now go into the text field as one line (bracketed paste; on terminals without it, a burst of keys with Enter inside counts as a paste).
- **Escape sequences split across reads** (common over ssh), **Alt+key**, and **old-style mouse reports** (GNU screen, PuTTY) no longer turn into stray keystrokes such as `d`, `y` or `q`. A late reply to the background-color query is dropped instead of read as keys.
- **Renaming a session that's running** could overwrite the line Claude was writing at that moment; it now appends.
- **Moving or restoring a session** could leave its subagent folder behind (and emptying the trash then deleted it) without saying so. Both now check the target first, roll back a half-done move, keep timestamps across disks, and report every failure.
- **Control characters in titles and messages** (colored logs pasted into a prompt, or a crafted file) were drawn as-is and could change the window title or clipboard; they're stripped now.
- **CJK and emoji** titles pushed the columns out of the frame and could be cut mid-character; widths are now measured in terminal columns.
- A session file with an odd `cwd`, a first line over 256 KB (a pasted image), a BOM, or a corrupt cache no longer crashes the scan or loses the session's details.
- The list could stay scrolled past its end after filtering or deleting; the selection now follows its session.
- `f`: the list kept the previous query's matches while typing; clicks went through the popup; phrases with quotes or spanning a line break weren't found.
- A click on the "terminal too small" screen crashed; keys there no longer act on the hidden list.
- The hover highlight came back after turning the mouse off; an edit in Settings carried over to another row.
- `-o feed` took "feed" for an id prefix; id prefixes now need 8+ characters.
- Running `claude-sessions .` listed sessions whose folder is unknown.
- Two windows open at once no longer overwrite each other's pins and settings; a settings file that doesn't parse is kept as `.bak`.
- A symlinked or differently-cased `CLAUDE_CONFIG_DIR` listed every session twice; a leading `~` in it is expanded.
- Killing the process (`SIGINT`, `SIGHUP`) or a crash left the terminal in the alternate screen; a crash now shows its error.

### Terminals
- Terminal.app and iTerm2 run a small script instead of typing a command into your login shell, so fish and nushell work; tmux gets its arguments directly.
- The terminal is detected from where you actually are: VS Code, Alacritty or JetBrains started from kitty or GNOME Terminal, and GNU screen or zellij inside kitty, no longer try (and hang on) the parent's tab command.
- A custom open command runs in the background instead of blocking until its window closes; on Windows it runs through `cmd /c`.
- Windows Terminal: config paths with `&`, `^` or `(` work; paths with `%` or `"` are refused with a message.
- WezTerm on macOS is found through `WEZTERM_EXECUTABLE`; the macOS automation prompt gets 30 s instead of 5.
- Redraws use synchronized output, so terminals that support it (kitty, WezTerm, iTerm2, Ghostty, foot, Windows Terminal, …) never show a half-drawn frame.
- 16-color terminals get inverse video for the selection; non-UTF-8 locales get an ASCII frame; `TERM=dumb` gets the plain list; Git Bash without a console gets a hint to use `winpty`.

### Internals
- The main screen's drawing and layout moved out of `app.js` into `list-view.js`, computed from state so drawing and mouse hit-testing always agree. Help, settings, trash and the pickers share one screen interface; key decoding is one stateful decoder (`input.js`).

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
