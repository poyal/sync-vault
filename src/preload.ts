import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("vault", {
  call: (action: string, value?: unknown) =>
    ipcRenderer.invoke("vault", action, value),
  listen: (fn: () => void) => {
    ipcRenderer.on("vault:changed", fn);
  },
  onPrivacy: (fn:(peer?:string)=>void) => {ipcRenderer.on("vault:privacy",(_event,peer)=>fn(peer));},
  onRequest: (fn: (link: { page: string; id: string }) => void) => {
    ipcRenderer.on("vault:request", (_event, link) => fn(link));
  },
});
