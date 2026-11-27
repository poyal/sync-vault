import { contextBridge, ipcRenderer, webUtils } from "electron";
contextBridge.exposeInMainWorld("vault", {
  call: (action: string, value?: unknown) =>
    ipcRenderer.invoke("vault", action, value),
  drop: (files: File[]) =>
    ipcRenderer.invoke(
      "vault",
      "drop",
      files.map((f) => webUtils.getPathForFile(f)).filter(Boolean),
    ),
  listen: (fn: () => void) => {
    ipcRenderer.on("vault:changed", fn);
  },
});
