// Extension: todo-list
// Simple todo list canvas with checkboxes and strikethrough.

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import {
    loadList,
    saveList,
    undoList,
    redoList,
    normalizeItem,
    repositionItemInDay,
    autoMatchSessionPrs,
    resolvePrMetadata,
    refreshDayPrStatuses,
    createDayEntry,
    formatSlackStatusReport,
    backupListToWorkdocs,
} from "./store.mjs";
import {
    ensureServer,
    closeServer,
    getListIdForInstance,
    broadcastListUpdate,
} from "./renderer.mjs";

const prInputSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
        ref: {
            type: "string",
            description: "PR URL, owner/repo#number, or #number.",
        },
        url: {
            type: "string",
            description: "Full PR URL.",
        },
        label: {
            type: "string",
            description: "Display reference label, e.g. owner/repo#123.",
        },
        isDraft: {
            type: "boolean",
            description: "Whether the PR is a draft.",
        },
    },
};

await joinSession({
    canvases: [
        createCanvas({
            id: "todoodle",
            displayName: "Todoodle",
            description:
                "Todoodle daily feed todo list canvas with manual New Day blocks, random emojis, checkboxes, in-progress/blocked/upcoming states, PR attachments, and Slack status reports.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    listId: {
                        type: "string",
                        minLength: 1,
                        pattern: "^[A-Za-z0-9._-]+$",
                        description: "Optional durable list identifier (defaults to 'default').",
                    },
                    title: {
                        type: "string",
                        minLength: 1,
                        description: "Optional display title for the todo list.",
                    },
                    items: {
                        type: "array",
                        description: "Optional initial todo items to set when opening the canvas.",
                        items: {
                            type: "object",
                            additionalProperties: false,
                            required: ["text"],
                            properties: {
                                id: { type: "string", minLength: 1 },
                                text: { type: "string", minLength: 1 },
                                completed: { type: "boolean" },
                                inProgress: { type: "boolean" },
                                dayId: { type: "string", minLength: 1 },
                                pr: {
                                    anyOf: [prInputSchema, { type: "null" }],
                                },
                            },
                        },
                    },
                },
            },
            actions: [
                {
                    name: "get_items",
                    description: "Return the current todo list title, days, and items.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            dayId: {
                                type: "string",
                                minLength: 1,
                                description: "Optional day block ID filter.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        if (ctx.input?.dayId) {
                            return {
                                ...state,
                                items: state.items.filter((it) => it.dayId === ctx.input.dayId),
                            };
                        }
                        return state;
                    },
                },
                {
                    name: "new_day",
                    description: "Create a new day block at the top of the feed with a date header and fun random emoji.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            dateLabel: {
                                type: "string",
                                minLength: 1,
                                description: "Optional custom date label (defaults to today's formatted date).",
                            },
                            emoji: {
                                type: "string",
                                minLength: 1,
                                description: "Optional emoji (defaults to a fun random emoji).",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const newDay = createDayEntry(
                            {
                                dateLabel: ctx.input?.dateLabel,
                                emoji: ctx.input?.emoji,
                            },
                            state.days[0]?.emoji,
                        );
                        state.days.unshift(newDay);
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { day: newDay, days: state.days };
                    },
                },
                {
                    name: "delete_day",
                    description: "Delete a day block and its items by dayId.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["dayId"],
                        properties: {
                            dayId: {
                                type: "string",
                                minLength: 1,
                                description: "The ID of the day block to delete.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const before = state.days.length;
                        state.days = state.days.filter((d) => d.id !== ctx.input.dayId);
                        if (state.days.length === before) {
                            throw new CanvasError("day_not_found", "Day block not found.");
                        }
                        state.items = state.items.filter((it) => it.dayId !== ctx.input.dayId);
                        if (state.days.length === 0) {
                            state.days.push(createDayEntry());
                        }
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { days: state.days, items: state.items };
                    },
                },
                {
                    name: "undo",
                    description: "Undo the most recent change to the todo list.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {},
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        await undoList(listId);
                        return await broadcastListUpdate(listId);
                    },
                },
                {
                    name: "redo",
                    description: "Redo the most recently undone change to the todo list.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {},
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        await redoList(listId);
                        return await broadcastListUpdate(listId);
                    },
                },
                {
                    name: "backup_to_workdocs",
                    description:
                        "Save a Markdown representation of the todo feed to todoodle.md on main in the configured backup repository.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {},
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        return await backupListToWorkdocs(listId);
                    },
                },
                {
                    name: "add_item",
                    description: "Add a new todo item to a day block (defaults to the latest day block at the top of the feed).",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["text"],
                        properties: {
                            text: {
                                type: "string",
                                minLength: 1,
                                description: "The todo item text.",
                            },
                            dayId: {
                                type: "string",
                                minLength: 1,
                                description: "Optional day block ID (defaults to the top/latest day block).",
                            },
                            completed: {
                                type: "boolean",
                                description: "Whether the item starts checked (defaults to false).",
                            },
                            inProgress: {
                                type: "boolean",
                                description: "Whether the item is in progress (defaults to false).",
                            },
                            pr: prInputSchema,
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const targetDayId =
                            ctx.input.dayId && state.days.some((d) => d.id === ctx.input.dayId)
                                ? ctx.input.dayId
                                : state.days[0].id;
                        const item = normalizeItem(
                            {
                                text: ctx.input.text,
                                dayId: targetDayId,
                                completed: Boolean(ctx.input.completed),
                                inProgress: Boolean(ctx.input.inProgress),
                                pr: ctx.input.pr,
                            },
                            targetDayId,
                        );
                        state.items.push(item);
                        repositionItemInDay(
                            state,
                            item.id,
                            item.completed ? "done" : "normal",
                        );
                        await autoMatchSessionPrs(state, {
                            targetItemId: item.id,
                            recordHistory: false,
                        });
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { item, items: state.items };
                    },
                },
                {
                    name: "toggle_item",
                    description: "Toggle or explicitly set the checked state of a todo item by id or text.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: {
                                type: "string",
                                minLength: 1,
                                description: "The ID of the todo item to toggle.",
                            },
                            text: {
                                type: "string",
                                minLength: 1,
                                description: "Exact text of the todo item to toggle if id is omitted.",
                            },
                            completed: {
                                type: "boolean",
                                description: "Optional explicit completed state; if omitted, flips the current state.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const item = state.items.find(
                            (it) =>
                                (ctx.input?.id && it.id === ctx.input.id) ||
                                (!ctx.input?.id && ctx.input?.text && it.text === ctx.input.text),
                        );
                        if (!item) {
                            throw new CanvasError("item_not_found", "Todo item not found.");
                        }
                        item.completed =
                            typeof ctx.input?.completed === "boolean"
                                ? ctx.input.completed
                                : !item.completed;
                        if (item.completed) {
                            item.blocked = false;
                            item.inProgress = false;
                            item.upcoming = false;
                            repositionItemInDay(state, item.id, "done");
                        } else {
                            repositionItemInDay(state, item.id, "normal");
                        }
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { item, items: state.items };
                    },
                },
                {
                    name: "toggle_in_progress",
                    description: "Toggle or set the in-progress status of a todo item by id or text.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: {
                                type: "string",
                                minLength: 1,
                                description: "The ID of the todo item.",
                            },
                            text: {
                                type: "string",
                                minLength: 1,
                                description: "Exact text of the todo item if id is omitted.",
                            },
                            inProgress: {
                                type: "boolean",
                                description: "Optional explicit inProgress state; if omitted, flips the current state.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const item = state.items.find(
                            (it) =>
                                (ctx.input?.id && it.id === ctx.input.id) ||
                                (!ctx.input?.id && ctx.input?.text && it.text === ctx.input.text),
                        );
                        if (!item) {
                            throw new CanvasError("item_not_found", "Todo item not found.");
                        }
                        const wasSpecial = item.completed || item.blocked || item.upcoming;
                        item.inProgress =
                            typeof ctx.input?.inProgress === "boolean"
                                ? ctx.input.inProgress
                                : !item.inProgress;
                        if (item.inProgress) {
                            item.completed = false;
                            item.blocked = false;
                            item.upcoming = false;
                            if (wasSpecial) {
                                repositionItemInDay(state, item.id, "normal");
                            }
                        }
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { item, items: state.items };
                    },
                },
                {
                    name: "toggle_upcoming",
                    description: "Toggle or set the upcoming status of a todo item by id or text.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: {
                                type: "string",
                                minLength: 1,
                                description: "The ID of the todo item.",
                            },
                            text: {
                                type: "string",
                                minLength: 1,
                                description: "Exact text of the todo item if id is omitted.",
                            },
                            upcoming: {
                                type: "boolean",
                                description: "Optional explicit upcoming state; if omitted, flips the current state.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const item = state.items.find(
                            (it) =>
                                (ctx.input?.id && it.id === ctx.input.id) ||
                                (!ctx.input?.id && ctx.input?.text && it.text === ctx.input.text),
                        );
                        if (!item) {
                            throw new CanvasError("item_not_found", "Todo item not found.");
                        }
                        item.upcoming =
                            typeof ctx.input?.upcoming === "boolean"
                                ? ctx.input.upcoming
                                : !item.upcoming;
                        if (item.upcoming) {
                            item.completed = false;
                            item.blocked = false;
                            item.inProgress = false;
                            repositionItemInDay(state, item.id, "upcoming");
                        } else {
                            repositionItemInDay(state, item.id, "normal");
                        }
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { item, items: state.items };
                    },
                },
                {
                    name: "toggle_blocked",
                    description: "Toggle or set the blocked status of a todo item by id or text.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: {
                                type: "string",
                                minLength: 1,
                                description: "The ID of the todo item.",
                            },
                            text: {
                                type: "string",
                                minLength: 1,
                                description: "Exact text of the todo item if id is omitted.",
                            },
                            blocked: {
                                type: "boolean",
                                description: "Optional explicit blocked state; if omitted, flips the current state.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const item = state.items.find(
                            (it) =>
                                (ctx.input?.id && it.id === ctx.input.id) ||
                                (!ctx.input?.id && ctx.input?.text && it.text === ctx.input.text),
                        );
                        if (!item) {
                            throw new CanvasError("item_not_found", "Todo item not found.");
                        }
                        item.blocked =
                            typeof ctx.input?.blocked === "boolean"
                                ? ctx.input.blocked
                                : !item.blocked;
                        if (item.blocked) {
                            item.completed = false;
                            item.inProgress = false;
                            item.upcoming = false;
                            repositionItemInDay(state, item.id, "blocked");
                        } else {
                            repositionItemInDay(state, item.id, "normal");
                        }
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { item, items: state.items };
                    },
                },
                {
                    name: "attach_pr",
                    description:
                        "Attach, append, or clear pull request references on a todo item (supports multiple PRs per item).",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: {
                                type: "string",
                                minLength: 1,
                                description: "The ID of the todo item.",
                            },
                            text: {
                                type: "string",
                                minLength: 1,
                                description: "Exact text of the todo item if id is omitted.",
                            },
                            pr: {
                                anyOf: [prInputSchema, { type: "null" }],
                                description: "PR details ({ ref, url, label, isDraft }) or null to clear.",
                            },
                            prs: {
                                type: "array",
                                items: prInputSchema,
                                description: "Optional list of PRs to attach.",
                            },
                            replace: {
                                type: "boolean",
                                description: "If true, replaces existing PRs on the item instead of appending.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const item = state.items.find(
                            (it) =>
                                (ctx.input?.id && it.id === ctx.input.id) ||
                                (!ctx.input?.id && ctx.input?.text && it.text === ctx.input.text),
                        );
                        if (!item) {
                            throw new CanvasError("item_not_found", "Todo item not found.");
                        }
                        if (ctx.input?.pr === null && !ctx.input?.prs) {
                            item.prs = [];
                            item.pr = null;
                        } else {
                            const inputs = [];
                            if (Array.isArray(ctx.input?.prs)) {
                                inputs.push(...ctx.input.prs);
                            }
                            if (ctx.input?.pr) {
                                inputs.push(ctx.input.pr);
                            }
                            const resolved = (
                                await Promise.all(inputs.map((p) => resolvePrMetadata(p)))
                            ).filter(Boolean);
                            const base = ctx.input?.replace
                                ? []
                                : Array.isArray(item.prs)
                                  ? [...item.prs]
                                  : item.pr
                                    ? [item.pr]
                                    : [];
                            const seen = new Set(base.map((p) => p.url || p.label));
                            for (const p of resolved) {
                                const key = p.url || p.label;
                                if (!seen.has(key)) {
                                    seen.add(key);
                                    base.push(p);
                                }
                            }
                            item.prs = base;
                            item.pr = base[0] || null;
                        }
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { item, items: state.items };
                    },
                },
                {
                    name: "get_status_report",
                    description: "Generate a succinct Slack status report for a day block (defaults to the top/latest day block).",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            dayId: {
                                type: "string",
                                minLength: 1,
                                description: "Optional day block ID (defaults to the top/latest day block).",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const dayObj =
                            (ctx.input?.dayId &&
                                state.days.find((d) => d.id === ctx.input.dayId)) ||
                            state.days[0];
                        if (dayObj) {
                            const changed = await refreshDayPrStatuses(state, dayObj.id);
                            if (changed) {
                                await broadcastListUpdate(listId);
                            }
                        }
                        return formatSlackStatusReport(dayObj, state.items);
                    },
                },
                {
                    name: "edit_item",
                    description:
                        "Edit the text, dayId, inProgress, completed, or PR of a todo item by id or currentText.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: {
                                type: "string",
                                minLength: 1,
                                description: "The ID of the todo item to edit.",
                            },
                            currentText: {
                                type: "string",
                                minLength: 1,
                                description: "Exact current text of the todo item to edit if id is omitted.",
                            },
                            text: {
                                type: "string",
                                minLength: 1,
                                description: "New text for the todo item.",
                            },
                            dayId: {
                                type: "string",
                                minLength: 1,
                                description: "Optional updated day block ID.",
                            },
                            completed: {
                                type: "boolean",
                                description: "Optional updated completed state.",
                            },
                            inProgress: {
                                type: "boolean",
                                description: "Optional updated in-progress state.",
                            },
                            pr: {
                                anyOf: [prInputSchema, { type: "null" }],
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const item = state.items.find(
                            (it) =>
                                (ctx.input?.id && it.id === ctx.input.id) ||
                                (!ctx.input?.id &&
                                    ctx.input?.currentText &&
                                    it.text === ctx.input.currentText),
                        );
                        if (!item) {
                            throw new CanvasError("item_not_found", "Todo item not found.");
                        }
                        if (typeof ctx.input?.text === "string" && ctx.input.text.trim()) {
                            item.text = ctx.input.text.trim();
                            await autoMatchSessionPrs(state, {
                                targetItemId: item.id,
                                recordHistory: false,
                            });
                        }
                        if (typeof ctx.input?.dayId === "string") {
                            item.dayId = ctx.input.dayId;
                        }
                        if (typeof ctx.input?.completed === "boolean") {
                            item.completed = ctx.input.completed;
                            if (item.completed) {
                                item.inProgress = false;
                                item.upcoming = false;
                            }
                        }
                        if (typeof ctx.input?.inProgress === "boolean") {
                            item.inProgress = ctx.input.inProgress;
                            if (item.inProgress) {
                                item.completed = false;
                                item.upcoming = false;
                            }
                        }
                        if (typeof ctx.input?.upcoming === "boolean") {
                            item.upcoming = ctx.input.upcoming;
                            if (item.upcoming) {
                                item.completed = false;
                                item.inProgress = false;
                            }
                        }
                        if (ctx.input && "pr" in ctx.input) {
                            const parsedPr = ctx.input.pr
                                ? await resolvePrMetadata(ctx.input.pr)
                                : null;
                            item.pr = parsedPr;
                            item.prs = parsedPr ? [parsedPr] : [];
                        }
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { item, items: state.items };
                    },
                },
                {
                    name: "remove_item",
                    description: "Remove a todo item by id or text.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            id: {
                                type: "string",
                                minLength: 1,
                                description: "The ID of the todo item to remove.",
                            },
                            text: {
                                type: "string",
                                minLength: 1,
                                description: "Exact text of the todo item to remove if id is omitted.",
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const idx = state.items.findIndex(
                            (it) =>
                                (ctx.input?.id && it.id === ctx.input.id) ||
                                (!ctx.input?.id && ctx.input?.text && it.text === ctx.input.text),
                        );
                        if (idx === -1) {
                            throw new CanvasError("item_not_found", "Todo item not found.");
                        }
                        const [removed] = state.items.splice(idx, 1);
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { removed, items: state.items };
                    },
                },
                {
                    name: "clear_completed",
                    description: "Remove all checked/completed items from the todo list.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {},
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const before = state.items.length;
                        state.items = state.items.filter((it) => !it.completed);
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { removedCount: before - state.items.length, items: state.items };
                    },
                },
                {
                    name: "set_items",
                    description: "Replace the todo list items (and optionally title).",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["items"],
                        properties: {
                            title: {
                                type: "string",
                                minLength: 1,
                                description: "Optional new title for the list.",
                            },
                            items: {
                                type: "array",
                                items: {
                                    type: "object",
                                    additionalProperties: false,
                                    required: ["text"],
                                    properties: {
                                        id: { type: "string", minLength: 1 },
                                        text: { type: "string", minLength: 1 },
                                        completed: { type: "boolean" },
                                        inProgress: { type: "boolean" },
                                        dayId: { type: "string", minLength: 1 },
                                        pr: {
                                            anyOf: [prInputSchema, { type: "null" }],
                                        },
                                    },
                                },
                            },
                        },
                    },
                    handler: async (ctx) => {
                        const listId = getListIdForInstance(ctx.instanceId);
                        const state = await loadList(listId);
                        const defaultDayId = state.days[0]?.id;
                        if (ctx.input.title) {
                            state.title = ctx.input.title;
                        }
                        state.items = ctx.input.items.map((it) =>
                            normalizeItem(it, defaultDayId),
                        );
                        await saveList(state);
                        await broadcastListUpdate(listId);
                        return { title: state.title, days: state.days, items: state.items };
                    },
                },
            ],
            open: async (ctx) => {
                const listId = ctx.input?.listId || "default";
                const state = await loadList(listId);
                const defaultDayId = state.days[0]?.id;
                let changed = false;
                if (ctx.input?.title && ctx.input.title !== state.title) {
                    state.title = ctx.input.title;
                    changed = true;
                }
                if (Array.isArray(ctx.input?.items)) {
                    state.items = ctx.input.items.map((it) =>
                        normalizeItem(it, defaultDayId),
                    );
                    changed = true;
                }
                if (changed) {
                    await saveList(state);
                }
                const entry = await ensureServer(ctx.instanceId, state.listId);
                if (changed) {
                    await broadcastListUpdate(state.listId);
                }
                return {
                    title: state.title,
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                await closeServer(ctx.instanceId);
            },
        }),
    ],
});
