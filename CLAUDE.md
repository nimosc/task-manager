# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

Open `index.html` directly in a browser (`file://` protocol works). No build step, no server required.

## Architecture

Single-page app: three files, no framework, no dependencies.

- [index.html](index.html) — static shell. Only dynamic regions: `#sidebar-nav`, `#main-content`, `#task-panel`, `#modal-overlay`, `#toast-container`, `#active-timer-indicator`.
- [style.css](style.css) — all styles. CSS variables in `:root`. RTL layout via `dir="rtl"` on `<html>` — sidebar is on the RIGHT, task panel slides in from the LEFT.
- [app.js](app.js) — all logic. One global `state` object, persisted to `localStorage` under key `taskmanager_v2`.

## Data Model (in `state.clients`)

```
Client → projects[] → tasks[] → subtasks[]
```

Each task has: `id, title, description, priority (high/medium/low), tags[], dueDate, status (open/in-progress/done), timeTotal (seconds), estimatedMinutes (minutes), subtasks[]`

## Key Patterns in app.js

**Rendering** — All UI is built by setting `innerHTML` with template-literal strings. No virtual DOM. Re-render is triggered by calling `render()` (alias for `renderAll()`) → `renderSidebar()` + `renderMain()` + `renderPanel()`.

**Event handling** — All clicks/changes use `document.addEventListener` delegation. Interactive elements carry `data-action` attributes; no inline `onclick` handlers appear in HTML templates.

**Timer** — One active timer at a time (`state.activeTimer`). Live updates use `data-tick` + `data-base` attributes on elements; a 1-second `setInterval` patches only those DOM nodes without a full re-render.

**Mutations** — Every CRUD function calls `saveState()` after modifying `state`, then the caller is responsible for triggering a re-render.

**Modal system** — `showModal(html, onSubmit)` renders a form into `#modal-box`. Submit handler reads form values and calls the appropriate CRUD function.

**Clockify integration** — Bidirectional sync: `startTimer()` immediately opens a Clockify entry (stored as `state.activeTimer.clockifyEntryId`); `stopTimer()` closes it. If no entry was opened (or elapsed < 60s), stop falls back to posting a completed entry. Workspace ID: `6386f7b7f4b38507be1e5f5a`. User ID: `6386f7b7f4b38507be1e5f59`. Both are hardcoded constants in app.js.

**Move task** — `moveTask(tid, fromCid, fromPid, toCid, toPid)` relocates a task between projects and updates the active timer context if that task is running.

## Conventions

- All user-visible strings are in Hebrew.
- Always use the `esc()` utility when interpolating user data into HTML strings to prevent XSS.
- IDs are generated with `uuid()` (wraps `crypto.randomUUID`).
- Default filter on load: `status = 'open'`.
- `currentView` is one of `'today' | 'client' | 'project'`.
