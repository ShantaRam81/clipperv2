// Future desktop entrypoint.
// This file is intentionally small: Electron should only own native window,
// native dialogs, and packaged binary paths. App logic stays in src/server.

import { app, BrowserWindow } from "electron";
import { startServer } from "../../src/server/app.js";

let mainWindow;
let server;

async function createWindow() {
  server = await startServer({ port: process.env.PORT || 3000 });

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Reference Clipper",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadURL("http://localhost:3000/");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  server?.close();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
