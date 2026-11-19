import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IconPicker } from "./IconPicker";
import { lucideIconNames } from "./panelIcon";

const flag = vi.hoisted(() => ({ fail: true }));

vi.mock("lucide-react/dynamicIconImports", () => {
   if (flag.fail) throw new Error("chunk failed to load");
   return { default: { anchor: () => Promise.resolve({ default: () => null }) } };
});

afterEach(cleanup);

describe("icon table load failure", () => {
   it("is not cached: the picker says so and Retry loads it", async () => {
      flag.fail = true;
      render(<IconPicker labelId="l" picked={null} onPick={() => {}} />);
      fireEvent.change(screen.getByLabelText("Search icons"), { target: { value: "anch" } });
      await screen.findByText("Couldn't load icons");
      flag.fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await screen.findByRole("radio", { name: "anchor" });
      expect(await lucideIconNames()).toEqual(["anchor"]);
   });
});
