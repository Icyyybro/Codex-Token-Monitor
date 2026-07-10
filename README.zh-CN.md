# Codex Token Monitor

[English](README.md) | 中文

Codex Token Monitor 是一个本地 macOS 桌面应用，用于查看当前机器上的 Codex token 使用量和额度状态。

应用以 Electron 独立窗口运行。它会在后台启动一个仅监听本机的 HTTP 服务，从 `~/.codex` 读取 Codex 本地数据，并在应用窗口中渲染仪表盘。应用不会上传、修改或同步你的 Codex 数据。

## 效果图

![Codex Token Monitor 仪表盘](assets/screenshot.png)

## 功能

- 展示累计 token、峰值 token、今日用量、近 7 天用量和最长任务时长。
- 当 Codex 写入 rate-limit 事件后，展示每日和每周额度剩余百分比。
- 展示最近 24 小时和最近 7 天的 token 活动图表。
- 展示过去 365 天的活动热力图。
- 展示最近 Codex 会话，包括标题、token 数和更新时间。
- 完全本地运行。

## 环境要求

- macOS 12 或更高版本。
- 开发环境需要 Node.js 和 npm。
- 机器上需要可用的 `sqlite3`。macOS 通常自带 `/usr/bin/sqlite3`。
- 本机需要已有 Codex 数据，默认位于 `~/.codex`。

如果 Codex 还没有产生 token 使用事件，部分区域可能会显示为空或数据不完整。等新的 Codex 活动被记录后会自动恢复。

## 数据来源

应用会读取这些本地 Codex 文件：

- `~/.codex/state_5.sqlite`：会话列表和汇总 token 用量。
- `~/.codex/logs_2.sqlite`：最近 token 使用日志。
- `~/.codex/sessions/**/*.jsonl`：`token_count` 事件、上下文用量和额度信息。

应用只读取这些文件，不会修改 Codex 配置、会话、日志或数据库。

## 隐私

所有数据都保留在你的机器上。应用不会向外部服务发起网络请求。它启动的 HTTP 服务只监听 localhost，用于 Electron 窗口加载仪表盘和 API 响应。

## 安装

```bash
npm install
```

## 开发

启动 Electron 应用：

```bash
npm run electron:dev
```

只启动本地 Web 服务：

```bash
npm start
```

Web 服务默认监听 `http://localhost:4317`。可以指定端口：

```bash
PORT=4320 npm start
```

也可以调整自动刷新间隔：

```bash
AUTO_REFRESH_INTERVAL=30s npm start
AUTO_REFRESH_INTERVAL=10m npm start
```

`AUTO_REFRESH_INTERVAL` 支持 `ms`、`s/sec`、`m/min` 和 `h/hour` 后缀，默认值是 `5m`。

## 构建

构建 macOS Electron 应用：

```bash
npm run build:mac
```

构建产物会输出到 `dist/`，例如：

```text
dist/mac-arm64/Codex Token Monitor.app
dist/Codex Token Monitor-1.0.0-arm64.dmg
dist/Codex Token Monitor-1.0.0-arm64.zip
```

默认构建产物会匹配当前机器架构。Apple Silicon Mac 会生成 `arm64` 版本。如果需要 Intel 版本，请在 Intel Mac 上构建。


## 项目结构

```text
electron/main.js     Electron 主进程。
server.js            本地 HTTP 服务和 Codex 数据读取逻辑。
public/              仪表盘 HTML、CSS 和浏览器 JavaScript。
start.sh             后台运行 Web 服务的便捷脚本。
package.json         npm 脚本和 Electron Builder 配置。
```

## 下载

前往 [Releases 页面](https://github.com/Icyyybro/get_codex_token/releases) 下载最新版本。

## 许可证

MIT


