import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useCopied } from "./useCopied";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let api: ReturnType<typeof useCopied>;
function Probe() {
   api = useCopied();
   return null;
}

const writeText = vi.fn<(t: string) => Promise<void>>();
beforeEach(() => {
   vi.useFakeTimers();
   writeText.mockReset();
   Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => vi.useRealTimers());

const mount = () => {
   const root = createRoot(document.createElement("div"));
   act(() => root.render(<Probe />));
   return root;
};

test("copied is true for 1.5s after a successful copy", async () => {
   writeText.mockResolvedValue();
   mount();
   expect(api[0]).toBe(false);
   await act(() => api[1]("hello"));
   expect(writeText).toHaveBeenCalledWith("hello");
   expect(api[0]).toBe(true);
   act(() => vi.advanceTimersByTime(1499));
   expect(api[0]).toBe(true);
   act(() => vi.advanceTimersByTime(2));
   expect(api[0]).toBe(false);
});

test("a second copy restarts the timer", async () => {
   writeText.mockResolvedValue();
   mount();
   await act(() => api[1]("a"));
   act(() => vi.advanceTimersByTime(1000));
   await act(() => api[1]("b"));
   act(() => vi.advanceTimersByTime(1000));
   expect(api[0]).toBe(true);
   act(() => vi.advanceTimersByTime(600));
   expect(api[0]).toBe(false);
});

test("a failed write stays false and does not throw", async () => {
   writeText.mockRejectedValue(new Error("denied"));
   mount();
   await act(() => api[1]("x"));
   expect(api[0]).toBe(false);
});
