/** The mock's file-backed panels (ADR 0023): these files in every Session's `panels/`. */
export const MOCK_PANEL_SOURCES: Record<string, string> = {
   "progress.md":
      "# Upgrade progress\n\n- [x] Bump dependencies\n- [x] Fix type errors\n- [ ] Run the e2e tests\n\n<details>\n<summary>Notes</summary>\n\nThe e2e suite needs a running dev server.\n\n</details>\n\n## Problems\n\n<details>\n<summary><b>1. Deployed image has no RLS</b> · turso (image) + platform · 🟡 needs a new image</summary>\n\nThe deployed image predates RLS. Rebuild and push it.\n\n- `Dockerfile` pins the old tag\n- CI does not rebuild on tag change\n\n</details>\n<details open>\n<summary>2. Policy statements are refused over Hrana · open</summary>\n\nThe server rejects `CREATE POLICY` before it reaches the engine.\n\n```sql\nCREATE POLICY own ON notes USING (owner = auth.uid());\n```\n\n</details>\n<details>\n<summary>3. Errors have no SQLSTATE · open</summary>\n\nClients cannot tell a constraint error from a syntax error.\n\n</details>\n",
   "todo.json": `${JSON.stringify(
      {
         root: {
            type: "Stack",
            children: [
               {
                  type: "Grid",
                  props: { columns: 3 },
                  children: [
                     {
                        type: "Stat",
                        props: { label: "Open", value: "3", icon: "alert", tone: "warning" },
                     },
                     {
                        type: "Stat",
                        props: { label: "Fixed", value: "2", icon: "check", tone: "success" },
                     },
                     {
                        type: "Stat",
                        props: { label: "Blocked", value: "1", icon: "lock", tone: "error" },
                     },
                  ],
               },
               {
                  type: "Accordion",
                  props: {
                     items: ["1. Image has no RLS", "2. Policy statements are refused"],
                     multiple: true,
                  },
                  children: [
                     { type: "Markdown", props: { text: "Rebuild and push the image." } },
                     {
                        type: "Markdown",
                        props: {
                           text: "The server rejects `CREATE POLICY` before it reaches the engine.",
                        },
                     },
                  ],
               },
            ],
         },
      },
      null,
      2,
   )}\n`,
   "fade.html":
      '<style>.b{padding:12px;border:1px solid var(--border);border-radius:8px;color:var(--foreground);animation:f 2s ease-in-out infinite alternate}@keyframes f{from{opacity:.4}to{opacity:1}}</style>\n<div class="b">Build: <b data-state="/build/status">-</b> <button id="done">Mark done</button></div>\n<script>document.getElementById("done").onclick=()=>harness.patch([{op:"add",path:"/build",value:{status:"done"}}]);</script>\n',
};
