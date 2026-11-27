const { app, BrowserWindow } = require("electron");
app.whenReady().then(async () => {
  const editor = new BrowserWindow({ title: "Sync Vault QA editor", width: 420, height: 220,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await editor.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    '<meta charset="utf-8"><title>Sync Vault QA editor</title><div id="edit" contenteditable="true"></div>'));
});
