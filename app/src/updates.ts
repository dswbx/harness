import { useCallback, useEffect, useState } from "react";
import { inTauri } from "@harness/api";
import { errText } from "./toast";

/** Mirrors `UpdateState` in the Tauri adapter (`updates.rs`). */
export type UpdateState =
  | { kind: "idle" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "ready"; version: string }
  | { kind: "failed"; version: string; error: string };

const invoke = async <T>(cmd: string) => (await import("@tauri-apps/api/core")).invoke<T>(cmd);

export const releaseUrl = (version: string) => `https://github.com/dswbx/harness/releases/tag/v${version}`;

/** Plain-browser development: `?update=available|downloading|ready|failed` shows that state. */
function mockState(): UpdateState {
  const kind = inTauri() ? null : new URLSearchParams(window.location.search).get("update");
  const version = "2026.11.1";
  if (kind === "available" || kind === "ready") return { kind, version };
  if (kind === "downloading") return { kind, version, percent: 42 };
  if (kind === "failed") return { kind, version, error: "Couldn't reach github.com" };
  return { kind: "idle" };
}

/** Opt-in self-update: found in the background, downloaded on `install()`, applied on `restart()`. */
export function useUpdate() {
  const [state, setState] = useState<UpdateState>(mockState);
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    if (!inTauri()) return;
    let stop = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const u = await listen<UpdateState>("update-state", (e) => setState(e.payload));
      if (stop) return u();
      unlisten = u;
      const s = await invoke<UpdateState>("update_state");
      if (!stop) setState(s);
    })();
    return () => {
      stop = true;
      unlisten?.();
    };
  }, []);
  // Failures land in the state as `failed`.
  const install = useCallback(() => void invoke("update_install").catch(() => {}), []);
  const restart = useCallback(() => {
    setRestarting(true);
    invoke("update_restart").catch(() => setRestarting(false));
  }, []);
  return { state, restarting, install, restart };
}

export type CheckResult = { kind: "latest" } | { kind: "error"; message: string };

export function useUpdateCheck() {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    setResult(null);
    try {
      const s = await invoke<UpdateState>("update_check");
      if (s.kind === "idle") setResult({ kind: "latest" });
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
