import type { SharedArtifactMeta, SharedKind } from "../../generated";

/** A Shared Artifact in the mock's in-memory `shared/` (ADR 0024). */
export type MockShared = {
   meta: SharedArtifactMeta;
   content: string;
   state: unknown;
   mtime: number;
};

/** `<slug>-<6 hex>`, like the core's ids. */
export function sharedId(title: string): string {
   const slug =
      title
         .toLowerCase()
         .replace(/[^a-z0-9]+/g, "-")
         .replace(/^-+|-+$/g, "")
         .slice(0, 40)
         .replace(/-+$/, "") || "artifact";
   const hex = Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, "0");
   return `${slug}-${hex}`;
}

/** The mock's Shared Artifacts: one of each kind. `attached` must match the Session Logs (see the constructor). */
export function mockShared(): MockShared[] {
   const h = 3_600_000;
   const now = Date.now();
   const meta = (
      id: string,
      title: string,
      kind: SharedKind,
      age: number,
      attached: string[],
   ): SharedArtifactMeta => ({
      v: 1,
      id,
      title,
      kind,
      created_ms: now - age * 4 * h,
      updated_ms: now - age * h,
      created_by: { session_id: "mock-s1", session_title: "Compact header layout" },
      attached,
   });
   return [
      {
         meta: meta("release-checklist-3f9a1c", "Release checklist", "md", 2, [
            "mock-1",
            "mock-s1",
         ]),
         content:
            "# Release checklist\n\n- [x] Bump the version\n- [x] Update the changelog\n- [ ] Tag the release\n- [ ] Publish the build\n\n<details>\n<summary>Notes</summary>\n\nThe Release workflow tags `v{year}.{month}.{n}`.\n\n</details>\n",
         state: {},
         mtime: now - 2 * h,
      },
      {
         meta: meta("deploy-dashboard-7c21e0", "Deploy dashboard", "html", 20, ["mock-s2"]),
         content:
            '<style>.b{padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--foreground)}</style>\n<div class="b">Deploy: <b data-state="/deploy/status">-</b> <button id="go">Mark shipped</button></div>\n<script>document.getElementById("go").onclick=()=>harness.patch([{op:"replace",path:"/deploy/status",value:"shipped"}]);</script>\n',
         state: { deploy: { status: "pending" } },
         mtime: now - 20 * h,
      },
      {
         meta: meta("architecture-map-a1b2c3", "Architecture map", "ui", 50, []),
         content: JSON.stringify({
            root: {
               type: "Card",
               props: { title: "Architecture map", tone: "info" },
               children: [
                  {
                     type: "Markdown",
                     props: { text: "Core in Rust, Frontends in TS. Commands in, Events out." },
                  },
                  {
                     type: "Checkbox",
                     props: { label: "Reviewed", value: { $bindState: "/reviewed" } },
                  },
               ],
            },
            files: {},
         }),
         state: { reviewed: false },
         mtime: now - 50 * h,
      },
   ];
}

/** A stable stand-in for the core's sha256 of a panel source. */
export function mockHash(text: string): string {
   let h = 0;
   for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
   return (h >>> 0).toString(16);
}
