import { contextBridge, ipcRenderer } from "electron";
import { channels } from "../shared/channels";
import type { DesktopApi } from "../shared/types";

const api: DesktopApi = {
  fabrics: {
    list: (filters = {}) => ipcRenderer.invoke(channels.listFabrics, filters),
    get: (input) => ipcRenderer.invoke(channels.getFabric, input),
    create: (input) => ipcRenderer.invoke(channels.createFabric, input),
    update: (input) => ipcRenderer.invoke(channels.updateFabric, input),
    setActive: (input) => ipcRenderer.invoke(channels.setFabricActive, input),
  },
  stock: {
    summary: () => ipcRenderer.invoke(channels.stockSummary),
    adjust: (input) => ipcRenderer.invoke(channels.adjustStock, input),
  },
  invoices: {
    list: () => ipcRenderer.invoke(channels.listInvoices),
    create: (input) => ipcRenderer.invoke(channels.createInvoice, input),
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
