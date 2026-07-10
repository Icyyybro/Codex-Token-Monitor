import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const DEFAULT_PORT = Number(process.env.PORT || 4317);
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const APP_RESOURCES_DIR = join(dirname(process.execPath), "..", "Resources");
const IS_APP_BUNDLE = process.execPath.includes(".app/Contents/MacOS/");
const PUBLIC_DIR = process.env.PUBLIC_DIR || (
  existsSync(join(APP_RESOURCES_DIR, "public")) ? join(APP_RESOURCES_DIR, "public") : join(process.cwd(), "public")
);
const SQLITE_BIN = process.env.SQLITE_BIN || (existsSync("/usr/bin/sqlite3") ? "/usr/bin/sqlite3" : "sqlite3");
const DEFAULT_AUTO_REFRESH_MS = 5 * 60 * 1000;
const AUTO_REFRESH_MS = parseDurationMs(process.env.AUTO_REFRESH_INTERVAL, DEFAULT_AUTO_REFRESH_MS);
const STATE_DB = join(CODEX_HOME, "state_5.sqlite");
const LOGS_DB = join(CODEX_HOME, "logs_2.sqlite");
const SESSIONS_DIR = join(CODEX_HOME, "sessions");
const ARCHIVED_DIR = join(CODEX_HOME, "archived_sessions");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function parseDurationMs(value, fallback) {
  if (!value) return fallback;
  const text = String(value).trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?$/);
  if (!match) return fallback;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;

  const unit = match[2] || "ms";
  if (unit === "ms" || unit.startsWith("millisecond")) return Math.round(amount);
  if (unit === "s" || unit.startsWith("sec")) return Math.round(amount * 1000);
  if (unit === "m" || unit.startsWith("min")) return Math.round(amount * 60 * 1000);
  return Math.round(amount * 60 * 60 * 1000);
}

function sqlite(dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(SQLITE_BIN, ["-json", dbPath, sql], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(err || `sqlite3 exited with ${code}`));
        return;
      }
      try {
        resolve(out.trim() ? JSON.parse(out) : []);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfLocalDay(ms = Date.now()) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfLocalHour(ms = Date.now()) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
}

function hourKey(ms) {
  const date = new Date(ms);
  return `${dayKey(ms)} ${String(date.getHours()).padStart(2, "0")}:00`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 秒";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${Math.floor(seconds)} 秒`;
}

async function getThreads() {
  if (!existsSync(STATE_DB)) return [];
  return sqlite(
    STATE_DB,
    `select id, rollout_path, created_at, updated_at, title, tokens_used
     from threads
     order by updated_at desc
     limit 5000;`
  );
}

async function getRecentLogUsage() {
  if (!existsSync(LOGS_DB)) return [];
  const since = Math.floor((Date.now() - 8 * 86400 * 1000) / 1000);
  const rows = await sqlite(
    LOGS_DB,
    `select ts, thread_id, feedback_log_body
     from logs
     where feedback_log_body like '%post sampling token usage%'
       and ts >= ${since}
     order by ts desc
     limit 20000;`
  );
  return rows
    .map((row) => {
      const body = row.feedback_log_body || "";
      const total = body.match(/total_usage_tokens=(\d+)/);
      const turn = body.match(/turn_id=([0-9a-f-]+)/);
      return {
        ts: row.ts,
        threadId: row.thread_id,
        turnId: turn?.[1] || null,
        totalTokens: total ? Number(total[1]) : 0
      };
    })
    .filter((row) => row.totalTokens > 0);
}

async function parseTokenCounts(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  const events = [];
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"token_count"')) continue;
    try {
      const event = JSON.parse(line);
      const payload = event.payload;
      if (payload?.type !== "token_count") continue;
      events.push({
        timestamp: Date.parse(event.timestamp),
        usage: payload.info || {},
        rateLimits: payload.rate_limits || null
      });
    } catch {
      // Ignore partial or legacy lines.
    }
  }
  return events;
}

async function getRecentTokenEvents(threads) {
  const since = Date.now() - 8 * 86400 * 1000;
  const events = [];
  const candidates = threads
    .filter((thread) => Number(thread.updated_at || 0) * 1000 >= since)
    .map((thread) => thread.rollout_path)
    .filter(Boolean)
    .slice(0, 500);

  for (const filePath of candidates) {
    const tokenCounts = await parseTokenCounts(filePath);
    for (const event of tokenCounts) {
      const tokens = Number(event.usage?.last_token_usage?.total_tokens || 0);
      if (Number.isFinite(event.timestamp) && event.timestamp >= since && tokens > 0) {
        events.push({ timestamp: event.timestamp, tokens });
      }
    }
  }

  return events;
}

async function getLatestRateLimit(threads) {
  const candidates = threads
    .map((thread) => thread.rollout_path)
    .filter(Boolean)
    .slice(0, 80);
  for (const filePath of candidates) {
    const events = await parseTokenCounts(filePath);
    if (events.length) return events.at(-1);
  }
  return null;
}

async function getFileActivity(paths) {
  const byDay = new Map();
  let total = 0;
  let peak = 0;
  let longestTaskSeconds = 0;

  for (const filePath of paths) {
    if (!filePath || !existsSync(filePath)) continue;
    try {
      const file = await stat(filePath);
      const dateKey = dayKey(file.mtimeMs);
      const count = byDay.get(dateKey) || 0;
      byDay.set(dateKey, count + 1);
      total += 1;
      peak = Math.max(peak, count + 1);
    } catch {
      // Best effort only.
    }
  }

  return { byDay, total, peak, longestTaskSeconds };
}

function usageFromThreads(threads) {
  const todayStart = Math.floor(startOfLocalDay() / 1000);
  const weekStart = Math.floor((Date.now() - 7 * 86400 * 1000) / 1000);
  const monthStart = Math.floor((Date.now() - 365 * 86400 * 1000) / 1000);
  let today = 0;
  let week = 0;
  let total = 0;
  let peak = 0;
  let longestTaskSeconds = 0;
  const byDay = new Map();
  const recentThreads = [];

  for (const thread of threads) {
    const tokens = Number(thread.tokens_used || 0);
    const updatedAt = Number(thread.updated_at || thread.created_at || 0);
    const createdAt = Number(thread.created_at || updatedAt);
    const duration = Math.max(0, updatedAt - createdAt);
    total += tokens;
    peak = Math.max(peak, tokens);
    longestTaskSeconds = Math.max(longestTaskSeconds, duration);
    if (updatedAt >= todayStart) today += tokens;
    if (updatedAt >= weekStart) week += tokens;
    if (updatedAt >= monthStart) {
      const key = dayKey(updatedAt * 1000);
      byDay.set(key, (byDay.get(key) || 0) + tokens);
    }
    recentThreads.push({
      id: thread.id,
      title: thread.title || "未命名会话",
      tokens,
      updatedAt: updatedAt * 1000,
      durationSeconds: duration
    });
  }

  return { today, week, total, peak, byDay, longestTaskSeconds, recentThreads };
}

function buildCalendar(byDay) {
  const days = [];
  const end = startOfLocalDay();
  const start = end - 364 * 86400 * 1000;
  const max = Math.max(1, ...byDay.values());
  for (let ms = start; ms <= end; ms += 86400 * 1000) {
    const key = dayKey(ms);
    const value = byDay.get(key) || 0;
    let level = 0;
    if (value > 0) level = Math.max(1, Math.ceil((value / max) * 4));
    days.push({ date: key, value, level });
  }
  return { days, max };
}

function buildHourlyActivity(tokenEvents, logUsage, threadById) {
  const endHourMs = startOfLocalHour();
  const startMs = endHourMs - 23 * 3600 * 1000;
  const hours = new Map();
  for (let offset = 0; offset < 24; offset += 1) {
    const ms = startMs + offset * 3600 * 1000;
    hours.set(hourKey(ms), 0);
  }

  for (const event of tokenEvents) {
    if (event.timestamp < startMs) continue;
    const key = hourKey(event.timestamp);
    if (hours.has(key)) hours.set(key, hours.get(key) + event.tokens);
  }

  for (const row of calculateLogDeltas(logUsage, threadById, startMs)) {
    const key = hourKey(row.ts * 1000);
    if (hours.has(key) && hours.get(key) === 0) hours.set(key, row.tokens);
  }

  return [...hours.entries()].map(([key, value]) => ({
    key,
    label: key,
    shortLabel: key.slice(11),
    value
  }));
}

function buildWeeklyActivity(tokenEvents, logUsage, threadById) {
  const todayStartMs = startOfLocalDay();
  const startMs = todayStartMs - 6 * 86400 * 1000;
  const days = new Map();
  for (let offset = 0; offset < 7; offset += 1) {
    const ms = startMs + offset * 86400 * 1000;
    days.set(dayKey(ms), 0);
  }

  for (const event of tokenEvents) {
    if (event.timestamp < startMs) continue;
    const key = dayKey(event.timestamp);
    if (days.has(key)) days.set(key, days.get(key) + event.tokens);
  }

  for (const row of calculateLogDeltas(logUsage, threadById, startMs)) {
    const key = dayKey(row.ts * 1000);
    if (days.has(key) && days.get(key) === 0) days.set(key, row.tokens);
  }

  return [...days.entries()].map(([key, value]) => {
    const date = new Date(`${key}T00:00:00`);
    return {
      key,
      label: key,
      shortLabel: `${date.getMonth() + 1}/${date.getDate()}`,
      value
    };
  });
}

function calculateLogDeltas(logUsage, threadById, periodStartMs) {
  const byThread = new Map();
  const rows = [...logUsage].sort((a, b) => a.ts - b.ts);
  for (const row of rows) {
    if (!row.threadId) continue;
    if (!byThread.has(row.threadId)) byThread.set(row.threadId, []);
    byThread.get(row.threadId).push(row);
  }

  const deltas = [];
  for (const [threadId, threadRows] of byThread.entries()) {
    const thread = threadById.get(threadId);
    const threadCreatedMs = Number(thread?.created_at || 0) * 1000;
    let previous = 0;
    let hasBaseline = false;
    for (const row of threadRows) {
      const rowMs = row.ts * 1000;
      if (rowMs < periodStartMs) {
        previous = Math.max(previous, row.totalTokens);
        hasBaseline = true;
        continue;
      }

      let tokens = 0;
      if (hasBaseline || threadCreatedMs >= periodStartMs) {
        tokens = Math.max(0, row.totalTokens - previous);
      }
      previous = Math.max(previous, row.totalTokens);
      hasBaseline = true;
      if (tokens > 0) deltas.push({ ts: row.ts, threadId, tokens });
    }
  }
  return deltas;
}

function rateWindow(limit) {
  if (!limit) return null;
  const usedPercent = Number(limit.used_percent || 0);
  return {
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    windowMinutes: limit.window_minutes,
    resetsAt: limit.resets_at ? limit.resets_at * 1000 : null
  };
}

function openBrowser(url) {
  if (process.env.OPEN_BROWSER === "0") return;
  if (process.env.OPEN_BROWSER !== "1" && !IS_APP_BUNDLE) return;
  if (process.platform !== "darwin") return;
  const child = spawn("open", [url], {
    stdio: "ignore",
    detached: true
  });
  child.unref();
}

async function getUsageSummary() {
  const [threads, logUsage] = await Promise.all([getThreads(), getRecentLogUsage()]);
  const tokenEvents = await getRecentTokenEvents(threads);
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const threadUsage = usageFromThreads(threads);
  const latestRate = await getLatestRateLimit(threads);

  for (const row of logUsage) {
    if (!row.threadId) continue;
    const key = dayKey(row.ts * 1000);
    const current = threadUsage.byDay.get(key) || 0;
    threadUsage.byDay.set(key, Math.max(current, row.totalTokens));
  }

  const recentPaths = threads.map((thread) => thread.rollout_path);
  await getFileActivity([...recentPaths, ARCHIVED_DIR, SESSIONS_DIR]);

  return {
    generatedAt: Date.now(),
    source: {
      codexHome: CODEX_HOME,
      stateDb: existsSync(STATE_DB),
      logsDb: existsSync(LOGS_DB),
      rateLimitFromJsonl: Boolean(latestRate)
    },
    totals: {
      totalTokens: threadUsage.total,
      peakTokens: threadUsage.peak,
      todayTokens: threadUsage.today,
      weekTokens: threadUsage.week,
      longestTask: formatDuration(threadUsage.longestTaskSeconds)
    },
    limits: {
      day: rateWindow(latestRate?.rateLimits?.primary),
      week: rateWindow(latestRate?.rateLimits?.secondary),
      credits: latestRate?.rateLimits?.credits || null
    },
    currentContext: {
      totalTokenUsage: latestRate?.usage?.total_token_usage || null,
      lastTokenUsage: latestRate?.usage?.last_token_usage || null,
      contextWindow: latestRate?.usage?.model_context_window || null
    },
    activity: {
      dailyHourly: buildHourlyActivity(tokenEvents, logUsage, threadById),
      weeklyDaily: buildWeeklyActivity(tokenEvents, logUsage, threadById),
      cumulativeDaily: buildCalendar(threadUsage.byDay)
    },
    recentThreads: threadUsage.recentThreads.slice(0, 12)
  };
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(PUBLIC_DIR, requestedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

function createAppServer() {
  return createServer(async (request, response) => {
  if (request.url?.startsWith("/api/config")) {
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(
      JSON.stringify({
        autoRefreshMs: AUTO_REFRESH_MS
      })
    );
    return;
  }

  if (request.url?.startsWith("/api/usage")) {
    try {
      const summary = await getUsageSummary();
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(JSON.stringify(summary));
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  serveStatic(request, response);
  });
}

export function startServer({ port = DEFAULT_PORT, host = "127.0.0.1", shouldOpenBrowser = true } = {}) {
  const server = createAppServer();

  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE" && port !== 0) {
        console.log(`Port ${port} is in use, trying a random available port.`);
        server.listen(0, host);
        return;
      }
      reject(error);
    });

    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      const url = `http://localhost:${actualPort}`;
      console.log(`Codex token monitor running at ${url}`);
      console.log(`Auto refresh interval: ${AUTO_REFRESH_MS}ms`);
      if (shouldOpenBrowser) openBrowser(url);
      resolve({ server, url, port: actualPort });
    });
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
