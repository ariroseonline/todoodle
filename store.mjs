import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);

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
        title: state.title || "Todo",
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
    const history = await loadHistory(id);
    try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        const { days, items } = normalizeDaysAndItems(parsed);
        const state = {
            listId: id,
            title:
                typeof parsed.title === "string" && parsed.title && parsed.title !== "Todo List"
                    ? parsed.title
                    : "Todo",
            days,
            items,
            canUndo: history.undoStack.length > 0,
            canRedo: history.redoStack.length > 0,
        };
        if (!Array.isArray(parsed.days) || !parsed.days[0]?.id) {
            await saveList(state, { recordHistory: false });
        }
        return state;
    } catch {
        const initialDay = createDayEntry();
        return {
            listId: id,
            title: "Todo",
            days: [initialDay],
            items: [],
            canUndo: history.undoStack.length > 0,
            canRedo: history.redoStack.length > 0,
        };
    }
}

export async function saveList(state, { recordHistory = true } = {}) {
    const id = sanitizeListId(state.listId);
    await mkdir(artifactsDir, { recursive: true });
    const { days, items } = normalizeDaysAndItems(state);
    const payload = {
        listId: id,
        title: state.title || "Todo",
        days,
        items,
    };

    if (recordHistory) {
        try {
            const existingRaw = await readFile(getFilePath(id), "utf8");
            const existingParsed = JSON.parse(existingRaw);
            const prevNorm = normalizeDaysAndItems(existingParsed);
            const prevSnap = snapshotOf({
                title: existingParsed.title || "Todo",
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
    const history = await loadHistory(id);
    return {
        ...payload,
        canUndo: history.undoStack.length > 0,
        canRedo: history.redoStack.length > 0,
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
    };
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
    const lines = [`# ${state.title || "Todo"}`, ""];
    const days = Array.isArray(state.days) ? state.days : [];
    const items = Array.isArray(state.items) ? state.items : [];
    const fallbackDayId = days[0]?.id;

    for (const day of days) {
        lines.push(`## ${day.emoji || "✨"} ${day.dateLabel}`);
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
    const state = await loadList(listId);
    const markdown = formatTodoFeedMarkdown(state);
    const contentBase64 = Buffer.from(markdown, "utf8").toString("base64");
    const env = {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
    };

    let owner = "ariroseonline";
    try {
        const { stdout } = await execFileAsync(
            "gh",
            ["api", "user", "--jq", ".login"],
            { env, timeout: 5000 },
        );
        const login = stdout.trim();
        if (login) owner = login;
    } catch {}

    const repoPath = `repos/${owner}/workdocs/contents/todo-list.md`;

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
        "message=Backup todo-list.md",
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
        url:
            parsed.content?.html_url ||
            `https://github.com/${owner}/workdocs/blob/main/todo-list.md`,
        commitSha: parsed.commit?.sha || null,
    };
}
