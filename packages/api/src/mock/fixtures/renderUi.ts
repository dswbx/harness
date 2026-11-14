/** A placeholder screenshot (SVG source) for the mock. */
export function mockImage(label: string, hue: number): string {
   return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 55%)"/><stop offset="1" stop-color="hsl(${hue + 40} 70% 35%)"/></linearGradient></defs><rect width="1280" height="800" fill="url(#g)"/><text x="640" y="420" font-family="sans-serif" font-size="56" fill="white" text-anchor="middle">${label}</text></svg>`;
}

/** A `render_ui` input showing most components; `srcs` are the carousel's images. */
export function mockRenderUi(srcs: string[]) {
   return {
      root: {
         type: "Stack",
         children: [
            {
               type: "Card",
               props: { title: "Build finished", tone: "success" },
               children: [
                  { type: "Markdown", props: { text: "All **3** checks passed." } },
                  {
                     type: "KeyValue",
                     props: {
                        items: [
                           { label: "Duration", value: "12s" },
                           { label: "Branch", value: "main" },
                        ],
                     },
                  },
                  {
                     type: "Stack",
                     props: { direction: "horizontal", gap: "sm" },
                     children: [
                        { type: "Badge", props: { text: "lint", tone: "success" } },
                        { type: "Badge", props: { text: "types", tone: "success" } },
                        { type: "Badge", props: { text: "1 flaky test", tone: "warning" } },
                     ],
                  },
               ],
            },
            {
               type: "Stack",
               props: { direction: "horizontal" },
               children: [
                  {
                     type: "Card",
                     props: { title: "read_to_string", tone: "info" },
                     children: [
                        {
                           type: "Markdown",
                           props: {
                              text: "Reads the whole file into a `String`. Best for small files.",
                           },
                        },
                        {
                           type: "Code",
                           props: {
                              language: "rust",
                              code: 'let s = fs::read_to_string("data.txt")?;',
                           },
                        },
                     ],
                  },
                  {
                     type: "Card",
                     props: { title: "BufReader", tone: "success" },
                     children: [
                        { type: "Markdown", props: { text: "Reads one line at a time." } },
                        {
                           type: "Code",
                           props: {
                              language: "rust",
                              code: 'for l in BufReader::new(f).lines() {\n    println!("{}", l?);\n}',
                           },
                        },
                     ],
                  },
               ],
            },
            {
               type: "Table",
               props: {
                  columns: ["Page", "Before", "After"],
                  rows: [
                     ["Home", "1.8s", "0.9s"],
                     ["Settings", "1.2s", "0.7s"],
                  ],
               },
            },
            {
               type: "Carousel",
               props: {
                  images: srcs.map((src, i) => ({
                     src,
                     alt: `Screenshot ${i + 1}`,
                     caption: `Screenshot ${i + 1} of ${srcs.length}`,
                  })),
               },
            },
         ],
      },
   };
}
