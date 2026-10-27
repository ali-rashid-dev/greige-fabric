import { app, BrowserWindow, dialog, session } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";

const developmentUrl = process.env.DESKTOP_DEV_URL;
let mainWindow: BrowserWindow | null = null;

function getRendererPath(): string {
  return path.join(app.getAppPath(), "out", "index.html");
}

function isAllowedNavigation(targetUrl: string, productionFileUrl: string): boolean {
  try {
    return developmentUrl
      ? new URL(targetUrl).origin === new URL(developmentUrl).origin
      : targetUrl === productionFileUrl;
  } catch {
    return false;
  }
}

function installSecurityPolicy(): void {
  const isDevelopment = Boolean(developmentUrl);
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self'${isDevelopment ? " http://127.0.0.1:3000 ws://127.0.0.1:3000" : ""}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
        "X-Content-Type-Options": ["nosniff"],
        "Referrer-Policy": ["no-referrer"],
      },
    });
  });
}

async function createMainWindow(): Promise<void> {
  const rendererPath = getRendererPath();
  const productionFileUrl = pathToFileURL(rendererPath).href;
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 780,
    minHeight: 600,
    title: "Greige Fabric POS",
    backgroundColor: "#f7f7f5",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl, productionFileUrl)) event.preventDefault();
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());

  try {
    if (developmentUrl) {
      await mainWindow.loadURL(developmentUrl);
      mainWindow.webContents.openDevTools({ mode: "detach" });
    } else {
      await mainWindow.loadFile(rendererPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    await dialog.showMessageBox({
      type: "error",
      title: "Unable to open Greige Fabric POS",
      message: "The application window could not be loaded.",
      detail: app.isPackaged ? undefined : message,
    });
    app.quit();
  }
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, targetUrl) => {
    if (!isAllowedNavigation(targetUrl, pathToFileURL(getRendererPath()).href)) {
      event.preventDefault();
    }
  });
});

app.whenReady().then(async () => {
  installSecurityPolicy();
  try {
    await createMainWindow();
  } catch (error) {
    console.error("Application startup failed.", error);
    await dialog.showMessageBox({
      type: "error",
      title: "Greige Fabric POS could not start",
      message: "The application could not start.",
      detail: app.isPackaged ? undefined : String(error),
    });
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
