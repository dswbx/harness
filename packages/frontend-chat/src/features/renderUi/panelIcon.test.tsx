import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { iconFor, PanelIcon } from "./panelIcon";
import { uiIcons } from "./uiIcons";

vi.mock("lucide-react/dynamicIconImports", () => ({
   default: {
      anchor: () =>
         Promise.resolve({ default: (p: object) => <svg data-testid="lucide-anchor" {...p} /> }),
   },
}));

afterEach(cleanup);

describe("panel icon", () => {
   it("a curated name is the static icon, rendered at once", () => {
      expect(iconFor("star")).toBe(uiIcons.star);
      const { container } = render(<PanelIcon name="star" className="size-4" />);
      expect(container.querySelector("svg.lucide-star")).not.toBeNull();
   });

   it("an empty name has no icon; the fallback shows", () => {
      expect(iconFor(null)).toBeUndefined();
      expect(iconFor("")).toBeUndefined();
      const { container } = render(<PanelIcon name={undefined} fallback={uiIcons.file} />);
      expect(container.querySelector("svg.lucide-file")).not.toBeNull();
   });

   it("another lucide name keeps its size while it loads, then shows the icon", async () => {
      expect(iconFor("anchor")).toBe(iconFor("anchor"));
      const { container } = render(<PanelIcon name="anchor" className="size-4" />);
      const box = container.querySelector("svg");
      expect(box?.getAttribute("class")).toContain("size-4");
      await screen.findByTestId("lucide-anchor");
   });

   it("an unknown name stays an empty box of the same size", async () => {
      const { container } = render(<PanelIcon name="no-such-icon" className="size-4" />);
      await waitFor(() => expect(container.querySelector("svg")).not.toBeNull());
      expect(container.querySelector("svg")?.getAttribute("class")).toContain("size-4");
   });
});
