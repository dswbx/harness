import { inTauri } from "@harness/api";

const counters = new Map<string, number>();

/** Opens another View of the same Session in its own window (solo: no sidebar). */
export async function openViewWindow(sessionId: string, title: string) {
  const n = (counters.get(sessionId) ?? 0) + 1;
  counters.set(sessionId, n);
  const url = `/?session=${encodeURIComponent(sessionId)}&solo=1`;
  if (!inTauri()) {
    window.open(url, "_blank");
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const w = new WebviewWindow(`view-${sessionId}-${n}`, { url, title, width: 900, height: 760 });
  w.once("tauri://error", (e) => console.error("window create failed", e));
}
