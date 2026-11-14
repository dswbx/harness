import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatState } from "../../../state/reducer";
import { type PendingMessage, removePendingActions, setPendingActions } from "../pendingMessages";
import { PendingRow } from "./PendingRow";

const item: PendingMessage = {
   id: "m1",
   prompt: "hello",
   inputs: [],
   files: [],
   comments: [],
   snap: {} as never,
   status: "failed",
   base: 0,
};

describe("PendingRow", () => {
   it("calls actions registered after it rendered, at click time", () => {
      const composer = "row-test-1";
      render(
         <PendingRow item={item} state={{ recovery: null } as ChatState} composer={composer} />,
      );
      const retry = vi.fn();
      const edit = vi.fn();
      setPendingActions(composer, { retry, edit });
      fireEvent.click(screen.getByText("Retry"));
      fireEvent.click(screen.getByText("Edit"));
      expect(retry).toHaveBeenCalledTimes(1);
      expect(edit).toHaveBeenCalledWith(item);
      removePendingActions(composer);
   });
});
