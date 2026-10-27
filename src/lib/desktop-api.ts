import type { DesktopApi } from "@/shared/types";

export function getDesktopApi(): DesktopApi {
  if (!window.electronAPI) {
    throw new Error("The desktop bridge is unavailable.");
  }
  return window.electronAPI;
}
