import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);

const copilotHome = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const artifactsDir = join(import.meta.dirname, "artifacts");

const FUN_EMOJIS = [
    "🥞", "🚀", "✨", "🌈", "🔥", "⚡", "🎯", "🌵", "🐙", "🦊",
    "🍜", "🎨", "🛸", "🌊", "🍀", "🐝", "🦖", "🥨", "🪩", "🧭",
    "🐳", "🍄", "🦩", "🥑", "🎸", "🪁", "🦦", "🍋", "🏔️", "🌻",
];

export function pickRandomEmoji(excludeEmoji) {
    const pool = excludeEmoji
        ? FUN_EMOJIS.filter((e) => e !== excludeEmoji)
        : FUN_EMOJIS;
    return pool[Math.floor(Math.random() * pool.length)] || "✨";
}

export function formatDateLabel(date = new Date()) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

export function createDayEntry({ id, dateLabel, emoji, createdAt } = {}, previousEmoji) {
    const now = new Date();
    return {
        id: typeof id === "string" && id ? id : `day-${randomUUID()}`,
        dateLabel:
            typeof dateLabel === "string" && dateLabel.trim()
                ? dateLabel.trim()
                : formatDateLabel(now),
        emoji:
            typeof emoji === "string" && emoji.trim()
                ? emoji.trim()
                : pickRandomEmoji(previousEmoji),
        createdAt: typeof createdAt === "string" && createdAt ? createdAt : now.toISOString(),
    };
}

export function normalizePr(raw) {
    if (!raw) return null;
    const isDraft = Boolean(typeof raw === "object" ? raw.isDraft || raw.draft : false);
    const input =
        typeof raw === "string"
            ? raw.trim()
            : String(raw.ref || raw.url || raw.label || "").trim();
    if (!input) return null;

    let url = typeof raw === "object" && typeof raw.url === "string" ? raw.url.trim() : "";
    let label = typeof raw === "object" && typeof raw.label === "string" ? raw.label.trim() : "";

    // Match full GitHub PR URL: https://github.com/owner/repo/pull/123
    const urlMatch = input.match(/^https?:\/\/([^/]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
    if (urlMatch) {
        const [, host, owner, repo, num] = urlMatch;
        url = `https://${host}/${owner}/${repo}/pull/${num}`;
        if (!label || label === input) {
            label = `${owner}/${repo}#${num}`;
        }
        return { url, label, isDraft };
    }

    // Match owner/repo#123
    const repoMatch = input.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/);
    if (repoMatch) {
        const [, repoFull, num] = repoMatch;
        if (!url) {
            url = `https://github.com/${repoFull}/pull/${num}`;
        }
        if (!label) {
            label = `${repoFull}#${num}`;
        }
        return { url, label, isDraft };
    }

    // Match #123 or plain number 123
    const numMatch = input.match(/^#?(\d+)$/);
    if (numMatch) {
        const [, num] = numMatch;
        if (!label) {
            label = `#${num}`;
        }
        return { url, label, isDraft };
    }

    if (!label) {
        label = input;
    }
    if (!url && /^https?:\/\//i.test(input)) {
        url = input;
    }
    return { url, label, isDraft };
}

export function extractRepoAndPrNumber(pr) {
    if (!pr) return null;
    for (const candidate of [pr.url, pr.label]) {
        if (!candidate) continue;
        const urlMatch = String(candidate).match(
            /^https?:\/\/[^/]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i,
        );
        if (urlMatch) {
            return { owner: urlMatch[1], repo: urlMatch[2], number: urlMatch[3] };
        }
        const repoMatch = String(candidate).match(
            /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/,
        );
        if (repoMatch) {
            return { owner: repoMatch[1], repo: repoMatch[2], number: repoMatch[3] };
        }
    }
    return null;
}

export async function resolvePrMetadata(raw) {
    const pr = normalizePr(raw);
    if (!pr) return null;
    const parsed = extractRepoAndPrNumber(pr);
    if (!parsed) return pr;
    try {
        const env = {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
        };
        const { stdout } = await execFileAsync(
            "gh",
            ["api", `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`],
            { env, timeout: 5000 },
        );
        const data = JSON.parse(stdout);
        return {
            url: data.html_url || pr.url,
            label: `${parsed.owner}/${parsed.repo}#${parsed.number}`,
            isDraft: Boolean(data.draft),
        };
    } catch {
        return pr;
    }
}

let cachedMyPrs = null;
let cachedMyPrsAt = 0;

export async function searchAccessiblePrs(query = "") {
    const q = String(query || "").trim();
    const env = {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
    };

    // If query is an exact PR URL or owner/repo#123, resolve it directly first
    const direct = extractRepoAndPrNumber({ url: q, label: q });
    if (direct) {
        try {
            const { stdout } = await execFileAsync(
                "gh",
                ["api", `repos/${direct.owner}/${direct.repo}/pulls/${direct.number}`],
                { env, timeout: 6000 },
            );
            const data = JSON.parse(stdout);
            return [
                {
                    url: data.html_url,
                    label: `${direct.owner}/${direct.repo}#${direct.number}`,
                    number: Number(direct.number),
                    repo: `${direct.owner}/${direct.repo}`,
                    title: data.title || "",
                    isDraft: Boolean(data.draft),
                    state: data.merged ? "merged" : data.state || "open",
                },
            ];
        } catch {}
    }

    if (!q && cachedMyPrs && Date.now() - cachedMyPrsAt < 30_000) {
        return cachedMyPrs;
    }

    try {
        const args = [
            "search",
            "prs",
            ...(q ? [q, "--involves=@me"] : ["--author=@me"]),
            "--limit=25",
            "--sort=updated",
            "--json",
            "number,title,url,isDraft,state,repository",
        ];
        const { stdout } = await execFileAsync("gh", args, { env, timeout: 8000 });
        const raw = JSON.parse(stdout);
        const results = (Array.isArray(raw) ? raw : []).map((pr) => {
            const repo = pr.repository?.nameWithOwner || "";
            return {
                url: pr.url,
                label: repo ? `${repo}#${pr.number}` : `#${pr.number}`,
                number: pr.number,
                repo,
                title: pr.title || "",
                isDraft: Boolean(pr.isDraft),
                state: String(pr.state || "open").toLowerCase(),
            };
        });
        if (!q) {
            cachedMyPrs = results;
            cachedMyPrsAt = Date.now();
        }
        return results;
    } catch {
        return cachedMyPrs || [];
    }
}

export async function refreshDayPrStatuses(state, dayId) {
    const dayItems = (state.items || []).filter((it) => it.dayId === dayId);
    let changed = false;
    await Promise.all(
        dayItems.map(async (item) => {
            const prs = Array.isArray(item.prs) && item.prs.length
                ? item.prs
                : item.pr
                  ? [item.pr]
                  : [];
            if (!prs.length) return;
            const updatedPrs = await Promise.all(prs.map((p) => resolvePrMetadata(p)));
            const validPrs = updatedPrs.filter(Boolean);
            if (JSON.stringify(validPrs) !== JSON.stringify(item.prs)) {
                item.prs = validPrs;
                item.pr = validPrs[0] || null;
                changed = true;
            }
        }),
    );
    if (changed) {
        await saveList(state);
    }
    return changed;
}

export function normalizePrList(item) {
    const rawList = [];
    if (Array.isArray(item.prs)) {
        rawList.push(...item.prs);
    } else if (item.pr) {
        rawList.push(item.pr);
    }
    const seen = new Set();
    const prs = [];
    for (const entry of rawList) {
        const norm = normalizePr(entry);
        if (norm) {
            const key = norm.url || norm.label;
            if (!seen.has(key)) {
                seen.add(key);
                prs.push(norm);
            }
        }
    }
    return prs;
}

function sanitizeListId(listId = "default") {
    const cleaned = String(listId).replace(/[^A-Za-z0-9._-]/g, "_");
    return cleaned || "default";
}

function getFilePath(listId) {
    return join(artifactsDir, `${sanitizeListId(listId)}.json`);
}

function getHistoryFilePath(listId) {
    return join(artifactsDir, `${sanitizeListId(listId)}.history.json`);
}

function getSettingsFilePath() {
    return join(artifactsDir, "settings.json");
}

export function parseBackupDestination(input) {
    const raw = String(input || "").trim().replace(/\/+$/, "");
    if (!raw) return null;

    let owner = "";
    let repo = "";
    let subpath = "";

    const urlMatch = raw.match(
        /^https?:\/\/[^/]+\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(?:(?:tree|blob)\/[^/]+(?:\/(.+))?|(.+)))?$/i,
    );
    if (urlMatch) {
        owner = urlMatch[1];
        repo = urlMatch[2];
        subpath = (urlMatch[3] || urlMatch[4] || "").replace(/^\/+|\/+$/g, "");
    } else {
        const slugMatch = raw.match(
            /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+))?$/,
        );
        if (!slugMatch) return null;
        owner = slugMatch[1];
        repo = slugMatch[2];
        subpath = (slugMatch[3] || "").replace(/^\/+|\/+$/g, "");
        subpath = subpath.replace(/^(?:tree|blob)\/[^/]+\/?/, "");
    }

    const repoSlug = `${owner}/${repo}`;
    const filePath = subpath
        ? subpath.endsWith(".md")
            ? subpath
            : `${subpath}/todoodle.md`
        : "todoodle.md";
    const display = subpath ? `${repoSlug}/${subpath}` : repoSlug;
    return {
        raw,
        repo: repoSlug,
        subpath,
        filePath,
        display,
    };
}

export async function loadSettings() {
    try {
        const raw = await readFile(getSettingsFilePath(), "utf8");
        const parsed = JSON.parse(raw);
        const dest = parseBackupDestination(parsed?.backupRepo);
        return {
            backupRepo: dest ? dest.display : "",
            showDayEmojis:
                typeof parsed?.showDayEmojis === "boolean"
                    ? parsed.showDayEmojis
                    : true,
        };
    } catch {
        return { backupRepo: "", showDayEmojis: true };
    }
}

export async function saveSettings(nextSettings) {
    const current = await loadSettings();
    await mkdir(artifactsDir, { recursive: true });
    const hasBackupRepo = nextSettings && "backupRepo" in nextSettings;
    const dest = hasBackupRepo
        ? parseBackupDestination(nextSettings.backupRepo)
        : parseBackupDestination(current.backupRepo);
    const showDayEmojis =
        nextSettings && typeof nextSettings.showDayEmojis === "boolean"
            ? nextSettings.showDayEmojis
            : current.showDayEmojis;
    const payload = {
        backupRepo: dest ? dest.display : "",
        showDayEmojis,
    };
    await writeFile(getSettingsFilePath(), JSON.stringify(payload, null, 2), "utf8");
    return payload;
}

const MAX_HISTORY = 50;

async function loadHistory(listId = "default") {
    try {
        const raw = await readFile(getHistoryFilePath(listId), "utf8");
        const parsed = JSON.parse(raw);
        return {
            undoStack: Array.isArray(parsed.undoStack) ? parsed.undoStack : [],
            redoStack: Array.isArray(parsed.redoStack) ? parsed.redoStack : [],
        };
    } catch {
        return { undoStack: [], redoStack: [] };
    }
}

async function saveHistory(listId, history) {
    await mkdir(artifactsDir, { recursive: true });
    const payload = {
        undoStack: (history.undoStack || []).slice(-MAX_HISTORY),
        redoStack: (history.redoStack || []).slice(-MAX_HISTORY),
    };
    await writeFile(getHistoryFilePath(listId), JSON.stringify(payload, null, 2), "utf8");
    return payload;
}

function snapshotOf(state) {
    return {
        title: state.title || "Todoodle",
        days: state.days || [],
        items: state.items || [],
    };
}

function normalizeDaysAndItems(parsed) {
    let days = [];
    if (Array.isArray(parsed?.days)) {
        for (const d of parsed.days) {
            if (d && typeof d === "object" && typeof d.id === "string") {
                days.push(
                    createDayEntry(
                        d,
                        days.length > 0 ? days[days.length - 1].emoji : undefined,
                    ),
                );
            }
        }
    }
    if (days.length === 0) {
        days.push(createDayEntry());
    }
    const defaultDayId = days[0].id;
    const validDayIds = new Set(days.map((d) => d.id));
    const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
    const items = rawItems.map((it) => {
        const dayId =
            typeof it.dayId === "string" && validDayIds.has(it.dayId)
                ? it.dayId
                : defaultDayId;
        return normalizeItem({ ...it, dayId }, defaultDayId);
    });
    return { days, items };
}

export async function loadList(listId = "default") {
    const id = sanitizeListId(listId);
    const filePath = getFilePath(id);
    const [history, settings] = await Promise.all([
        loadHistory(id),
        loadSettings(),
    ]);
    try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const { days, items } = normalizeDaysAndItems(parsed);
        const state = {
            listId: id,
            title:
                typeof parsed.title === "string" &&
                parsed.title &&
                parsed.title !== "Todo List" &&
                parsed.title !== "Todo"
                    ? parsed.title
                    : "Todoodle",
            days,
            items,
            canUndo: history.undoStack.length > 0,
            canRedo: history.redoStack.length > 0,
            backupRepo: settings.backupRepo || "",
            showDayEmojis: settings.showDayEmojis !== false,
        };
        if (!Array.isArray(parsed.days) || !parsed.days[0]?.id) {
            await saveList(state, { recordHistory: false });
        }
        return state;
    } catch {
        const initialDay = createDayEntry();
        return {
            listId: id,
            title: "Todoodle",
            days: [initialDay],
            items: [],
            canUndo: history.undoStack.length > 0,
            canRedo: history.redoStack.length > 0,
            backupRepo: settings.backupRepo || "",
            showDayEmojis: settings.showDayEmojis !== false,
        };
    }
}

export async function saveList(state, { recordHistory = true } = {}) {
    const id = sanitizeListId(state.listId);
    await mkdir(artifactsDir, { recursive: true });
    const { days, items } = normalizeDaysAndItems(state);
    const payload = {
        listId: id,
        title:
            state.title && state.title !== "Todo" && state.title !== "Todo List"
                ? state.title
                : "Todoodle",
        days,
        items,
    };

    if (recordHistory) {
        try {
            const existingRaw = await readFile(getFilePath(id), "utf8");
            const existingParsed = JSON.parse(existingRaw);
            const prevNorm = normalizeDaysAndItems(existingParsed);
            const prevSnap = snapshotOf({
                title:
                    existingParsed.title &&
                    existingParsed.title !== "Todo" &&
                    existingParsed.title !== "Todo List"
                        ? existingParsed.title
                        : "Todoodle",
                ...prevNorm,
            });
            const nextSnap = snapshotOf(payload);
            if (JSON.stringify(prevSnap) !== JSON.stringify(nextSnap)) {
                const history = await loadHistory(id);
                history.undoStack.push(prevSnap);
                history.redoStack = [];
                await saveHistory(id, history);
            }
        } catch {}
    }

    await writeFile(getFilePath(id), JSON.stringify(payload, null, 2), "utf8");
    const [history, settings] = await Promise.all([
        loadHistory(id),
        loadSettings(),
    ]);
    return {
        ...payload,
        canUndo: history.undoStack.length > 0,
        canRedo: history.redoStack.length > 0,
        backupRepo: settings.backupRepo || "",
        showDayEmojis: settings.showDayEmojis !== false,
    };
}

export async function undoList(listId = "default") {
    const id = sanitizeListId(listId);
    const history = await loadHistory(id);
    if (history.undoStack.length === 0) {
        return await loadList(id);
    }
    const current = await loadList(id);
    const prevSnap = history.undoStack.pop();
    history.redoStack.push(snapshotOf(current));
    await saveHistory(id, history);
    return await saveList({ listId: id, ...prevSnap }, { recordHistory: false });
}

export async function redoList(listId = "default") {
    const id = sanitizeListId(listId);
    const history = await loadHistory(id);
    if (history.redoStack.length === 0) {
        return await loadList(id);
    }
    const current = await loadList(id);
    const nextSnap = history.redoStack.pop();
    history.undoStack.push(snapshotOf(current));
    await saveHistory(id, history);
    return await saveList({ listId: id, ...nextSnap }, { recordHistory: false });
}

export function normalizeItem(item, fallbackDayId) {
    const completed = Boolean(item.completed);
    const blocked = completed ? false : Boolean(item.blocked);
    const inProgress = completed || blocked ? false : Boolean(item.inProgress);
    const upcoming =
        completed || blocked || inProgress ? false : Boolean(item.upcoming);
    const dayId =
        typeof item.dayId === "string" && item.dayId ? item.dayId : fallbackDayId;
    const prs = normalizePrList(item);
    const dismissedPrs = Array.isArray(item.dismissedPrs)
        ? Array.from(
              new Set(
                  item.dismissedPrs.filter((s) => typeof s === "string" && s.trim()),
              ),
          )
        : [];
    return {
        id: typeof item.id === "string" && item.id ? item.id : randomUUID(),
        text: String(item.text).trim(),
        completed,
        blocked,
        inProgress,
        upcoming,
        dayId,
        pr: prs[0] || null,
        prs,
        ...(dismissedPrs.length > 0 ? { dismissedPrs } : {}),
    };
}

/**
 * Reposition an item within its day block according to status transitions:
 * - "blocked": move to the top of the day's list
 * - "done": move to the bottom of the day's list, before items marked as upcoming
 * - "upcoming": move to the very bottom of the day's list
 * - "normal": move to the bottom of the normal list (after blocked/normal items, before done and upcoming)
 */
export function repositionItemInDay(state, itemId, mode) {
    const items = state.items;
    if (!Array.isArray(items)) return;
    const fromIdx = items.findIndex((it) => it.id === itemId);
    if (fromIdx === -1) return;
    const [item] = items.splice(fromIdx, 1);
    const fallbackDayId = state.days?.[0]?.id;
    const dayId = item.dayId || fallbackDayId;

    const dayIndices = [];
    for (let i = 0; i < items.length; i++) {
        if ((items[i].dayId || fallbackDayId) === dayId) {
            dayIndices.push(i);
        }
    }

    if (dayIndices.length === 0) {
        items.push(item);
        return;
    }

    if (mode === "blocked") {
        items.splice(dayIndices[0], 0, item);
        return;
    }

    if (mode === "upcoming") {
        const lastIdx = dayIndices[dayIndices.length - 1];
        items.splice(lastIdx + 1, 0, item);
        return;
    }

    if (mode === "done") {
        let lastNonUpcomingIdx = -1;
        for (const idx of dayIndices) {
            if (!items[idx].upcoming) {
                lastNonUpcomingIdx = idx;
            }
        }
        if (lastNonUpcomingIdx !== -1) {
            items.splice(lastNonUpcomingIdx + 1, 0, item);
        } else {
            items.splice(dayIndices[0], 0, item);
        }
        return;
    }

    if (mode === "normal") {
        let lastActiveIdx = -1;
        for (const idx of dayIndices) {
            const it = items[idx];
            if (!it.completed && !it.upcoming) {
                lastActiveIdx = idx;
            }
        }
        if (lastActiveIdx !== -1) {
            items.splice(lastActiveIdx + 1, 0, item);
        } else {
            items.splice(dayIndices[0], 0, item);
        }
        return;
    }

    items.push(item);
}

const MATCH_STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "get",
    "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "make", "my",
    "no", "not", "of", "on", "or", "our", "out", "own", "pr", "prs", "so", "some",
    "such", "that", "the", "their", "then", "there", "these", "they", "this", "to",
    "up", "use", "very", "was", "we", "what", "when", "where", "which", "who", "will",
    "with", "work", "working", "would", "you", "your", "add", "added", "fix", "fixed",
    "ship", "shipped", "update", "updated", "new", "ariroseonline", "github",
    "noodle", "noodles", "workstream", "workstreams", "v1", "v0", "support",
    "preparation", "discussed", "discuss", "planned", "final", "more", "team",
]);

const MATCH_SYNONYMS = {
    docs: "document",
    doc: "document",
    documents: "document",
    layers: "level",
    layer: "level",
    levels: "level",
    endpoints: "crud",
    endpoint: "crud",
};

function stemMatchWord(w) {
    if (MATCH_SYNONYMS[w]) return MATCH_SYNONYMS[w];
    if (w.length <= 3) return w;
    if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
    if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
    if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
    if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
    if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) return w.slice(0, -1);
    return MATCH_SYNONYMS[w] || w;
}

function tokenizeForMatch(text) {
    if (!text) return [];
    const expanded = String(text)
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase();
    const rawTokens = expanded.split(/[^a-z0-9]+/).filter(Boolean);
    const tokens = [];
    for (const t of rawTokens) {
        if (t.length < 2) continue;
        if (MATCH_STOP_WORDS.has(t)) continue;
        const stemmed = stemMatchWord(t);
        if (MATCH_STOP_WORDS.has(stemmed)) continue;
        tokens.push(stemmed);
    }
    return Array.from(new Set(tokens));
}

function loadSessionPrCandidates() {
    const dbPath = join(copilotHome, "data.db");
    let db;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
        const rows = db
            .prepare(`
            SELECT
                w.id,
                w.session_id,
                w.name,
                w.branch,
                w.created_at,
                w.updated_at,
                COALESCE(wrc.repo_full_name, w.created_pr_repo_full_name, w.source_pr_repo_full_name) AS repo_full_name,
                COALESCE(wrc.created_pr_number, w.created_pr_number) AS created_pr_number,
                COALESCE(wrc.created_pr_state, w.created_pr_state) AS created_pr_state,
                COALESCE(wrc.created_pr_html_url, w.created_pr_html_url) AS created_pr_html_url,
                COALESCE(wrc.source_pr_number, w.source_pr_number) AS source_pr_number,
                COALESCE(wrc.source_pr_title, w.source_pr_title) AS source_pr_title,
                COALESCE(wrc.source_pr_state, w.source_pr_state) AS source_pr_state,
                COALESCE(wrc.source_pr_html_url, w.source_pr_html_url) AS source_pr_html_url
            FROM workspaces w
            LEFT JOIN workspace_repo_contexts wrc ON wrc.workspace_id = w.id
            WHERE COALESCE(wrc.created_pr_number, w.created_pr_number, wrc.source_pr_number, w.source_pr_number) IS NOT NULL
            ORDER BY w.updated_at DESC
            LIMIT 100
        `)
            .all();

        const prTitleByLabel = new Map();
        if (Array.isArray(cachedMyPrs)) {
            for (const p of cachedMyPrs) {
                if (p.label && p.title) prTitleByLabel.set(p.label, p.title);
            }
        }

        const docFreq = new Map();
        const entries = [];

        for (const r of rows) {
            const repo = r.repo_full_name ? String(r.repo_full_name).trim() : "";
            const num = r.created_pr_number || r.source_pr_number;
            if (!repo || !num) continue;

            const isCreated = Boolean(r.created_pr_number);
            const rawState = String(
                (isCreated ? r.created_pr_state : r.source_pr_state) || "open",
            ).toLowerCase();
            if (rawState === "closed") continue;

            const label = `${repo}#${num}`;
            const url =
                (isCreated ? r.created_pr_html_url : r.source_pr_html_url) ||
                `https://github.com/${repo}/pull/${num}`;
            const isDraft = rawState === "draft";

            let planHeading = "";
            if (r.session_id) {
                try {
                    const planPath = join(
                        copilotHome,
                        "session-state",
                        String(r.session_id),
                        "plan.md",
                    );
                    const planRaw = readFileSync(planPath, "utf8").slice(0, 300);
                    const firstLine = planRaw.split("\n")[0] || "";
                    planHeading = firstLine.replace(/^#+\s*/, "");
                } catch {}
            }

            const repoHint = repo.endsWith("/github-ui") ? "ui" : "";
            const prTitle = prTitleByLabel.get(label) || r.source_pr_title || "";
            const nameTokens = new Set(
                tokenizeForMatch(`${r.name || ""} ${prTitle} ${repoHint}`),
            );
            const branchTokens = new Set(
                tokenizeForMatch(`${r.branch || ""} ${planHeading}`),
            );
            const allTokens = new Set([...nameTokens, ...branchTokens]);
            if (allTokens.size === 0) continue;

            for (const t of allTokens) {
                docFreq.set(t, (docFreq.get(t) || 0) + 1);
            }

            entries.push({
                raw: r,
                pr: { url, label, isDraft },
                prKey: label,
                num: Number(num),
                nameTokens,
                branchTokens,
                allTokens,
                updatedMs: new Date(r.updated_at || r.created_at || Date.now()).getTime(),
            });
        }

        return { entries, docFreq };
    } catch {
        return { entries: [], docFreq: new Map() };
    } finally {
        try {
            if (db) db.close();
        } catch {}
    }
}

export async function autoMatchSessionPrs(
    state,
    { targetItemId = null, recordHistory = false } = {},
) {
    if (!state || !Array.isArray(state.items) || state.items.length === 0) {
        return false;
    }
    const { entries, docFreq } = loadSessionPrCandidates();
    if (entries.length === 0) return false;

    const fallbackDayId = state.days?.[0]?.id;
    const dayById = new Map((state.days || []).map((d) => [d.id, d]));

    // Candidates for auto-matching: either a specific targetItemId (just added/edited)
    // or all items in the active/latest day block that have no PR attached yet
    const candidateItems = state.items.filter((it) => {
        if (it.upcoming) return false;
        const prs = Array.isArray(it.prs) && it.prs.length ? it.prs : it.pr ? [it.pr] : [];
        if (prs.length > 0) return false;
        if (targetItemId) return it.id === targetItemId;
        return (it.dayId || fallbackDayId) === fallbackDayId;
    });

    if (candidateItems.length === 0) return false;

    function tokenIdf(t) {
        const df = docFreq.get(t) || 1;
        return 1 + Math.log((entries.length + 1) / (df + 1)) * 0.45;
    }

    // Track PRs already attached to items in the same day block so we prefer unclaimed PRs
    const claimedPrsByDay = new Map();
    for (const it of state.items) {
        const dId = it.dayId || fallbackDayId;
        const prs = Array.isArray(it.prs) && it.prs.length ? it.prs : it.pr ? [it.pr] : [];
        if (!prs.length) continue;
        if (!claimedPrsByDay.has(dId)) claimedPrsByDay.set(dId, new Set());
        const set = claimedPrsByDay.get(dId);
        for (const p of prs) {
            if (p.label) set.add(p.label);
            if (p.url) set.add(p.url);
        }
    }

    const pairs = [];
    for (const item of candidateItems) {
        const dId = item.dayId || fallbackDayId;
        const dayObj = dayById.get(dId);
        const dayMs = dayObj?.createdAt
            ? new Date(dayObj.createdAt).getTime()
            : Date.now();
        const dismissed = new Set(item.dismissedPrs || []);
        const todoTokens = tokenizeForMatch(item.text);

        for (const entry of entries) {
            if (
                dismissed.has(entry.pr.label) ||
                (entry.pr.url && dismissed.has(entry.pr.url))
            ) {
                continue;
            }

            // Explicit #123 or /pull/123 reference in todo text
            if (
                item.text.includes(`#${entry.num}`) ||
                item.text.includes(`/pull/${entry.num}`)
            ) {
                pairs.push({ item, entry, score: 100, explicit: true });
                continue;
            }

            const diffHours = Math.abs(entry.updatedMs - dayMs) / (1000 * 3600);
            if (diffHours > 96) continue;

            if (todoTokens.length === 0) continue;

            let matchedWeight = 0;
            let totalTodoWeight = 0;
            let matchedCount = 0;
            let maxMatchedIdf = 0;

            for (const t of todoTokens) {
                const idf = tokenIdf(t);
                totalTodoWeight += idf;
                if (entry.nameTokens.has(t)) {
                    matchedWeight += idf * 1.2;
                    matchedCount++;
                    if (idf > maxMatchedIdf) maxMatchedIdf = idf;
                } else if (entry.branchTokens.has(t)) {
                    matchedWeight += idf * 1.05;
                    matchedCount++;
                    if (idf > maxMatchedIdf) maxMatchedIdf = idf;
                }
            }

            if (matchedCount === 0) continue;
            const isRareSingleMatch =
                matchedCount === 1 && maxMatchedIdf >= 2.0 && entry.allTokens.size <= 8;
            const isShortTodoSingleMatch =
                matchedCount === 1 &&
                todoTokens.length <= 2 &&
                entry.nameTokens.size <= 3;
            if (matchedCount < 2 && !isRareSingleMatch && !isShortTodoSingleMatch) {
                continue;
            }

            const coverageTodo = matchedWeight / Math.max(1, totalTodoWeight);
            const coverageSession =
                matchedCount /
                Math.max(1, entry.nameTokens.size || entry.branchTokens.size);
            let score =
                coverageTodo * 0.65 + coverageSession * 0.35 + matchedCount * 0.12;

            const alreadyClaimedInDay =
                claimedPrsByDay.get(dId)?.has(entry.pr.label) ||
                (entry.pr.url && claimedPrsByDay.get(dId)?.has(entry.pr.url));
            if (alreadyClaimedInDay) {
                score -= 0.35;
            }

            if (score >= 0.58) {
                pairs.push({ item, entry, score, explicit: false });
            }
        }
    }

    if (pairs.length === 0) return false;

    pairs.sort((a, b) => b.score - a.score);
    const assignedTodos = new Set();
    let changed = false;

    for (const p of pairs) {
        if (assignedTodos.has(p.item.id)) continue;
        const dId = p.item.dayId || fallbackDayId;
        if (!p.explicit && claimedPrsByDay.get(dId)?.has(p.entry.pr.label)) {
            continue;
        }
        assignedTodos.add(p.item.id);
        if (!claimedPrsByDay.has(dId)) claimedPrsByDay.set(dId, new Set());
        claimedPrsByDay.get(dId).add(p.entry.pr.label);
        if (p.entry.pr.url) claimedPrsByDay.get(dId).add(p.entry.pr.url);

        p.item.prs = [p.entry.pr];
        p.item.pr = p.entry.pr;
        changed = true;
    }

    if (changed) {
        await saveList(state, { recordHistory });
    }
    return changed;
}

export function formatSlackStatusReport(dayObj, items) {
    const dayItems = (Array.isArray(items) ? items : []).filter(
        (it) => it.dayId === dayObj.id,
    );
    const blocked = dayItems.filter((it) => !it.completed && it.blocked);
    const completed = dayItems.filter((it) => it.completed);
    const inProgress = dayItems.filter(
        (it) => !it.completed && !it.blocked && it.inProgress,
    );
    const notAddressed = dayItems.filter(
        (it) => !it.completed && !it.blocked && !it.inProgress && !it.upcoming,
    );
    const upcoming = dayItems.filter(
        (it) => !it.completed && !it.blocked && !it.inProgress && it.upcoming,
    );

    const formatPrSuffixMrkdwn = (it) => {
        const prs = Array.isArray(it.prs) && it.prs.length ? it.prs : it.pr ? [it.pr] : [];
        if (!prs.length) return "";
        const formatted = prs.map((p) => {
            const label = p.label || p.url;
            return `${label}${p.isDraft ? " (draft)" : ""}`;
        });
        return ` — ${formatted.join(", ")}`;
    };

    const lines = [];
    if (blocked.length > 0) {
        lines.push(`*Blocked*`);
        for (const it of blocked) {
            lines.push(`• ${it.text}${formatPrSuffixMrkdwn(it)}`);
        }
        lines.push("");
    }

    lines.push(`*Completed*`);
    if (completed.length === 0) {
        lines.push(`• _None_`);
    } else {
        for (const it of completed) {
            lines.push(`• ${it.text}${formatPrSuffixMrkdwn(it)}`);
        }
    }

    if (inProgress.length > 0) {
        lines.push("");
        lines.push(`*In progress*`);
        for (const it of inProgress) {
            lines.push(`• ${it.text}${formatPrSuffixMrkdwn(it)}`);
        }
    }

    if (notAddressed.length > 0) {
        lines.push("");
        lines.push(`*Not addressed today*`);
        for (const it of notAddressed) {
            lines.push(`• ${it.text}${formatPrSuffixMrkdwn(it)}`);
        }
    }

    if (upcoming.length > 0) {
        lines.push("");
        lines.push(`*Upcoming*`);
        for (const it of upcoming) {
            lines.push(`• ${it.text}${formatPrSuffixMrkdwn(it)}`);
        }
    }

    return {
        dayId: dayObj.id,
        dateLabel: dayObj.dateLabel,
        emoji: dayObj.emoji,
        text: lines.join("\n"),
        blockedCount: blocked.length,
        completedCount: completed.length,
        unfinishedCount:
            blocked.length + inProgress.length + notAddressed.length + upcoming.length,
        inProgressCount: inProgress.length,
        notAddressedCount: notAddressed.length,
        upcomingCount: upcoming.length,
    };
}

export function formatTodoFeedMarkdown(state) {
    const lines = [`# ${state.title || "Todoodle"}`, ""];
    const days = Array.isArray(state.days) ? state.days : [];
    const items = Array.isArray(state.items) ? state.items : [];
    const fallbackDayId = days[0]?.id;

    for (const day of days) {
        const headingPrefix =
            state.showDayEmojis === false ? "" : `${day.emoji || "✨"} `;
        lines.push(`## ${headingPrefix}${day.dateLabel}`);
        lines.push("");
        const dayItems = items.filter((it) => (it.dayId || fallbackDayId) === day.id);
        if (dayItems.length === 0) {
            lines.push("_No items._");
            lines.push("");
            continue;
        }
        for (const it of dayItems) {
            const box = it.completed ? "[x]" : "[ ]";
            let statusPrefix = "";
            let statusSuffix = "";
            if (!it.completed) {
                if (it.blocked) {
                    statusPrefix = "🚫 ";
                    statusSuffix = " _(blocked)_";
                } else if (it.inProgress) {
                    statusPrefix = "🔵 ";
                    statusSuffix = " _(in progress)_";
                } else if (it.upcoming) {
                    statusPrefix = "» ";
                    statusSuffix = " _(upcoming)_";
                }
            }
            const prs = Array.isArray(it.prs) && it.prs.length ? it.prs : it.pr ? [it.pr] : [];
            const prPart = prs.length
                ? " — " +
                  prs
                      .map((p) => {
                          const label = p.label || p.url;
                          const link = p.url ? `[${label}](${p.url})` : label;
                          return p.isDraft ? `${link} (draft)` : link;
                      })
                      .join(", ")
                : "";
            lines.push(`- ${box} ${statusPrefix}${it.text}${statusSuffix}${prPart}`);
        }
        lines.push("");
    }

    return lines.join("\n").trimEnd() + "\n";
}

export async function backupListToWorkdocs(listId = "default") {
    const [state, settings] = await Promise.all([
        loadList(listId),
        loadSettings(),
    ]);
    const dest = parseBackupDestination(settings.backupRepo);
    if (!dest) {
        throw new Error(
            "No backup repository configured. Open Settings to set a GitHub repository or folder URL.",
        );
    }

    const markdown = formatTodoFeedMarkdown(state);
    const contentBase64 = Buffer.from(markdown, "utf8").toString("base64");
    const env = {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
    };

    const repoPath = `repos/${dest.repo}/contents/${dest.filePath}`;

    let existingSha = null;
    try {
        const { stdout } = await execFileAsync(
            "gh",
            ["api", `${repoPath}?ref=main`, "--jq", ".sha"],
            { env, timeout: 8000 },
        );
        const sha = stdout.trim();
        if (sha) existingSha = sha;
    } catch {}

    const args = [
        "api",
        repoPath,
        "-X",
        "PUT",
        "-f",
        `message=Backup ${dest.filePath}`,
        "-f",
        "branch=main",
        "-f",
        `content=${contentBase64}`,
    ];
    if (existingSha) {
        args.push("-f", `sha=${existingSha}`);
    }

    const { stdout } = await execFileAsync("gh", args, { env, timeout: 12000 });
    const parsed = JSON.parse(stdout);
    return {
        ok: true,
        repo: dest.display,
        filePath: dest.filePath,
        url:
            parsed.content?.html_url ||
            `https://github.com/${dest.repo}/blob/main/${dest.filePath}`,
        commitSha: parsed.commit?.sha || null,
    };
}
