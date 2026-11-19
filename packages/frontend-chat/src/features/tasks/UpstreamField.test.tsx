import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamField } from "./UpstreamField";

afterEach(cleanup);

function edit(url: string) {
   const onChange = vi.fn();
   render(<UpstreamField upstream={null} onChange={onChange} />);
   fireEvent.click(screen.getByRole("button", { name: "Add link" }));
   fireEvent.change(screen.getByRole("textbox", { name: "Link" }), { target: { value: url } });
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   return onChange;
}

describe("UpstreamField", () => {
   it("adds https:// when the link has no scheme", () => {
      expect(edit("linear.app/x/issue/ABC-1")).toHaveBeenCalledWith({
         url: "https://linear.app/x/issue/ABC-1",
         label: null,
      });
   });

   it("refuses another scheme and keeps the form open", () => {
      const onChange = edit("javascript:alert(1)");
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByText(/starts with https:\/\//)).toBeTruthy();
      expect(screen.getByRole("textbox", { name: "Link" }).getAttribute("aria-invalid")).toBe(
         "true",
      );
   });
});
