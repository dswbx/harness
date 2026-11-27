import { describe, expect, it } from "vitest";
import { tableSelectionText } from "./data";

function table() {
   document.body.innerHTML = `<table><tbody>
      <tr><td><span>P0</span></td><td><span>Token and dep</span></td><td><span>ci.yml:20</span></td></tr>
      <tr><td><span>P1</span></td><td><span>Baselines</span></td><td><span>main.rs:201</span></td></tr>
   </tbody></table>`;
   return document.querySelector("table") as HTMLTableElement;
}
const text = (t: HTMLTableElement, row: number, col: number) =>
   t.rows[row].cells[col].querySelector("span")?.firstChild as Text;

describe("tableSelectionText", () => {
   it("puts a tab between cells and a newline between rows, and cuts the end cells at the selection", () => {
      const t = table();
      const r = document.createRange();
      r.setStart(text(t, 0, 1), 6); // "and dep"
      r.setEnd(text(t, 1, 2), 4); // "main"
      expect(tableSelectionText(t, r)).toBe("and dep\tci.yml:20\nP1\tBaselines\tmain");
   });

   it("keeps a selection inside one cell as it is", () => {
      const t = table();
      const r = document.createRange();
      r.setStart(text(t, 0, 1), 0);
      r.setEnd(text(t, 0, 1), 5);
      expect(tableSelectionText(t, r)).toBe("Token");
   });
});
