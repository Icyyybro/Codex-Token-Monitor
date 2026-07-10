import { app, BrowserWindow, Menu, shell } from "electron";
import { startServer } from "../server.js";

let mainWindow = null;
let runningServer = null;

async function createWindow() {
  const { server, url } = await startServer({
    port: 0,
    shouldOpenBrowser: false
  });
  runningServer = server;

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    title: "Codex Token Monitor",
    backgroundColor: "#f7f8fb",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: externalUrl }) => {
    shell.openExternal(externalUrl);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!targetUrl.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  await mainWindow.loadURL(url);
}

app.setName("Codex Token Monitor");

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  runningServer?.close();
  runningServer = null;
});
