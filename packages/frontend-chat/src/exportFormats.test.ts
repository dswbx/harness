import { describe, expect, it } from "vitest";
import {
   fileName,
   markdownTableRows,
   rowsToCsv,
   rowsToMarkdown,
   rowsToTsv,
   uiFormats,
} from "./exportFormats";
import { fitScale } from "./toPng";

const read = async (b: Promise<Blob>) => (await b).text();

describe("markdownTableRows", () => {
   it("gives plain cells, without the separator row", () => {
      const md = [
         "| Name | Link | Note |",
         "|---|:--:|---|",
         "| **snake_case** | [site](https://x.y) | a \\| b |",
         "| `code` |  | *em* |",
      ].join("\n");
      expect(markdownTableRows(md)).toEqual([
         ["Name", "Link", "Note"],
         ["snake_case", "site", "a | b"],
         ["code", "", "em"],
      ]);
   });
});

describe("table text", () => {
   const rows = [
      ["a", "b"],
      ['x,"y"', "line\nbreak"],
      ["p|q", "t\tu"],
   ];
   it("quotes CSV cells only when needed", () => {
      expect(rowsToCsv(rows)).toBe('a,b\n"x,""y""","line\nbreak"\np|q,t\tu');
   });
   it("keeps TSV to one cell per tab and one row per line", () => {
      expect(rowsToTsv(rows)).toBe('a\tb\nx,"y"\tline break\np|q\tt u');
   });
   it("writes Markdown that reads back", () => {
      expect(
         markdownTableRows(
            rowsToMarkdown([
               ["a", "b"],
               ["p|q", "c"],
            ]),
         ),
      ).toEqual([
         ["a", "b"],
         ["p|q", "c"],
      ]);
   });
});

describe("uiFormats", () => {
   it("offers the HTML of an Html root", async () => {
      const [f] = uiFormats("x", { type: "Html", props: { html: "<b>hi</b>" } });
      expect(f?.file).toBe("x.html");
      expect(await read(f!.blob())).toBe("<b>hi</b>");
   });
   it("offers the rows of a Table root, with cells as text", async () => {
      const formats = uiFormats("x", {
         type: "Table",
         props: { columns: ["A"], rows: [[{ text: "1", tone: "good" }], { cells: ["2"] }] },
      });
      expect(formats.map((f) => f.label)).toEqual(["Markdown", "CSV", "TSV"]);
      expect(await read(formats[1]!.blob())).toBe("A\n1\n2");
   });
   it("offers the data of a Chart root", async () => {
      const [f] = uiFormats("x", {
         type: "Chart",
         props: { x: "m", series: [{ key: "n" }], data: [{ m: "Jan", n: 3, skip: 1 }] },
      });
      expect(await read(f!.blob())).toBe("m,n\nJan,3");
   });
   it("has nothing else for other roots", () => {
      expect(uiFormats("x", { type: "Card", props: {} })).toEqual([]);
   });
});

describe("fitScale", () => {
   it("keeps the scale when it fits", () => expect(fitScale(800, 600, 2)).toBe(2));
   it("respects the longest edge", () => expect(fitScale(3000, 1000, 2, 1500)).toBe(0.5));
   it("stays inside the canvas limits", () => {
      const k = fitScale(20000, 20000, 2);
      expect(20000 * k).toBeLessThanOrEqual(16000);
      expect(20000 * 20000 * k * k).toBeLessThanOrEqual(200_000_001);
   });
});

it("fileName makes a title safe", () => {
   expect(fileName("Last 20 CI runs: Übersicht!")).toBe("Last 20 CI runs Übersicht!");
   expect(fileName("Here is a plan.")).toBe("Here is a plan");
   expect(fileName("a/b\\c")).toBe("a b c");
   expect(fileName("???")).toBe("artifact");
});
