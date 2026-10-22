# Todo Canvas

A GitHub Copilot app canvas extension (`todo-list`) for managing a reverse-chronological daily todo feed.

## Features

- **Manual Day Feed**: Add new days with `+ New Day` (with date headers and random emojis).
- **Rich Todo States**: Checkboxes with strikethrough, **In progress** (`●` blue dot), **Blocked** (`🚫`), and **Upcoming** (`»`).
- **Drag and Drop**: Reorder todos within a day or move them across days with a live drop indicator and floating ghost card.
- **GitHub PR Picker**: Search and attach multiple accessible PRs (`gh search prs`) with automatic draft detection.
- **Slack Status Report**: Expand and copy a formatted Slack status report (`*Blocked*`, `*Completed*`, `*In progress*`, `*Not addressed today*`, `*Upcoming*`) with rich HTML links.
- **Undo / Redo & Workdocs Backup**: Persistent undo/redo history (`Ctrl+Z` / `Ctrl+Shift+Z` or header buttons) and one-click Markdown backup to `ariroseonline/workdocs` (`todo-list.md`).

## Installation

Place in `~/.copilot/extensions/todo-list/` (or install via the `install_extension` tool pointing to `https://github.com/ariroseonline/todo-canvas`).
