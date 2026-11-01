import { useCallback, useEffect, useState } from "react";
import { inTauri } from "@harness/api";
import { errText } from "./toast";

/** Self-update state from the Tauri adapter (`updates.rs`): installed in the background, applied on restart. */
export function useUpdate() {
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri()) return;
    let stop = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      const { listen } = await import("@tauri-apps/api/event");
      const u = await listen<string>("update-ready", (e) => setReady(e.payload));
      if (stop) u();
      else unlisten = u;
      const v = await invoke<string | null>("update_ready");
      if (!stop && v) setReady(v);
    })();
    return () => {
      stop = true;
      unlisten?.();
    };
  }, []);
  return ready;
}

export async function restartToUpdate() {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("update_restart");
}

export type CheckResult = { kind: "ready"; version: string } | { kind: "latest" } | { kind: "error"; message: string };

export function useUpdateCheck() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    setResult(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const v = await invoke<string | null>("update_check");
      setResult(v ? { kind: "ready", version: v } : { kind: "latest" });
    } catch (e) {
      setResult({ kind: "error", message: errText(e) });
    } finally {
      setChecking(false);
    }
  }, []);
  return { checking, result, check };
}

/** The running app's version ("dev" outside Tauri). */
export function useAppVersion() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!inTauri()) return setVersion("dev");
    void import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).then(setVersion);
  }, []);
  return version;
}
