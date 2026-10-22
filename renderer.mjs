import { createServer } from "node:http";
import {
    loadList,
    saveList,
    undoList,
    redoList,
    saveSettings,
    normalizeItem,
    resolvePrMetadata,
    searchAccessiblePrs,
    refreshDayPrStatuses,
    createDayEntry,
    formatSlackStatusReport,
    backupListToWorkdocs,
} from "./store.mjs";

const servers = new Map(); // instanceId -> { server, url, listId, clients: Set<ServerResponse> }
const instanceLists = new Map(); // instanceId -> listId

export function getListIdForInstance(instanceId) {
    return instanceLists.get(instanceId) || "default";
}

export function setListIdForInstance(instanceId, listId) {
    const resolved = listId || "default";
    instanceLists.set(instanceId, resolved);
    const entry = servers.get(instanceId);
    if (entry) {
        entry.listId = resolved;
    }
    return resolved;
}

export async function broadcastListUpdate(listId) {
    const state = await loadList(listId);
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const entry of servers.values()) {
        if (entry.listId === state.listId) {
            for (const client of entry.clients) {
                client.write(payload);
            }
        }
    }
    return state;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > 1_000_000) {
                reject(new Error("Payload too large"));
            }
        });
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}

function renderHtml() {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Todoodle</title>
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 20px 24px 40px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
    }
    .top-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 18px;
      min-height: 30px;
    }
    .title-wrap {
      display: inline-flex;
      flex-direction: column;
      align-items: flex-start;
      transform: rotate(-1.5deg);
      transform-origin: left center;
      user-select: none;
    }
    h1 {
      margin: 0;
      font-family: "MarkerFelt-Thin", "Marker Felt", "Chalkboard SE", "Bradley Hand", "Comic Sans MS", cursive;
      font-size: 26px;
      font-weight: 400;
      font-synthesis: none;
      line-height: 28px;
      display: inline-flex;
      align-items: baseline;
    }
    .title-char {
      display: inline-block;
      transform-origin: center 70%;
      margin-right: -0.3px;
    }
    .title-scribble {
      margin-top: -31px;
      margin-left: 2px;
      width: 208px;
      height: 40px;
      overflow: visible;
      color: var(--true-color-blue, #0969da);
      pointer-events: none;
    }
    .top-bar-right {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .settings-panel {
      margin-bottom: 18px;
      padding: 10px 12px 12px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 8px;
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 3%, var(--background-color-default, #ffffff));
    }
    .settings-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 2px;
    }
    .settings-label {
      display: block;
      font-size: 12px;
      font-weight: var(--font-weight-semibold, 600);
      color: var(--text-color-default, #1f2328);
      margin: 0;
    }
    .settings-help {
      font-size: 11.5px;
      line-height: 16px;
      color: var(--text-color-muted, #656d76);
      margin: 0 0 8px 0;
    }
    .settings-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .settings-input {
      flex: 1;
      padding: 5px 9px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 6px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: 12px;
      outline: none;
    }
    .settings-input:focus {
      border-color: var(--color-focus-outline, #0969da);
    }
    .history-btn.active {
      border-color: var(--true-color-blue, #0969da);
      color: var(--true-color-blue, #0969da);
    }
    .history-btn {
      width: 28px;
      height: 28px;
      padding: 0;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 6px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .history-btn:hover:not(:disabled) {
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 5%, transparent);
    }
    .history-btn:disabled {
      opacity: 0.35;
      cursor: default;
    }
    .history-btn.backup-success {
      border-color: #1a7f37;
      color: #1a7f37;
    }
    .history-btn.backup-error {
      border-color: var(--true-color-red, #cf222e);
      color: var(--true-color-red, #cf222e);
    }
    .confirm-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .confirm-danger-btn {
      padding: 2px 7px;
      border-radius: 4px;
      border: 1px solid var(--true-color-red, #cf222e);
      background: var(--true-color-red, #cf222e);
      color: var(--color-white, #ffffff);
      font-family: inherit;
      font-size: 11.5px;
      font-weight: var(--font-weight-semibold, 600);
      line-height: 16px;
      cursor: pointer;
    }
    .confirm-cancel-btn {
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px solid var(--border-color-default, #d0d7de);
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-muted, #656d76);
      font-family: inherit;
      font-size: 11.5px;
      line-height: 16px;
      cursor: pointer;
    }
    .new-day-btn {
      padding: 5px 11px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 6px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: inherit;
      font-size: 12.5px;
      font-weight: var(--font-weight-semibold, 600);
      line-height: 18px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .new-day-btn:hover {
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 5%, transparent);
    }
    .subtle-btn {
      padding: 4px 9px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 6px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-muted, #656d76);
      font-family: inherit;
      font-size: 12px;
      line-height: 16px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .subtle-btn:hover {
      color: var(--text-color-default, #1f2328);
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 5%, transparent);
    }
    .subtle-btn.active {
      border-color: var(--true-color-blue, #0969da);
      color: var(--true-color-blue, #0969da);
      background: color-mix(in srgb, var(--true-color-blue, #0969da) 8%, transparent);
    }
    .day-block {
      margin-bottom: 28px;
    }
    .day-divider {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
      min-height: 24px;
    }
    .day-header-label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: var(--font-weight-semibold, 600);
      color: var(--text-color-default, #1f2328);
      white-space: nowrap;
    }
    .day-emoji {
      font-size: 15px;
      line-height: 1;
    }
    .day-divider-line {
      flex: 1;
      height: 1px;
      background: var(--border-color-default, #d0d7de);
    }
    .day-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      flex-shrink: 0;
    }
    .day-report-footer {
      margin-top: 10px;
    }
    .day-report-full-btn {
      width: 100%;
      padding: 7px 12px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 6px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: inherit;
      font-size: 12.5px;
      font-weight: var(--font-weight-semibold, 600);
      line-height: 18px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      transition: background-color 0.12s ease, border-color 0.12s ease;
    }
    .day-report-full-btn:hover {
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 4%, transparent);
    }
    .day-report-full-btn.active {
      border-color: var(--true-color-blue, #0969da);
      background: color-mix(in srgb, var(--true-color-blue, #0969da) 6%, transparent);
    }
    .add-form {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
    }
    .add-input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 6px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: inherit;
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
      outline: none;
    }
    .add-input:focus {
      border-color: var(--color-focus-outline, #0969da);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-focus-outline, #0969da) 25%, transparent);
    }
    .add-btn {
      padding: 6px 12px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 6px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: inherit;
      font-size: var(--text-body-medium, 14px);
      font-weight: var(--font-weight-semibold, 600);
      cursor: pointer;
    }
    .add-btn:hover {
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 5%, transparent);
    }
    ul.todo-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    li.todo-item {
      display: flex;
      flex-direction: column;
      padding: 8px 4px;
      border-bottom: 1px solid color-mix(in srgb, var(--border-color-default, #d0d7de) 65%, transparent);
    }
    .todo-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }
    .drag-handle {
      width: 14px;
      height: 20px;
      margin-left: -4px;
      color: var(--text-color-muted, #656d76);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      opacity: 0;
      transition: opacity 0.12s ease, color 0.12s ease;
      flex-shrink: 0;
      user-select: none;
      touch-action: none;
    }
    li.todo-item:hover .drag-handle {
      opacity: 0.7;
    }
    .drag-handle:hover {
      opacity: 1 !important;
      color: var(--text-color-default, #1f2328);
    }
    body.is-dragging,
    body.is-dragging * {
      cursor: grabbing !important;
      user-select: none !important;
    }
    li.todo-item.dragging {
      opacity: 0.3;
    }
    .drag-ghost {
      position: fixed;
      pointer-events: none;
      z-index: 10000;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--border-color-default, #d0d7de) 60%, transparent);
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.22);
      opacity: 0.85;
    }
    .drag-ghost .item-actions {
      display: none !important;
    }
    .drag-ghost .drag-handle {
      opacity: 1 !important;
    }
    .drag-ghost.completed .todo-text {
      text-decoration: line-through;
      color: var(--text-color-muted, #656d76);
    }
    .drop-indicator {
      position: fixed;
      height: 2px;
      background: var(--true-color-blue, #0969da);
      pointer-events: none;
      z-index: 9999;
      border-radius: 2px;
    }
    .drop-indicator::before {
      content: "";
      position: absolute;
      left: -4px;
      top: -3px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--true-color-blue, #0969da);
    }
    .day-block.drop-target-empty .empty-state {
      border: 1px dashed var(--true-color-blue, #0969da);
      border-radius: 6px;
      background: color-mix(in srgb, var(--true-color-blue, #0969da) 6%, transparent);
      color: var(--true-color-blue, #0969da);
    }
    .doodle-checkbox {
      width: 18px;
      height: 18px;
      margin: 1px 0 0 0;
      padding: 0;
      background: transparent;
      border: none;
      cursor: pointer;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: var(--text-color-muted, #656d76);
      transition: transform 0.15s ease, color 0.15s ease;
    }
    .doodle-checkbox:hover {
      color: var(--text-color-default, #1f2328);
      transform: scale(1.06) rotate(-2deg);
    }
    .doodle-checkbox svg {
      width: 18px;
      height: 18px;
      overflow: visible;
    }
    .doodle-box-path {
      stroke: currentColor;
      stroke-width: 1.65;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: transparent;
      transition: stroke 0.18s ease, fill 0.18s ease;
    }
    .doodle-checkbox.checked {
      color: var(--true-color-blue, #0969da);
    }
    .doodle-checkbox.checked .doodle-box-path {
      fill: color-mix(in srgb, var(--true-color-blue, #0969da) 10%, transparent);
    }
    .doodle-check-path {
      stroke: var(--true-color-blue, #0969da);
      stroke-width: 2.25;
      stroke-linecap: round;
      stroke-linejoin: round;
      fill: none;
      stroke-dasharray: 24;
      stroke-dashoffset: 24;
    }
    .doodle-checkbox.checked .doodle-check-path {
      stroke-dashoffset: 0;
    }
    @keyframes doodleCheckPop {
      0% { transform: scale(0.86) rotate(-4deg); }
      55% { transform: scale(1.12) rotate(2deg); }
      100% { transform: scale(1) rotate(0deg); }
    }
    @keyframes doodleCheckDraw {
      0% { stroke-dashoffset: 24; }
      100% { stroke-dashoffset: 0; }
    }
    .doodle-checkbox.just-checked {
      animation: doodleCheckPop 0.26s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .doodle-checkbox.just-checked .doodle-check-path {
      animation: doodleCheckDraw 0.22s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .todo-blocked-emoji {
      width: 16px;
      height: 16px;
      margin: 2px 0 0 0;
      font-size: 14px;
      line-height: 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
    }
    .todo-main {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .todo-text-line {
      display: flex;
      align-items: baseline;
      gap: 7px;
      min-width: 0;
    }
    .in-progress-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--true-color-blue, #0969da);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--true-color-blue, #0969da) 20%, transparent);
      flex-shrink: 0;
      display: inline-block;
      transform: translateY(-1px);
    }
    .todo-text {
      flex: 1;
      cursor: text;
      word-break: break-word;
      padding: 1px 4px;
      margin-left: -4px;
      border-radius: 4px;
      transition: color 0.12s ease, background-color 0.12s ease;
    }
    .todo-text:hover {
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 5%, transparent);
    }
    li.todo-item.completed .todo-text {
      text-decoration: line-through;
      color: var(--text-color-muted, #656d76);
    }
    .todo-upcoming-lead {
      width: 16px;
      height: 16px;
      margin: 2px 0 0 0;
      color: var(--true-color-blue, #0969da);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      user-select: none;
      flex-shrink: 0;
    }
    .todo-pr-subline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      line-height: 16px;
      color: var(--text-color-muted, #656d76);
    }
    .todo-pr-link-wrap {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 5px;
      margin-left: -5px;
      border-radius: 4px;
    }
    .todo-pr-link-wrap:hover {
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 5%, transparent);
    }
    .pr-chip-remove {
      background: transparent;
      border: none;
      color: var(--text-color-muted, #656d76);
      font-size: 12px;
      line-height: 1;
      padding: 0 2px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s ease;
    }
    .todo-pr-link-wrap:hover .pr-chip-remove,
    .pr-chip-remove:focus-visible {
      opacity: 1;
    }
    .pr-chip-remove:hover {
      color: var(--true-color-red, #cf222e);
    }
    .todo-pr-link {
      color: var(--text-color-muted, #656d76);
      text-decoration: none;
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: 11.5px;
    }
    .todo-pr-link:hover {
      color: var(--true-color-blue, #0969da);
      text-decoration: underline;
    }
    .pr-draft-pill {
      font-family: var(--font-sans, sans-serif);
      font-size: 11px;
      padding: 0 5px;
      border-radius: 999px;
      border: 1px solid var(--border-color-default, #d0d7de);
      color: var(--text-color-muted, #656d76);
      line-height: 15px;
    }
    .edit-input {
      flex: 1;
      padding: 2px 6px;
      border: 1px solid var(--color-focus-outline, #0969da);
      border-radius: 4px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: inherit;
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
      outline: none;
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-focus-outline, #0969da) 25%, transparent);
    }
    .item-actions {
      display: flex;
      align-items: center;
      gap: 2px;
      opacity: 0;
      transition: opacity 0.12s ease;
      flex-shrink: 0;
    }
    li.todo-item:hover .item-actions,
    li.todo-item:focus-within .item-actions,
    .item-actions.force-visible {
      opacity: 1;
    }
    .icon-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-color-muted, #656d76);
      font-size: 14px;
      line-height: 1;
      width: 24px;
      height: 24px;
      padding: 0;
      border-radius: 5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .icon-btn:hover {
      color: var(--text-color-default, #1f2328);
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 8%, transparent);
    }
    .icon-btn.active {
      color: var(--true-color-blue, #0969da);
      background: color-mix(in srgb, var(--true-color-blue, #0969da) 12%, transparent);
    }
    .icon-btn.active-danger {
      color: var(--true-color-red, #cf222e);
      background: color-mix(in srgb, var(--true-color-red, #cf222e) 12%, transparent);
    }
    .pr-editor {
      margin-top: 8px;
      margin-left: 22px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 8px;
      background: var(--background-color-default, #ffffff);
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
      overflow: hidden;
    }
    .pr-picker-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 9px;
      border-bottom: 1px solid var(--border-color-default, #d0d7de);
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 2%, var(--background-color-default, #ffffff));
    }
    .pr-picker-search {
      flex: 1;
      min-width: 0;
      padding: 4px 8px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 5px;
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: inherit;
      font-size: 12.5px;
      outline: none;
    }
    .pr-picker-search:focus {
      border-color: var(--color-focus-outline, #0969da);
    }
    .pr-picker-list {
      max-height: 220px;
      overflow-y: auto;
      margin: 0;
      padding: 4px 0;
      list-style: none;
    }
    .pr-picker-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12.5px;
      line-height: 17px;
    }
    .pr-picker-item:hover,
    .pr-picker-item.active {
      background: color-mix(in srgb, var(--true-color-blue, #0969da) 8%, transparent);
    }
    .pr-picker-icon {
      margin-top: 2px;
      flex-shrink: 0;
      color: #1a7f37;
    }
    .pr-picker-icon.draft {
      color: var(--text-color-muted, #656d76);
    }
    .pr-picker-icon.merged {
      color: #8250df;
    }
    .pr-picker-body {
      flex: 1;
      min-width: 0;
    }
    .pr-picker-title {
      color: var(--text-color-default, #1f2328);
      font-weight: 500;
      word-break: break-word;
    }
    .pr-picker-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text-color-muted, #656d76);
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
    }
    .pr-picker-check {
      color: var(--true-color-blue, #0969da);
      font-weight: 600;
      font-size: 13px;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .pr-picker-status {
      padding: 10px 12px;
      font-size: 12px;
      color: var(--text-color-muted, #656d76);
    }
    .small-btn {
      padding: 4px 9px;
      border-radius: 5px;
      border: 1px solid var(--border-color-default, #d0d7de);
      background: var(--background-color-default, #ffffff);
      color: var(--text-color-default, #1f2328);
      font-family: inherit;
      font-size: 12px;
      font-weight: var(--font-weight-semibold, 600);
      cursor: pointer;
    }
    .small-btn.primary {
      border-color: var(--true-color-blue, #0969da);
      background: var(--true-color-blue, #0969da);
      color: var(--color-white, #ffffff);
    }
    .small-btn.danger {
      color: var(--true-color-red, #cf222e);
    }
    .status-report-box {
      margin-top: 8px;
      padding: 12px 14px;
      border: 1px solid var(--border-color-default, #d0d7de);
      border-radius: 8px;
      background: color-mix(in srgb, var(--text-color-default, #1f2328) 3%, var(--background-color-default, #ffffff));
    }
    .status-report-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }
    .status-report-title {
      font-size: 12px;
      font-weight: var(--font-weight-semibold, 600);
      color: var(--text-color-muted, #656d76);
    }
    .status-report-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .status-report-pre {
      margin: 0;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid var(--border-color-default, #d0d7de);
      background: var(--background-color-default, #ffffff);
      font-family: var(--font-mono, "SFMono-Regular", Consolas, monospace);
      font-size: 12px;
      line-height: 18px;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-color-default, #1f2328);
    }
    .empty-state {
      color: var(--text-color-muted, #656d76);
      font-size: 13px;
      padding: 6px 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="top-bar">
      <div class="title-wrap">
        <h1 id="list-title">Todoodle</h1>
        <svg class="title-scribble" viewBox="0 0 216 42" fill="none" aria-hidden="true">
          <path d="M 2 37 C 24 33, 44 40, 66 35 C 76 33, 82 36, 88 34 C 100 31, 106 21, 98 21 C 91 21, 93 34, 112 29 C 128 25, 138 9, 126 8 C 114 7, 116 28, 144 22 C 166 17, 182 -4, 165 -5 C 148 -6, 150 22, 188 14 C 198 12, 206 7, 212 3" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div class="top-bar-right">
        <button type="button" id="undo-btn" class="history-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 14 4 9l5-5"/>
            <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>
          </svg>
        </button>
        <button type="button" id="redo-btn" class="history-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="m15 14 5-5-5-5"/>
            <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13"/>
          </svg>
        </button>
        <button type="button" id="backup-btn" class="history-btn" title="Configure a backup repository in Settings first" aria-label="Backup todo feed" disabled>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
            <path d="M12 12v9"/>
            <path d="m16 16-4-4-4 4"/>
          </svg>
        </button>
        <button type="button" id="settings-btn" class="history-btn" title="Backup settings" aria-label="Settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <button type="button" id="new-day-btn" class="new-day-btn">+ New Day</button>
      </div>
    </div>
    <form id="settings-panel" class="settings-panel" hidden>
      <div class="settings-header">
        <label class="settings-label" for="backup-repo-input">Backup GitHub Destination</label>
        <button type="button" id="settings-cancel-btn" class="icon-btn" title="Close settings" aria-label="Close settings">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
          </svg>
        </button>
      </div>
      <p class="settings-help">
        Saves your todo feed as <code>todoodle.md</code> on <code>main</code> (accepts <code>owner/repo</code>, a repo URL, or a subfolder URL). Must be a repository without <code>main</code> branch protection so it can version itself directly.
      </p>
      <div class="settings-row">
        <input
          type="text"
          id="backup-repo-input"
          class="settings-input"
          placeholder="owner/repo or repo/subfolder URL"
          autocomplete="off"
        />
        <button type="submit" class="small-btn primary">Save</button>
      </div>
    </form>
    <div id="feed"></div>
  </div>
  <script>
    const titleEl = document.getElementById("list-title");
    const feedEl = document.getElementById("feed");
    const topBarRight = document.querySelector(".top-bar-right");
    const newDayBtn = document.getElementById("new-day-btn");
    const undoBtn = document.getElementById("undo-btn");
    const redoBtn = document.getElementById("redo-btn");
    const backupBtn = document.getElementById("backup-btn");
    const settingsBtn = document.getElementById("settings-btn");
    const settingsPanel = document.getElementById("settings-panel");
    const backupRepoInput = document.getElementById("backup-repo-input");
    const settingsCancelBtn = document.getElementById("settings-cancel-btn");
    const defaultBackupSvg = backupBtn.innerHTML;
    let isBackingUp = false;

    let editingId = null;
    let prEditingId = null;
    let prSearchQuery = "";
    let cachedPrResults = null;
    let confirmDeleteDayId = null;
    let confirmDeleteItemId = null;
    let justCheckedId = null;
    const openReportsByDay = new Set();
    const copiedStateByDay = new Map();
    let latestState = { title: "Todoodle", days: [], items: [], canUndo: false, canRedo: false };

    function focusDayInput(dayId) {
      const targetDayId =
        dayId || (latestState.days && latestState.days[0] && latestState.days[0].id);
      if (!targetDayId) return;
      const focusNow = () => {
        const input = feedEl.querySelector(
          'input.add-input[data-day-id="' + targetDayId + '"]'
        );
        if (input) input.focus();
      };
      focusNow();
      requestAnimationFrame(focusNow);
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function getItemPrs(item) {
      if (Array.isArray(item.prs) && item.prs.length) return item.prs;
      if (item.pr) return [item.pr];
      return [];
    }

    function buildSlackStatusReport(dayObj, dayItems) {
      const blocked = dayItems.filter((it) => !it.completed && it.blocked);
      const completed = dayItems.filter((it) => it.completed);
      const inProgress = dayItems.filter(
        (it) => !it.completed && !it.blocked && it.inProgress
      );
      const notAddressed = dayItems.filter(
        (it) => !it.completed && !it.blocked && !it.inProgress && !it.upcoming
      );
      const upcoming = dayItems.filter(
        (it) => !it.completed && !it.blocked && !it.inProgress && it.upcoming
      );

      const formatPrPlain = (it) => {
        const prs = getItemPrs(it);
        if (!prs.length) return "";
        const parts = prs.map((p) => {
          const label = p.label || p.url;
          const draft = p.isDraft ? " (draft)" : "";
          return label + draft;
        });
        return " — " + parts.join(", ");
      };

      const formatPrHtml = (it) => {
        const prs = getItemPrs(it);
        if (!prs.length) return "";
        const parts = prs.map((p) => {
          const label = escapeHtml(p.label || p.url);
          const link = p.url
            ? '<a href="' + escapeHtml(p.url) + '">' + label + "</a>"
            : label;
          return link + (p.isDraft ? " (draft)" : "");
        });
        return " — " + parts.join(", ");
      };

      const plainLines = [];
      const htmlParts = [];

      if (blocked.length > 0) {
        plainLines.push("*Blocked*");
        htmlParts.push("<p><b>Blocked</b></p><ul>");
        for (const it of blocked) {
          plainLines.push("• " + it.text + formatPrPlain(it));
          htmlParts.push("<li>" + escapeHtml(it.text) + formatPrHtml(it) + "</li>");
        }
        htmlParts.push("</ul>");
        plainLines.push("");
      }

      plainLines.push("*Completed*");
      htmlParts.push("<p><b>Completed</b></p><ul>");
      if (completed.length === 0) {
        plainLines.push("• _None_");
        htmlParts.push("<li><i>None</i></li>");
      } else {
        for (const it of completed) {
          plainLines.push("• " + it.text + formatPrPlain(it));
          htmlParts.push("<li>" + escapeHtml(it.text) + formatPrHtml(it) + "</li>");
        }
      }
      htmlParts.push("</ul>");

      if (inProgress.length > 0) {
        plainLines.push("");
        plainLines.push("*In progress*");
        htmlParts.push("<p><b>In progress</b></p><ul>");
        for (const it of inProgress) {
          plainLines.push("• " + it.text + formatPrPlain(it));
          htmlParts.push("<li>" + escapeHtml(it.text) + formatPrHtml(it) + "</li>");
        }
        htmlParts.push("</ul>");
      }

      if (notAddressed.length > 0) {
        plainLines.push("");
        plainLines.push("*Not addressed today*");
        htmlParts.push("<p><b>Not addressed today</b></p><ul>");
        for (const it of notAddressed) {
          plainLines.push("• " + it.text + formatPrPlain(it));
          htmlParts.push("<li>" + escapeHtml(it.text) + formatPrHtml(it) + "</li>");
        }
        htmlParts.push("</ul>");
      }

      if (upcoming.length > 0) {
        plainLines.push("");
        plainLines.push("*Upcoming*");
        htmlParts.push("<p><b>Upcoming</b></p><ul>");
        for (const it of upcoming) {
          plainLines.push("• " + it.text + formatPrPlain(it));
          htmlParts.push("<li>" + escapeHtml(it.text) + formatPrHtml(it) + "</li>");
        }
        htmlParts.push("</ul>");
      }

      return {
        plain: plainLines.join("\\n"),
        html: htmlParts.join(""),
      };
    }

    async function copyReportToClipboard(dayObj) {
      let currentItems = (latestState.items || []).filter(
        (it) => it.dayId === dayObj.id
      );
      try {
        const res = await fetch(
          "/api/status-report?dayId=" + encodeURIComponent(dayObj.id)
        );
        if (res.ok) {
          const refreshed = await res.json();
          if (refreshed && refreshed.state) {
            latestState = refreshed.state;
            currentItems = (latestState.items || []).filter(
              (it) => it.dayId === dayObj.id
            );
          }
        }
      } catch {}
      const report = buildSlackStatusReport(dayObj, currentItems);
      try {
        if (navigator.clipboard && window.ClipboardItem) {
          const item = new ClipboardItem({
            "text/plain": new Blob([report.plain], { type: "text/plain" }),
            "text/html": new Blob([report.html], { type: "text/html" }),
          });
          await navigator.clipboard.write([item]);
        } else {
          await navigator.clipboard.writeText(report.plain);
        }
      } catch {
        try {
          await navigator.clipboard.writeText(report.plain);
        } catch {}
      }
      copiedStateByDay.set(dayObj.id, true);
      render(latestState);
      setTimeout(() => {
        copiedStateByDay.delete(dayObj.id);
        render(latestState);
      }, 1800);
    }

    function startEdit(span, item) {
      if (editingId === item.id) return;
      editingId = item.id;

      const editInput = document.createElement("input");
      editInput.type = "text";
      editInput.className = "edit-input";
      editInput.value = item.text;
      span.replaceWith(editInput);
      editInput.focus();
      editInput.select();

      let finished = false;
      async function commit(save) {
        if (finished) return;
        finished = true;
        const newText = editInput.value.trim();
        const itemDayId = item.dayId;
        editingId = null;
        if (save && newText && newText !== item.text) {
          item.text = newText;
          render(latestState);
          focusDayInput(itemDayId);
          await fetch("/api/edit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: item.id, text: newText }),
          });
          focusDayInput(itemDayId);
        } else {
          render(latestState);
          if (save) {
            focusDayInput(itemDayId);
          }
        }
      }

      editInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          commit(false);
        }
      });
      editInput.addEventListener("blur", () => commit(true));
    }

    function createDoodleCheckbox(item) {
      const isChecked = Boolean(item.completed);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.setAttribute("role", "checkbox");
      btn.setAttribute("aria-checked", String(isChecked));
      btn.setAttribute("aria-label", "Toggle " + item.text);
      btn.className =
        "doodle-checkbox" +
        (isChecked ? " checked" : "") +
        (isChecked && justCheckedId === item.id ? " just-checked" : "");
      btn.innerHTML =
        '<svg viewBox="0 0 20 20" aria-hidden="true">' +
        '<path class="doodle-box-path" d="M 3.3 4.2 C 7.6 3.4, 13.7 3.6, 16.9 4.1 C 17.5 7.9, 17.2 13.4, 16.6 16.8 C 12.4 17.4, 6.7 17.1, 3.5 16.6 C 2.9 12.9, 3.1 7.5, 3.3 4.2 Z"/>' +
        '<path class="doodle-check-path" d="M 5.4 10.6 C 6.8 12.1, 8.1 13.8, 9.1 14.8 C 11.4 10.9, 14.5 6.4, 18.4 3.1"/>' +
        "</svg>";
      btn.addEventListener("click", async () => {
        const nextCompleted = !item.completed;
        item.completed = nextCompleted;
        justCheckedId = nextCompleted ? item.id : null;
        render(latestState);
        await fetch("/api/toggle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: item.id, completed: nextCompleted }),
        });
        if (justCheckedId === item.id) {
          setTimeout(() => {
            if (justCheckedId === item.id) justCheckedId = null;
          }, 350);
        }
      });
      return btn;
    }

    function createPrIconSvg() {
      const span = document.createElement("span");
      span.style.display = "inline-flex";
      span.style.alignItems = "center";
      span.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
        '<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"></path>' +
        "</svg>";
      return span;
    }

    function createReportIconSvg() {
      const span = document.createElement("span");
      span.style.display = "inline-flex";
      span.style.alignItems = "center";
      span.style.justifyContent = "center";
      // 4-color Slack octothorpe/pinwheel icon (14x14 visual box)
      span.innerHTML =
        '<svg width="14" height="14" viewBox="2 2 20 20" fill="none" aria-hidden="true">' +
        '<path fill="#E01E5A" d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Z"></path>' +
        '<path fill="#36C5F0" d="M9 6a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Z"></path>' +
        '<path fill="#2EB67D" d="M18 9a2 2 0 1 1 2 2h-2V9Zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5Z"></path>' +
        '<path fill="#ECB22E" d="M15 18a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z"></path>' +
        "</svg>";
      return span;
    }

    function createCloseIconSvg() {
      const span = document.createElement("span");
      span.style.display = "inline-flex";
      span.style.alignItems = "center";
      span.style.justifyContent = "center";
      span.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>' +
        "</svg>";
      return span;
    }

    function createEditIconSvg() {
      const span = document.createElement("span");
      span.style.display = "inline-flex";
      span.style.alignItems = "center";
      span.style.justifyContent = "center";
      span.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>' +
        "</svg>";
      return span;
    }

    function createUpcomingIconSvg() {
      const span = document.createElement("span");
      span.style.display = "inline-flex";
      span.style.alignItems = "center";
      span.style.justifyContent = "center";
      // Lucide chevrons-right (fast-forward / next up) icon
      span.innerHTML =
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>' +
        "</svg>";
      return span;
    }

    function createBlockedIconSvg() {
      const span = document.createElement("span");
      span.style.display = "inline-flex";
      span.style.alignItems = "center";
      span.style.justifyContent = "center";
      // Lucide ban / blocker icon
      span.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>' +
        "</svg>";
      return span;
    }

    function createGripIconSvg() {
      const span = document.createElement("span");
      span.style.display = "inline-flex";
      span.style.alignItems = "center";
      span.style.justifyContent = "center";
      // Lucide grip-vertical 6-dot handle
      span.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/>' +
        '<circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>' +
        "</svg>";
      return span;
    }

    function startPointerDrag(e, draggedItem, sourceLi) {
      if (e.button !== 0 || editingId) return;
      e.preventDefault();

      const sourceRect = sourceLi.getBoundingClientRect();
      const offsetX = e.clientX - sourceRect.left;
      const offsetY = e.clientY - sourceRect.top;

      const ghost = document.createElement("div");
      ghost.className =
        "drag-ghost" + (draggedItem.completed ? " completed" : "");
      const rowClone = sourceLi.querySelector(".todo-row").cloneNode(true);
      ghost.appendChild(rowClone);
      ghost.style.width = sourceRect.width + "px";
      ghost.style.left = sourceRect.left + "px";
      ghost.style.top = sourceRect.top + "px";
      document.body.appendChild(ghost);

      sourceLi.classList.add("dragging");
      document.body.classList.add("is-dragging");

      const indicator = document.createElement("div");
      indicator.className = "drop-indicator";
      indicator.hidden = true;
      document.body.appendChild(indicator);

      let currentTargetDayId = null;
      let currentBeforeItemId = null;

      function clearEmptyHighlights() {
        for (const el of feedEl.querySelectorAll(".day-block.drop-target-empty")) {
          el.classList.remove("drop-target-empty");
        }
      }

      function onPointerMove(moveEvent) {
        ghost.style.left = moveEvent.clientX - offsetX + "px";
        ghost.style.top = moveEvent.clientY - offsetY + "px";

        clearEmptyHighlights();
        const dayBlocks = Array.from(feedEl.querySelectorAll(".day-block[data-day-id]"));
        if (dayBlocks.length === 0) return;

        // Find the day block under or closest to pointer Y
        let chosenBlock = dayBlocks[0];
        let bestDist = Infinity;
        for (const block of dayBlocks) {
          const rect = block.getBoundingClientRect();
          if (moveEvent.clientY >= rect.top && moveEvent.clientY <= rect.bottom) {
            chosenBlock = block;
            bestDist = 0;
            break;
          }
          const dist =
            moveEvent.clientY < rect.top
              ? rect.top - moveEvent.clientY
              : moveEvent.clientY - rect.bottom;
          if (dist < bestDist) {
            bestDist = dist;
            chosenBlock = block;
          }
        }

        const targetDayId = chosenBlock.dataset.dayId;
        currentTargetDayId = targetDayId;

        const itemEls = Array.from(
          chosenBlock.querySelectorAll("li.todo-item[data-item-id]")
        ).filter((el) => el.dataset.itemId !== draggedItem.id);

        if (itemEls.length === 0) {
          currentBeforeItemId = null;
          const listOrEmpty =
            chosenBlock.querySelector(".empty-state") ||
            chosenBlock.querySelector("ul.todo-list") ||
            chosenBlock;
          chosenBlock.classList.add("drop-target-empty");
          const rect = listOrEmpty.getBoundingClientRect();
          indicator.hidden = false;
          indicator.style.left = rect.left + 8 + "px";
          indicator.style.width = Math.max(80, rect.width - 16) + "px";
          indicator.style.top = rect.top + 2 + "px";
          return;
        }

        let beforeEl = null;
        for (const el of itemEls) {
          const rect = el.getBoundingClientRect();
          const midY = rect.top + rect.height / 2;
          if (moveEvent.clientY < midY) {
            beforeEl = el;
            break;
          }
        }

        if (beforeEl) {
          currentBeforeItemId = beforeEl.dataset.itemId;
          const rect = beforeEl.getBoundingClientRect();
          indicator.hidden = false;
          indicator.style.left = rect.left + 8 + "px";
          indicator.style.width = Math.max(80, rect.width - 16) + "px";
          indicator.style.top = rect.top - 1 + "px";
        } else {
          currentBeforeItemId = null;
          const lastEl = itemEls[itemEls.length - 1];
          const rect = lastEl.getBoundingClientRect();
          indicator.hidden = false;
          indicator.style.left = rect.left + 8 + "px";
          indicator.style.width = Math.max(80, rect.width - 16) + "px";
          indicator.style.top = rect.bottom - 1 + "px";
        }
      }

      async function onPointerUp() {
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        window.removeEventListener("pointercancel", onPointerUp);
        clearEmptyHighlights();
        ghost.remove();
        indicator.remove();
        sourceLi.classList.remove("dragging");
        document.body.classList.remove("is-dragging");

        if (!currentTargetDayId) return;

        await fetch("/api/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: draggedItem.id,
            targetDayId: currentTargetDayId,
            beforeItemId: currentBeforeItemId,
          }),
        });
      }

      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerUp);
    }

    const CHAR_TRANSFORMS = [
      "rotate(-5.5deg) translateY(0px)",
      "rotate(4.5deg) translateY(1px) scale(0.97)",
      "rotate(-3.5deg) translateY(-1px)",
      "rotate(6deg) translateY(0.5px) scale(1.03)",
      "rotate(-5deg) translateY(1.5px) scale(0.95)",
      "rotate(3.5deg) translateY(-0.5px)",
      "rotate(-4.5deg) translateY(0px)",
      "rotate(6.5deg) translateY(1px)",
    ];

    function renderTitleWordmark(text) {
      const str = text || "Todoodle";
      if (titleEl.dataset.renderedText === str) return;
      titleEl.dataset.renderedText = str;
      titleEl.setAttribute("aria-label", str);
      titleEl.innerHTML = "";
      Array.from(str).forEach((ch, idx) => {
        const s = document.createElement("span");
        s.className = "title-char";
        s.setAttribute("aria-hidden", "true");
        s.textContent = ch === " " ? "\u00A0" : ch;
        s.style.transform = CHAR_TRANSFORMS[idx % CHAR_TRANSFORMS.length];
        titleEl.appendChild(s);
      });
    }

    function render(state) {
      latestState = state;
      if (editingId) return;
      renderTitleWordmark(state.title || "Todoodle");
      undoBtn.disabled = !state.canUndo;
      redoBtn.disabled = !state.canRedo;
      if (!isBackingUp) {
        const hasBackupRepo = Boolean(state.backupRepo);
        backupBtn.disabled = !hasBackupRepo;
        backupBtn.title = hasBackupRepo
          ? "Backup todo feed to " + state.backupRepo + " (todoodle.md)"
          : "Configure a backup repository in Settings first";
      }
      feedEl.innerHTML = "";

      const days = Array.isArray(state.days) ? state.days : [];
      const items = Array.isArray(state.items) ? state.items : [];
      const fallbackDayId = days[0] ? days[0].id : null;

      // Days are stored in reverse chronological order (newest at index 0)
      for (let idx = 0; idx < days.length; idx++) {
        const dayObj = days[idx];
        const dayItems = items.filter(
          (it) => (it.dayId || fallbackDayId) === dayObj.id
        );

        const blockEl = document.createElement("section");
        blockEl.className = "day-block";
        blockEl.dataset.dayId = dayObj.id;

        // Day divider header with fun random emoji + Date
        const dividerEl = document.createElement("div");
        dividerEl.className = "day-divider";

        const dayHeaderLabel = document.createElement("span");
        dayHeaderLabel.className = "day-header-label";

        const emojiSpan = document.createElement("span");
        emojiSpan.className = "day-emoji";
        emojiSpan.textContent = dayObj.emoji || "✨";

        const dateSpan = document.createElement("span");
        dateSpan.textContent = dayObj.dateLabel;

        dayHeaderLabel.appendChild(emojiSpan);
        dayHeaderLabel.appendChild(dateSpan);

        const lineEl = document.createElement("div");
        lineEl.className = "day-divider-line";

        const dayActions = document.createElement("div");
        dayActions.className = "day-actions";

        if (confirmDeleteDayId === dayObj.id) {
          const confirmWrap = document.createElement("span");
          confirmWrap.className = "confirm-pill";

          const yesBtn = document.createElement("button");
          yesBtn.type = "button";
          yesBtn.className = "confirm-danger-btn";
          yesBtn.textContent = "Delete day?";
          yesBtn.addEventListener("click", async () => {
            confirmDeleteDayId = null;
            openReportsByDay.delete(dayObj.id);
            await fetch("/api/delete-day", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ dayId: dayObj.id }),
            });
            focusDayInput();
          });

          const noBtn = document.createElement("button");
          noBtn.type = "button";
          noBtn.className = "confirm-cancel-btn";
          noBtn.textContent = "Cancel";
          noBtn.addEventListener("click", () => {
            confirmDeleteDayId = null;
            render(latestState);
          });

          confirmWrap.appendChild(yesBtn);
          confirmWrap.appendChild(noBtn);
          dayActions.appendChild(confirmWrap);
        } else {
          const deleteDayBtn = document.createElement("button");
          deleteDayBtn.type = "button";
          deleteDayBtn.className = "icon-btn";
          deleteDayBtn.title = "Delete day";
          deleteDayBtn.setAttribute("aria-label", "Delete day " + dayObj.dateLabel);
          deleteDayBtn.appendChild(createCloseIconSvg());
          deleteDayBtn.addEventListener("click", () => {
            confirmDeleteDayId = dayObj.id;
            confirmDeleteItemId = null;
            render(latestState);
          });
          dayActions.appendChild(deleteDayBtn);
        }

        dividerEl.appendChild(dayHeaderLabel);
        dividerEl.appendChild(lineEl);
        dividerEl.appendChild(dayActions);
        blockEl.appendChild(dividerEl);

        // Per-day add todo form
        const formEl = document.createElement("form");
        formEl.className = "add-form";

        const inputEl = document.createElement("input");
        inputEl.type = "text";
        inputEl.className = "add-input";
        inputEl.dataset.dayId = dayObj.id;
        inputEl.placeholder =
          idx === 0 ? "Add a todo..." : "Add a todo to " + dayObj.dateLabel + "...";
        inputEl.autocomplete = "off";

        const addBtn = document.createElement("button");
        addBtn.type = "submit";
        addBtn.className = "add-btn";
        addBtn.textContent = "Add";

        formEl.appendChild(inputEl);
        formEl.appendChild(addBtn);

        formEl.addEventListener("submit", async (e) => {
          e.preventDefault();
          const text = inputEl.value.trim();
          inputEl.value = "";
          focusDayInput(dayObj.id);
          if (!text) return;
          await fetch("/api/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, dayId: dayObj.id }),
          });
          focusDayInput(dayObj.id);
        });

        blockEl.appendChild(formEl);

        if (dayItems.length === 0) {
          const emptyEl = document.createElement("div");
          emptyEl.className = "empty-state";
          emptyEl.textContent = "No items yet.";
          blockEl.appendChild(emptyEl);
        } else {
          const listEl = document.createElement("ul");
          listEl.className = "todo-list";

          for (const item of dayItems) {
            const li = document.createElement("li");
            li.className =
              "todo-item" +
              (item.completed ? " completed" : "") +
              (item.upcoming && !item.completed ? " upcoming" : "");
            li.dataset.itemId = item.id;

            const rowEl = document.createElement("div");
            rowEl.className = "todo-row";

            const dragHandle = document.createElement("span");
            dragHandle.className = "drag-handle";
            dragHandle.title = "Drag to reorder or move between days";
            dragHandle.appendChild(createGripIconSvg());
            dragHandle.addEventListener("pointerdown", (e) =>
              startPointerDrag(e, item, li)
            );

            let leadControl;
            if (item.blocked && !item.completed) {
              const blockedEmoji = document.createElement("span");
              blockedEmoji.className = "todo-blocked-emoji";
              blockedEmoji.title = "Blocked (click to unblock)";
              blockedEmoji.textContent = "🚫";
              blockedEmoji.addEventListener("click", async () => {
                await fetch("/api/blocked", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: item.id, blocked: false }),
                });
              });
              leadControl = blockedEmoji;
            } else if (item.upcoming && !item.completed) {
              const upcomingLead = document.createElement("span");
              upcomingLead.className = "todo-upcoming-lead";
              upcomingLead.title = "Upcoming (click to unmark upcoming)";
              upcomingLead.appendChild(createUpcomingIconSvg());
              upcomingLead.addEventListener("click", async () => {
                await fetch("/api/upcoming", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: item.id, upcoming: false }),
                });
              });
              leadControl = upcomingLead;
            } else {
              leadControl = createDoodleCheckbox(item);
            }

            const mainCol = document.createElement("div");
            mainCol.className = "todo-main";

            const textLine = document.createElement("div");
            textLine.className = "todo-text-line";

            if (item.inProgress && !item.completed) {
              const dot = document.createElement("span");
              dot.className = "in-progress-dot";
              dot.title = "In progress";
              textLine.appendChild(dot);
            }

            const span = document.createElement("span");
            span.className = "todo-text";
            span.title = "Click to edit";
            span.textContent = item.text;
            span.addEventListener("click", () => startEdit(span, item));

            textLine.appendChild(span);
            mainCol.appendChild(textLine);

            // Attached PR reference links in small text under the todo's main text
            const itemPrs = getItemPrs(item);
            if (itemPrs.length > 0) {
              const prSubline = document.createElement("div");
              prSubline.className = "todo-pr-subline";
              for (const pr of itemPrs) {
                const wrap = document.createElement("span");
                wrap.className = "todo-pr-link-wrap";
                wrap.appendChild(createPrIconSvg());

                if (pr.url) {
                  const a = document.createElement("a");
                  a.className = "todo-pr-link";
                  a.href = pr.url;
                  a.target = "_blank";
                  a.rel = "noopener noreferrer";
                  a.textContent = pr.label || pr.url;
                  wrap.appendChild(a);
                } else {
                  const s = document.createElement("span");
                  s.className = "todo-pr-link";
                  s.textContent = pr.label;
                  wrap.appendChild(s);
                }

                if (pr.isDraft) {
                  const draftPill = document.createElement("span");
                  draftPill.className = "pr-draft-pill";
                  draftPill.textContent = "draft";
                  wrap.appendChild(draftPill);
                }

                const removePrBtn = document.createElement("button");
                removePrBtn.type = "button";
                removePrBtn.className = "pr-chip-remove";
                removePrBtn.title = "Remove PR " + (pr.label || pr.url);
                removePrBtn.setAttribute("aria-label", "Remove PR " + (pr.label || pr.url));
                removePrBtn.textContent = "×";
                removePrBtn.addEventListener("click", async (e) => {
                  e.stopPropagation();
                  await fetch("/api/pr", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      id: item.id,
                      action: "remove",
                      prKey: pr.url || pr.label,
                    }),
                  });
                });
                wrap.appendChild(removePrBtn);

                prSubline.appendChild(wrap);
              }
              mainCol.appendChild(prSubline);
            }

            // Floating toolbar: [In Progress] [Attach PR] [Edit] [Remove]
            const actions = document.createElement("div");
            actions.className =
              "item-actions" +
              (prEditingId === item.id || confirmDeleteItemId === item.id
                ? " force-visible"
                : "");

            const inProgBtn = document.createElement("button");
            inProgBtn.type = "button";
            inProgBtn.className = "icon-btn" + (item.inProgress ? " active" : "");
            inProgBtn.title = item.inProgress ? "Mark not in progress" : "Mark in progress";
            inProgBtn.setAttribute("aria-label", "Toggle in progress for " + item.text);
            inProgBtn.textContent = "●";
            inProgBtn.addEventListener("click", async () => {
              await fetch("/api/in-progress", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: item.id, inProgress: !item.inProgress }),
              });
            });

            const upcomingBtn = document.createElement("button");
            upcomingBtn.type = "button";
            upcomingBtn.className = "icon-btn" + (item.upcoming ? " active" : "");
            upcomingBtn.title = item.upcoming ? "Unmark upcoming" : "Mark as upcoming";
            upcomingBtn.setAttribute("aria-label", "Toggle upcoming for " + item.text);
            upcomingBtn.appendChild(createUpcomingIconSvg());
            upcomingBtn.addEventListener("click", async () => {
              await fetch("/api/upcoming", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: item.id, upcoming: !item.upcoming }),
              });
            });

            const blockedBtn = document.createElement("button");
            blockedBtn.type = "button";
            blockedBtn.className =
              "icon-btn" + (item.blocked ? " active-danger" : "");
            blockedBtn.title = item.blocked ? "Unmark blocked" : "Mark as blocked";
            blockedBtn.setAttribute("aria-label", "Toggle blocked for " + item.text);
            blockedBtn.appendChild(createBlockedIconSvg());
            blockedBtn.addEventListener("click", async () => {
              await fetch("/api/blocked", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: item.id, blocked: !item.blocked }),
              });
            });

            const prBtn = document.createElement("button");
            prBtn.type = "button";
            prBtn.className =
              "icon-btn" + (itemPrs.length > 0 || prEditingId === item.id ? " active" : "");
            prBtn.title = "Attach PR";
            prBtn.setAttribute("aria-label", "Attach PR to " + item.text);
            prBtn.appendChild(createPrIconSvg());
            prBtn.addEventListener("click", () => {
              prEditingId = prEditingId === item.id ? null : item.id;
              prSearchQuery = "";
              render(latestState);
            });

            const editBtn = document.createElement("button");
            editBtn.type = "button";
            editBtn.className = "icon-btn";
            editBtn.title = "Edit";
            editBtn.setAttribute("aria-label", "Edit " + item.text);
            editBtn.appendChild(createEditIconSvg());
            editBtn.addEventListener("click", () => startEdit(span, item));

            actions.appendChild(inProgBtn);
            actions.appendChild(blockedBtn);
            actions.appendChild(upcomingBtn);
            actions.appendChild(prBtn);
            actions.appendChild(editBtn);

            if (confirmDeleteItemId === item.id) {
              const confirmWrap = document.createElement("span");
              confirmWrap.className = "confirm-pill";

              const yesBtn = document.createElement("button");
              yesBtn.type = "button";
              yesBtn.className = "confirm-danger-btn";
              yesBtn.textContent = "Delete?";
              yesBtn.addEventListener("click", async () => {
                confirmDeleteItemId = null;
                focusDayInput(dayObj.id);
                await fetch("/api/remove", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ id: item.id }),
                });
                focusDayInput(dayObj.id);
              });

              const noBtn = document.createElement("button");
              noBtn.type = "button";
              noBtn.className = "confirm-cancel-btn";
              noBtn.textContent = "Cancel";
              noBtn.addEventListener("click", () => {
                confirmDeleteItemId = null;
                render(latestState);
                focusDayInput(dayObj.id);
              });

              confirmWrap.appendChild(yesBtn);
              confirmWrap.appendChild(noBtn);
              actions.appendChild(confirmWrap);
            } else {
              const delBtn = document.createElement("button");
              delBtn.type = "button";
              delBtn.className = "icon-btn";
              delBtn.title = "Remove";
              delBtn.setAttribute("aria-label", "Remove " + item.text);
              delBtn.appendChild(createCloseIconSvg());
              delBtn.addEventListener("click", () => {
                confirmDeleteItemId = item.id;
                confirmDeleteDayId = null;
                render(latestState);
              });
              actions.appendChild(delBtn);
            }

            rowEl.appendChild(dragHandle);
            rowEl.appendChild(leadControl);
            rowEl.appendChild(mainCol);
            rowEl.appendChild(actions);
            li.appendChild(rowEl);

            // Searchable PR Picker popover (supports attaching multiple PRs)
            if (prEditingId === item.id) {
              const prEditor = document.createElement("div");
              prEditor.className = "pr-editor";

              const headerEl = document.createElement("div");
              headerEl.className = "pr-picker-header";

              const prInput = document.createElement("input");
              prInput.type = "text";
              prInput.className = "pr-picker-search";
              prInput.placeholder = "Search your PRs or paste URL / owner/repo#123...";
              prInput.value = prSearchQuery;

              const doneBtn = document.createElement("button");
              doneBtn.type = "button";
              doneBtn.className = "small-btn";
              doneBtn.textContent = "Done";
              doneBtn.addEventListener("click", () => {
                prEditingId = null;
                prSearchQuery = "";
                render(latestState);
                focusDayInput(dayObj.id);
              });

              headerEl.appendChild(prInput);
              headerEl.appendChild(doneBtn);
              prEditor.appendChild(headerEl);

              const resultsList = document.createElement("ul");
              resultsList.className = "pr-picker-list";
              prEditor.appendChild(resultsList);

              let currentCandidates = Array.isArray(cachedPrResults)
                ? cachedPrResults
                : [];
              let activeIdx = 0;
              let searchTimer = null;

              function isPrAttached(cand) {
                const currentItem =
                  (latestState.items || []).find((it) => it.id === item.id) || item;
                const prs = getItemPrs(currentItem);
                return prs.some(
                  (p) =>
                    (cand.url && p.url === cand.url) ||
                    (cand.label && p.label === cand.label)
                );
              }

              async function toggleCandidate(cand) {
                const attached = isPrAttached(cand);
                if (attached) {
                  await fetch("/api/pr", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      id: item.id,
                      action: "remove",
                      prKey: cand.url || cand.label,
                    }),
                  });
                } else {
                  await fetch("/api/pr", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      id: item.id,
                      action: "add",
                      pr: {
                        url: cand.url,
                        label: cand.label,
                        isDraft: Boolean(cand.isDraft),
                      },
                    }),
                  });
                }
              }

              function renderCandidates(list, loadingText) {
                resultsList.innerHTML = "";
                if (loadingText && (!list || list.length === 0)) {
                  const status = document.createElement("li");
                  status.className = "pr-picker-status";
                  status.textContent = loadingText;
                  resultsList.appendChild(status);
                  return;
                }
                if (!list || list.length === 0) {
                  const status = document.createElement("li");
                  status.className = "pr-picker-status";
                  status.textContent =
                    "No matching PRs found. Press Enter to attach by URL or owner/repo#number.";
                  resultsList.appendChild(status);
                  return;
                }
                if (activeIdx >= list.length) activeIdx = 0;
                list.forEach((cand, i) => {
                  const row = document.createElement("li");
                  row.className =
                    "pr-picker-item" + (i === activeIdx ? " active" : "");

                  const iconWrap = document.createElement("span");
                  iconWrap.className =
                    "pr-picker-icon" +
                    (cand.isDraft
                      ? " draft"
                      : cand.state === "merged"
                        ? " merged"
                        : "");
                  iconWrap.appendChild(createPrIconSvg());

                  const body = document.createElement("div");
                  body.className = "pr-picker-body";

                  const titleDiv = document.createElement("div");
                  titleDiv.className = "pr-picker-title";
                  titleDiv.textContent = cand.title || cand.label;

                  const metaDiv = document.createElement("div");
                  metaDiv.className = "pr-picker-meta";
                  const labelSpan = document.createElement("span");
                  labelSpan.textContent = cand.label;
                  metaDiv.appendChild(labelSpan);

                  if (cand.isDraft) {
                    const pill = document.createElement("span");
                    pill.className = "pr-draft-pill";
                    pill.textContent = "draft";
                    metaDiv.appendChild(pill);
                  } else if (cand.state === "merged") {
                    const pill = document.createElement("span");
                    pill.className = "pr-draft-pill";
                    pill.textContent = "merged";
                    metaDiv.appendChild(pill);
                  }

                  body.appendChild(titleDiv);
                  body.appendChild(metaDiv);

                  row.appendChild(iconWrap);
                  row.appendChild(body);

                  if (isPrAttached(cand)) {
                    const check = document.createElement("span");
                    check.className = "pr-picker-check";
                    check.textContent = "✓";
                    row.appendChild(check);
                  }

                  row.addEventListener("mouseenter", () => {
                    activeIdx = i;
                    for (const child of resultsList.children) {
                      child.classList.remove("active");
                    }
                    row.classList.add("active");
                  });

                  row.addEventListener("click", async () => {
                    await toggleCandidate(cand);
                  });

                  resultsList.appendChild(row);
                });
              }

              async function loadPrCandidates(q) {
                try {
                  const res = await fetch(
                    "/api/search-prs?q=" + encodeURIComponent(q || "")
                  );
                  if (!res.ok) return;
                  const data = await res.json();
                  const results = Array.isArray(data.prs) ? data.prs : [];
                  if (!q) {
                    cachedPrResults = results;
                  }
                  currentCandidates = results;
                  activeIdx = 0;
                  renderCandidates(currentCandidates, null);
                } catch {
                  renderCandidates(currentCandidates, null);
                }
              }

              prInput.addEventListener("input", () => {
                const q = prInput.value.trim();
                prSearchQuery = prInput.value;
                if (cachedPrResults && q) {
                  const lower = q.toLowerCase();
                  const localFiltered = cachedPrResults.filter(
                    (c) =>
                      (c.title && c.title.toLowerCase().includes(lower)) ||
                      (c.label && c.label.toLowerCase().includes(lower))
                  );
                  currentCandidates = localFiltered;
                  activeIdx = 0;
                  renderCandidates(currentCandidates, "Searching GitHub...");
                } else if (cachedPrResults && !q) {
                  currentCandidates = cachedPrResults;
                  activeIdx = 0;
                  renderCandidates(currentCandidates, null);
                }
                if (searchTimer) clearTimeout(searchTimer);
                searchTimer = setTimeout(() => loadPrCandidates(q), 220);
              });

              prInput.addEventListener("keydown", async (e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  prEditingId = null;
                  render(latestState);
                  focusDayInput(dayObj.id);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  if (currentCandidates.length > 0) {
                    activeIdx = (activeIdx + 1) % currentCandidates.length;
                    renderCandidates(currentCandidates, null);
                  }
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  if (currentCandidates.length > 0) {
                    activeIdx =
                      (activeIdx - 1 + currentCandidates.length) %
                      currentCandidates.length;
                    renderCandidates(currentCandidates, null);
                  }
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (currentCandidates.length > 0 && currentCandidates[activeIdx]) {
                    await toggleCandidate(currentCandidates[activeIdx]);
                  } else {
                    const ref = prInput.value.trim();
                    if (ref) {
                      prInput.value = "";
                      await fetch("/api/pr", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          id: item.id,
                          action: "add",
                          pr: { ref },
                        }),
                      });
                    }
                  }
                }
              });

              if (cachedPrResults) {
                const q = prSearchQuery.trim().toLowerCase();
                const initialList = q
                  ? cachedPrResults.filter(
                      (c) =>
                        (c.title && c.title.toLowerCase().includes(q)) ||
                        (c.label && c.label.toLowerCase().includes(q))
                    )
                  : cachedPrResults;
                currentCandidates = initialList;
                renderCandidates(initialList, null);
                if (!q) loadPrCandidates("");
              } else {
                renderCandidates([], "Loading your recent PRs...");
                loadPrCandidates(prSearchQuery.trim());
              }

              li.appendChild(prEditor);
              requestAnimationFrame(() => {
                prInput.focus();
                const len = prInput.value.length;
                prInput.setSelectionRange(len, len);
              });
            }

            listEl.appendChild(li);
          }

          blockEl.appendChild(listEl);

          // Full-width Slack status report button at the bottom of the day's todos
          const reportFooter = document.createElement("div");
          reportFooter.className = "day-report-footer";

          const reportBtn = document.createElement("button");
          reportBtn.type = "button";
          reportBtn.className =
            "day-report-full-btn" +
            (openReportsByDay.has(dayObj.id) ? " active" : "");
          reportBtn.appendChild(createReportIconSvg());
          const reportBtnLabel = document.createElement("span");
          reportBtnLabel.textContent = openReportsByDay.has(dayObj.id)
            ? "Hide Slack status report"
            : "Create Slack status report";
          reportBtn.appendChild(reportBtnLabel);
          reportBtn.addEventListener("click", async () => {
            if (openReportsByDay.has(dayObj.id)) {
              openReportsByDay.delete(dayObj.id);
              render(latestState);
            } else {
              openReportsByDay.add(dayObj.id);
              render(latestState);
              try {
                const res = await fetch(
                  "/api/status-report?dayId=" + encodeURIComponent(dayObj.id)
                );
                if (res.ok) {
                  const refreshed = await res.json();
                  if (refreshed && refreshed.state) {
                    latestState = refreshed.state;
                    render(latestState);
                  }
                }
              } catch {}
            }
          });
          reportFooter.appendChild(reportBtn);

          if (openReportsByDay.has(dayObj.id)) {
            const report = buildSlackStatusReport(dayObj, dayItems);
            const reportBox = document.createElement("div");
            reportBox.className = "status-report-box";

            const reportHeader = document.createElement("div");
            reportHeader.className = "status-report-header";

            const reportTitle = document.createElement("span");
            reportTitle.className = "status-report-title";
            reportTitle.textContent = "Slack Status Report";

            const reportActions = document.createElement("div");
            reportActions.className = "status-report-actions";

            const copyBtn = document.createElement("button");
            copyBtn.type = "button";
            copyBtn.className = "small-btn primary";
            copyBtn.textContent = copiedStateByDay.get(dayObj.id)
              ? "Copied ✓"
              : "Copy for Slack";
            copyBtn.addEventListener("click", () => copyReportToClipboard(dayObj));

            const closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "small-btn";
            closeBtn.textContent = "Close";
            closeBtn.addEventListener("click", () => {
              openReportsByDay.delete(dayObj.id);
              render(latestState);
            });

            reportActions.appendChild(copyBtn);
            reportActions.appendChild(closeBtn);
            reportHeader.appendChild(reportTitle);
            reportHeader.appendChild(reportActions);

            const pre = document.createElement("pre");
            pre.className = "status-report-pre";
            pre.textContent = report.plain;

            reportBox.appendChild(reportHeader);
            reportBox.appendChild(pre);
            reportFooter.appendChild(reportBox);
          }

          blockEl.appendChild(reportFooter);
        }

        feedEl.appendChild(blockEl);
      }
    }

    async function triggerUndo() {
      confirmDeleteDayId = null;
      confirmDeleteItemId = null;
      await fetch("/api/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    }

    async function triggerRedo() {
      confirmDeleteDayId = null;
      confirmDeleteItemId = null;
      await fetch("/api/redo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    }

    undoBtn.addEventListener("click", triggerUndo);
    redoBtn.addEventListener("click", triggerRedo);

    settingsBtn.addEventListener("click", () => {
      const opening = settingsPanel.hidden;
      settingsPanel.hidden = !opening;
      settingsBtn.classList.toggle("active", opening);
      topBarRight.classList.toggle("force-visible", opening);
      if (opening) {
        backupRepoInput.value = latestState.backupRepo || "";
        requestAnimationFrame(() => backupRepoInput.focus());
      }
    });

    settingsCancelBtn.addEventListener("click", () => {
      settingsPanel.hidden = true;
      settingsBtn.classList.remove("active");
      topBarRight.classList.remove("force-visible");
    });

    settingsPanel.addEventListener("submit", async (e) => {
      e.preventDefault();
      const backupRepo = backupRepoInput.value.trim();
      settingsPanel.hidden = true;
      settingsBtn.classList.remove("active");
      topBarRight.classList.remove("force-visible");
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backupRepo }),
      });
    });

    backupBtn.addEventListener("click", async () => {
      if (backupBtn.disabled || isBackingUp || !latestState.backupRepo) return;
      isBackingUp = true;
      backupBtn.disabled = true;
      backupBtn.classList.remove("backup-success", "backup-error");
      try {
        const res = await fetch("/api/backup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          backupBtn.classList.add("backup-success");
          backupBtn.textContent = "✓";
          backupBtn.title = "Backed up to " + (data.repo || latestState.backupRepo) + " (todoodle.md)";
        } else {
          backupBtn.classList.add("backup-error");
          backupBtn.textContent = "!";
        }
      } catch {
        backupBtn.classList.add("backup-error");
        backupBtn.textContent = "!";
      } finally {
        isBackingUp = false;
        setTimeout(() => {
          backupBtn.classList.remove("backup-success", "backup-error");
          backupBtn.innerHTML = defaultBackupSvg;
          render(latestState);
        }, 2000);
      }
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && (confirmDeleteDayId || confirmDeleteItemId)) {
        confirmDeleteDayId = null;
        confirmDeleteItemId = null;
        render(latestState);
        return;
      }

      const isMod = e.metaKey || e.ctrlKey || e.altKey;
      if (!isMod) return;

      const active = document.activeElement;
      const isEditingNonEmptyInput =
        active &&
        active.tagName === "INPUT" &&
        active.type === "text" &&
        (active.classList.contains("edit-input") || active.value.trim().length > 0);
      if (isEditingNonEmptyInput) return;

      const key = (e.key || "").toLowerCase();
      const isZ = key === "z" || e.code === "KeyZ";
      const isY = key === "y" || e.code === "KeyY";
      if (isZ && !e.shiftKey) {
        e.preventDefault();
        triggerUndo();
      } else if ((isZ && e.shiftKey) || (isY && !e.shiftKey)) {
        e.preventDefault();
        triggerRedo();
      }
    });

    newDayBtn.addEventListener("click", async () => {
      const res = await fetch("/api/new-day", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      try {
        const data = await res.json();
        if (data && data.day && data.day.id) {
          focusDayInput(data.day.id);
        }
      } catch {}
    });

    renderTitleWordmark("Todoodle");

    fetch("/api/state")
      .then((r) => r.json())
      .then(render);

    const events = new EventSource("/events");
    events.onmessage = (event) => {
      try {
        render(JSON.parse(event.data));
      } catch {}
    };
  </script>
</body>
</html>`;
}

export async function ensureServer(instanceId, listId) {
    const resolvedListId = setListIdForInstance(instanceId, listId);
    let entry = servers.get(instanceId);
    if (entry) {
        return entry;
    }

    const clients = new Set();
    const server = createServer(async (req, res) => {
        const currentListId = getListIdForInstance(instanceId);
        const url = new URL(req.url || "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
            });
            clients.add(res);
            const state = await loadList(currentListId);
            res.write(`data: ${JSON.stringify(state)}\n\n`);
            req.on("close", () => clients.delete(res));
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/state") {
            const state = await loadList(currentListId);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(state));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/new-day") {
            const body = await readJsonBody(req);
            const state = await loadList(currentListId);
            const prevEmoji = state.days[0]?.emoji;
            const newDay = createDayEntry(
                {
                    dateLabel: body.dateLabel,
                    emoji: body.emoji,
                },
                prevEmoji,
            );
            // Reverse chronological order: prepend newest day to the top of the feed
            state.days.unshift(newDay);
            await saveList(state);
            await broadcastListUpdate(currentListId);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, day: newDay }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/delete-day") {
            const body = await readJsonBody(req);
            const dayId = String(body.dayId || "").trim();
            if (dayId) {
                const state = await loadList(currentListId);
                state.days = state.days.filter((d) => d.id !== dayId);
                state.items = state.items.filter((it) => it.dayId !== dayId);
                if (state.days.length === 0) {
                    state.days.push(createDayEntry());
                }
                await saveList(state);
                await broadcastListUpdate(currentListId);
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/undo") {
            await undoList(currentListId);
            await broadcastListUpdate(currentListId);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/redo") {
            await redoList(currentListId);
            await broadcastListUpdate(currentListId);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/settings") {
            const body = await readJsonBody(req);
            await saveSettings({ backupRepo: body.backupRepo });
            await broadcastListUpdate(currentListId);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/backup") {
            try {
                const result = await backupListToWorkdocs(currentListId);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                res.end(
                    JSON.stringify({
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    }),
                );
            }
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/add") {
            const body = await readJsonBody(req);
            const text = String(body.text || "").trim();
            if (text) {
                const state = await loadList(currentListId);
                const dayId =
                    typeof body.dayId === "string" && state.days.some((d) => d.id === body.dayId)
                        ? body.dayId
                        : state.days[0].id;
                state.items.push(
                    normalizeItem(
                        {
                            text,
                            dayId,
                            completed: Boolean(body.completed),
                            inProgress: Boolean(body.inProgress),
                            pr: body.pr,
                        },
                        dayId,
                    ),
                );
                await saveList(state);
                await broadcastListUpdate(currentListId);
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/toggle") {
            const body = await readJsonBody(req);
            const state = await loadList(currentListId);
            const item = state.items.find((it) => it.id === body.id);
            if (item) {
                item.completed =
                    typeof body.completed === "boolean" ? body.completed : !item.completed;
                if (item.completed) {
                    item.blocked = false;
                    item.inProgress = false;
                    item.upcoming = false;
                }
                await saveList(state);
                await broadcastListUpdate(currentListId);
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/in-progress") {
            const body = await readJsonBody(req);
            const state = await loadList(currentListId);
            const item = state.items.find((it) => it.id === body.id);
            if (item) {
                item.inProgress =
                    typeof body.inProgress === "boolean" ? body.inProgress : !item.inProgress;
                if (item.inProgress) {
                    item.completed = false;
                    item.blocked = false;
                    item.upcoming = false;
                }
                await saveList(state);
                await broadcastListUpdate(currentListId);
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/blocked") {
            const body = await readJsonBody(req);
            const state = await loadList(currentListId);
            const item = state.items.find((it) => it.id === body.id);
            if (item) {
                item.blocked =
                    typeof body.blocked === "boolean" ? body.blocked : !item.blocked;
                if (item.blocked) {
                    item.completed = false;
                    item.inProgress = false;
                    item.upcoming = false;
                }
                await saveList(state);
                await broadcastListUpdate(currentListId);
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/upcoming") {
            const body = await readJsonBody(req);
            const state = await loadList(currentListId);
            const item = state.items.find((it) => it.id === body.id);
            if (item) {
                item.upcoming =
                    typeof body.upcoming === "boolean" ? body.upcoming : !item.upcoming;
                if (item.upcoming) {
                    item.completed = false;
                    item.blocked = false;
                    item.inProgress = false;
                }
                await saveList(state);
                await broadcastListUpdate(currentListId);
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/reorder") {
            const body = await readJsonBody(req);
            const state = await loadList(currentListId);
            const fromIdx = state.items.findIndex((it) => it.id === body.id);
            if (fromIdx !== -1) {
                const [moved] = state.items.splice(fromIdx, 1);
                if (
                    typeof body.targetDayId === "string" &&
                    state.days.some((d) => d.id === body.targetDayId)
                ) {
                    moved.dayId = body.targetDayId;
                }
                if (body.beforeItemId) {
                    const beforeIdx = state.items.findIndex(
                        (it) => it.id === body.beforeItemId,
                    );
                    if (beforeIdx !== -1) {
                        state.items.splice(beforeIdx, 0, moved);
                    } else {
                        state.items.push(moved);
                    }
                } else {
                    state.items.push(moved);
                }
                await saveList(state);
                await broadcastListUpdate(currentListId);
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/pr") {
            const body = await readJsonBody(req);
            const state = await loadList(currentListId);
            const item = state.items.find((it) => it.id === body.id);
            if (item) {
                const existing = Array.isArray(item.prs)
                    ? [...item.prs]
                    : item.pr
                      ? [item.pr]
                      : [];
                if (body.action === "remove" && body.prKey) {
                    const nextPrs = existing.filter(
                        (p) => (p.url || p.label) !== body.prKey && p.label !== body.prKey,
                    );
                    item.prs = nextPrs;
                    item.pr = nextPrs[0] || null;
                } else if (!body.pr) {
                    item.prs = [];
                    item.pr = null;
                } else {
                    const rawRefs =
                        typeof body.pr.ref === "string"
                            ? body.pr.ref
                                  .split(/[\s,]+/)
                                  .map((s) => s.trim())
                                  .filter(Boolean)
                            : [body.pr];
                    const resolvedList = await Promise.all(
                        rawRefs.map((r) => resolvePrMetadata(r)),
                    );
                    const merged = body.action === "replace" ? [] : existing;
                    const seen = new Set(merged.map((p) => p.url || p.label));
                    for (const p of resolvedList) {
                        if (!p) continue;
                        const key = p.url || p.label;
                        if (!seen.has(key)) {
                            seen.add(key);
                            merged.push(p);
                        }
                    }
                    item.prs = merged;
                    item.pr = merged[0] || null;
                }
                await saveList(state);
                await broadcastListUpdate(currentListId);
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/edit") {
            const body = await readJsonBody(req);
            const text = String(body.text || "").trim();
            if (text) {
                const state = await loadList(currentListId);
                const item = state.items.find((it) => it.id === body.id);
                if (item) {
                    item.text = text;
                    await saveList(state);
                    await broadcastListUpdate(currentListId);
                }
            }
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/remove") {
            const body = await readJsonBody(req);
            const state = await loadList(currentListId);
            state.items = state.items.filter((it) => it.id !== body.id);
            await saveList(state);
            await broadcastListUpdate(currentListId);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/search-prs") {
            const q = url.searchParams.get("q") || "";
            const prs = await searchAccessiblePrs(q);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ prs }));
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/status-report") {
            const dayId = url.searchParams.get("dayId");
            const state = await loadList(currentListId);
            const dayObj =
                (dayId && state.days.find((d) => d.id === dayId)) || state.days[0];
            if (dayObj) {
                const changed = await refreshDayPrStatuses(state, dayObj.id);
                if (changed) {
                    await broadcastListUpdate(currentListId);
                }
            }
            const report = formatSlackStatusReport(dayObj, state.items);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ...report, state }));
            return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderHtml());
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    entry = {
        server,
        url: `http://127.0.0.1:${port}/`,
        listId: resolvedListId,
        clients,
    };
    servers.set(instanceId, entry);
    return entry;
}

export async function closeServer(instanceId) {
    instanceLists.delete(instanceId);
    const entry = servers.get(instanceId);
    if (entry) {
        servers.delete(instanceId);
        for (const client of entry.clients) {
            client.end();
        }
        entry.clients.clear();
        await new Promise((resolve) => entry.server.close(() => resolve()));
    }
}
