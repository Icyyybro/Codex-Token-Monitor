const defaultPollMs = 5 * 60 * 1000;
let pollMs = defaultPollMs;
let currentData = null;
let activeView = "daily";

const elements = {
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  totalTokens: document.querySelector("#totalTokens"),
  peakTokens: document.querySelector("#peakTokens"),
  longestTask: document.querySelector("#longestTask"),
  todayTokens: document.querySelector("#todayTokens"),
  weekTokens: document.querySelector("#weekTokens"),
  dayMeter: document.querySelector("#dayMeter"),
  weekMeter: document.querySelector("#weekMeter"),
  dayRemaining: document.querySelector("#dayRemaining"),
  weekRemaining: document.querySelector("#weekRemaining"),
  dayUsed: document.querySelector("#dayUsed"),
  weekUsed: document.querySelector("#weekUsed"),
  dayReset: document.querySelector("#dayReset"),
  weekReset: document.querySelector("#weekReset"),
  calendar: document.querySelector("#calendar"),
  months: document.querySelector("#months"),
  activityNote: document.querySelector("#activityNote"),
  tabs: [...document.querySelectorAll(".tabs button")],
  refreshButton: document.querySelector("#refreshButton"),
  threads: document.querySelector("#threads"),
  updatedAt: document.querySelector("#updatedAt")
};

function compactNumber(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return new Intl.NumberFormat("zh-CN").format(value);
}

function percent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(1)}%`;
}

function timeText(ms) {
  if (!ms) return "--";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(ms));
}

function refreshIntervalText(ms) {
  if (ms >= 60 * 60 * 1000 && ms % (60 * 60 * 1000) === 0) {
    return `${ms / (60 * 60 * 1000)}h`;
  }
  if (ms >= 60 * 1000 && ms % (60 * 1000) === 0) {
    return `${ms / (60 * 1000)}min`;
  }
  if (ms >= 1000 && ms % 1000 === 0) {
    return `${ms / 1000}s`;
  }
  return `${ms}ms`;
}

function setStatus(text, state = "ok") {
  elements.statusText.textContent = text;
  elements.statusDot.className = `dot ${state}`;
}

function renderLimit(prefix, limit) {
  const meter = elements[`${prefix}Meter`];
  const remaining = elements[`${prefix}Remaining`];
  const used = elements[`${prefix}Used`];
  const reset = elements[`${prefix}Reset`];
  if (!limit) {
    meter.style.width = "0%";
    remaining.textContent = "暂无官方额度事件";
    used.textContent = "等待 Codex 写入 token_count";
    reset.textContent = "--";
    return;
  }
  meter.style.width = `${Math.min(100, Math.max(0, limit.usedPercent))}%`;
  remaining.textContent = `剩余 ${percent(limit.remainingPercent)}`;
  used.textContent = `已用 ${percent(limit.usedPercent)} · 窗口 ${Math.round(limit.windowMinutes / 60)} 小时`;
  reset.textContent = `重置 ${timeText(limit.resetsAt)}`;
}

function renderCalendar(calendar) {
  elements.calendar.className = "calendar";
  elements.months.hidden = false;
  elements.activityNote.textContent = "过去 365 天每日 Token 活动";
  elements.calendar.replaceChildren(
    ...calendar.days.map((day) => {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.dataset.level = String(day.level);
      cell.title = `${day.date}: ${compactNumber(day.value)} tokens`;
      return cell;
    })
  );
}

function renderLineChart(items, mode) {
  const values = items.map((item) => item.value);
  const max = Math.max(1, ...values);
  const yMax = Math.max(1, Math.ceil(max / 100000) * 100000);
  const width = 1200;
  const height = 320;
  const padding = { top: 22, right: 24, bottom: 54, left: 76 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const points = items.map((item, index) => {
    const x = padding.left + (items.length === 1 ? 0 : (index / (items.length - 1)) * plotWidth);
    const y = padding.top + plotHeight - (item.value / yMax) * plotHeight;
    return { ...item, x, y };
  });
  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L ${padding.left + plotWidth} ${padding.top + plotHeight} L ${padding.left} ${padding.top + plotHeight} Z`;
  const yTicks = Array.from({ length: 6 }, (_, index) => {
    const value = (yMax / 5) * index;
    const y = padding.top + plotHeight - (value / yMax) * plotHeight;
    return { value, y };
  });
  const xLabelEvery = mode === "hourly" ? 3 : 1;

  elements.calendar.className = `line-chart ${mode}`;
  elements.months.hidden = true;
  elements.activityNote.textContent =
    mode === "hourly" ? "最近 24 小时 Token 用量" : "最近 7 天每日 Token 用量";
  elements.calendar.innerHTML = `
    <svg class="line-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${elements.activityNote.textContent}">
      <defs>
        <linearGradient id="lineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#71b7ff" stop-opacity="0.24" />
          <stop offset="100%" stop-color="#71b7ff" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${yTicks
        .map(
          (tick) => `
            <line class="grid-line" x1="${padding.left}" y1="${tick.y}" x2="${padding.left + plotWidth}" y2="${tick.y}" />
            <text class="axis-label y-label" x="${padding.left - 14}" y="${tick.y + 4}" text-anchor="end">${compactNumber(tick.value)}</text>
          `
        )
        .join("")}
      <line class="axis-line" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotHeight}" />
      <line class="axis-line" x1="${padding.left}" y1="${padding.top + plotHeight}" x2="${padding.left + plotWidth}" y2="${padding.top + plotHeight}" />
      <path class="area-path" d="${areaPath}" />
      <path class="line-path" d="${linePath}" />
      ${points
        .map(
          (point, index) => `
            <g class="line-point">
              <circle cx="${point.x}" cy="${point.y}" r="4">
                <title>${point.label}: ${compactNumber(point.value)} tokens</title>
              </circle>
              ${
                index % xLabelEvery === 0 || index === points.length - 1
                  ? `<text class="axis-label x-label" x="${point.x}" y="${padding.top + plotHeight + 28}" text-anchor="middle">${point.shortLabel}</text>`
                  : ""
              }
            </g>
          `
        )
        .join("")}
      <text class="axis-title" x="24" y="${padding.top + plotHeight / 2}" transform="rotate(-90 24 ${padding.top + plotHeight / 2})" text-anchor="middle">Token</text>
      <text class="axis-title" x="${padding.left + plotWidth / 2}" y="${height - 12}" text-anchor="middle">时间</text>
    </svg>
  `;
}

function renderActivity() {
  if (!currentData) return;
  elements.tabs.forEach((button) => {
    button.classList.toggle("active", button.dataset.view === activeView);
  });
  if (activeView === "daily") {
    renderLineChart(currentData.activity.dailyHourly, "hourly");
  } else if (activeView === "weekly") {
    renderLineChart(currentData.activity.weeklyDaily, "weekly");
  } else {
    renderCalendar(currentData.activity.cumulativeDaily);
  }
}

function renderThreads(threads) {
  elements.threads.replaceChildren(
    ...threads.map((thread) => {
      const row = document.createElement("div");
      row.className = "thread";
      const title = document.createElement("strong");
      title.textContent = thread.title;
      title.title = thread.title;
      const meta = document.createElement("span");
      meta.textContent = `${compactNumber(thread.tokens)} · ${timeText(thread.updatedAt)}`;
      row.append(title, meta);
      return row;
    })
  );
}

async function refresh() {
  try {
    elements.refreshButton.disabled = true;
    elements.refreshButton.classList.add("refreshing");
    setStatus("刷新中", "ok");
    const response = await fetch("/api/usage", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    currentData = data;
    elements.totalTokens.textContent = compactNumber(data.totals.totalTokens);
    elements.peakTokens.textContent = compactNumber(data.totals.peakTokens);
    elements.longestTask.textContent = data.totals.longestTask;
    elements.todayTokens.textContent = compactNumber(data.totals.todayTokens);
    elements.weekTokens.textContent = compactNumber(data.totals.weekTokens);
    renderLimit("day", data.limits.day);
    renderLimit("week", data.limits.week);
    renderActivity();
    renderThreads(data.recentThreads);
    elements.updatedAt.textContent = `更新 ${timeText(data.generatedAt)}`;
    setStatus(`${refreshIntervalText(pollMs)} 自动刷新`, data.source.rateLimitFromJsonl ? "ok" : "warn");
  } catch (error) {
    console.error(error);
    setStatus("读取失败", "warn");
  } finally {
    elements.refreshButton.disabled = false;
    elements.refreshButton.classList.remove("refreshing");
  }
}

elements.tabs.forEach((button) => {
  button.addEventListener("click", () => {
    activeView = button.dataset.view;
    renderActivity();
  });
});

elements.refreshButton.addEventListener("click", () => {
  refresh();
});

async function loadConfig() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    if (Number.isFinite(config.autoRefreshMs) && config.autoRefreshMs > 0) {
      pollMs = config.autoRefreshMs;
    }
  } catch (error) {
    console.warn("Using default refresh interval", error);
  }
}

async function start() {
  await loadConfig();
  await refresh();
  setInterval(refresh, pollMs);
}

start();
