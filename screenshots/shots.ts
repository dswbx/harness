import { expect, type Page } from "@playwright/test";

export type Shot = {
   /** Output: `docs/images/readme/<name>-dark.png` and `<name>-light.png`. */
   name: string;
   /** Page to open (default `/`). */
   path?: string;
   /** CSS px (default 1280x800). */
   viewport?: { width: number; height: number };
   /**
    * "window" (default): a macOS window frame with traffic lights. "none": the page draws its own card on a
    * transparent window (Quick overlay); the shot keeps the transparency.
    */
   frame?: "window" | "none";
   /** Brings the page into the state to capture. */
   setup?: (page: Page) => Promise<void>;
};

const MOCK_1 = "Split the router module";

/** Opens a Session from the sidebar by its title. */
async function openSession(page: Page, title: string) {
   await page
      .getByRole("complementary")
      .getByRole("button", { name: new RegExp(`^${title.replace(/[()]/g, "\\$&")}`) })
      .first()
      .click();
   // The header's title (a panel may show the same text as a heading too).
   await expect(page.getByRole("heading", { level: 1, name: title }).first()).toBeVisible();
}

/** Types a prompt into the composer and sends it. */
async function send(page: Page, text: string) {
   await page.getByRole("textbox", { name: "Message" }).first().click();
   await page.keyboard.type(text);
   await page.keyboard.press("Enter");
}

/** Opens a panel from the panel rails by its name. */
async function openPanel(page: Page, name: string) {
   await page.getByRole("button", { name, exact: true }).click();
}

/** Opens Settings on a section, over a Session. */
async function openSettings(page: Page, section: string) {
   await openSession(page, MOCK_1);
   await page.keyboard.press("Meta+Comma");
   await page.getByRole("dialog").getByRole("button", { name: section, exact: true }).click();
}

/** Scrolls the chat so the first element with `text` sits `gap` px below the chat's top edge. */
async function scrollChatTo(page: Page, text: string | RegExp, gap: number) {
   // Late layout (diagrams, images) first; then a wheel turn, so the chat stops keeping to the bottom.
   await page.waitForTimeout(800);
   const box = page.viewportSize()!;
   await page.mouse.move(box.width / 2, box.height / 2);
   await page.mouse.wheel(0, -40);
   await page
      .getByText(text, { exact: true })
      // The last match: the chat, not a title above it.
      .last()
      .evaluate((el, gap) => {
         const chat = el.closest("[data-radix-scroll-area-viewport]");
         if (chat)
            chat.scrollTop +=
               el.getBoundingClientRect().top - chat.getBoundingClientRect().top - gap;
      }, gap);
}

/** Scrolls the panel holding the first element with `text` so it sits `gap` px below the panel's top edge. */
async function scrollPanelTo(page: Page, text: string, gap: number) {
   await page.waitForTimeout(500);
   await page
      .getByText(text, { exact: true })
      .last()
      .evaluate((el, gap) => {
         const box = el.closest("[data-radix-scroll-area-viewport]");
         if (box)
            box.scrollTop += el.getBoundingClientRect().top - box.getBoundingClientRect().top - gap;
      }, gap);
}

export const SHOTS: Shot[] = [
   {
      name: "hero",
      setup: async (page) => {
         await openSession(page, MOCK_1);
         await expect(page.getByRole("region", { name: "Plan" })).toBeVisible();
      },
   },
   {
      name: "render-ui-state",
      setup: async (page) => {
         await openSession(page, "Rust lifetimes questions");
         await send(page, "/quiz Quiz me on Rust ownership");
         await page.getByText("Ownership", { exact: true }).last().click();
         await page.getByRole("button", { name: "Next" }).click();
      },
   },
   {
      name: "render-ui-card",
      setup: async (page) => {
         await openSession(page, "Hono route types");
         await send(page, "/card Show me the new screenshots");
         // The reply from its first card down.
         await scrollChatTo(page, "Build finished", 24);
      },
   },
   {
      name: "sub-sessions",
      setup: (page) => openSession(page, "Release prep across repos"),
   },
   {
      name: "side-chats",
      setup: async (page) => {
         await openSession(page, "Compact header layout");
         await openPanel(page, "Side chats");
         // The fixture's Side Thread starts closed: reopen it from the panel menu.
         await page.getByRole("button", { name: "Side chats options" }).click();
         await page.getByRole("menuitem", { name: "Past chats" }).click();
         // The submenu sits at the window's right edge, where a real click never settles in WebKit.
         await page.getByRole("menuitem", { name: /two rows/ }).dispatchEvent("click");
         await page.getByRole("button", { name: "Close New chat" }).click();
      },
   },
   {
      name: "new-session",
      setup: async (page) => {
         await openSession(page, MOCK_1);
         await page.getByRole("button", { name: "New Session", exact: true }).click();
         await expect(page.getByRole("dialog")).toBeVisible();
      },
   },
   {
      name: "changes",
      setup: async (page) => {
         await openSession(page, MOCK_1);
         await openPanel(page, "Changes");
         // The file with a review comment, its diff inline.
         await page
            .getByRole("region", { name: "Changes" })
            .getByRole("button", { name: /^router\.ts/ })
            .click();
         await scrollPanelTo(page, "Normalize once at registration instead.", 231);
      },
   },
   {
      name: "diff-window",
      path: "/?solo=1&session=mock-1&pane=diff",
      setup: async (page) => {
         // In Tauri the toolbar leaves room for the traffic lights (`pl-[92px]`); the browser does not.
         await page.addStyleTag({
            content: "[data-tauri-drag-region].pl-2 { padding-left: 92px !important; }",
         });
         await page.getByRole("treeitem", { name: /router\.ts/ }).click();
         await page
            .getByText("Normalize once at registration instead.")
            .first()
            .evaluate((el) => el.scrollIntoView({ block: "center" }));
      },
   },
   {
      name: "pull-requests",
      setup: async (page) => {
         await openSession(page, "Compact header layout");
         await send(page, "/prs What is the state of my open PRs?");
         await scrollChatTo(page, "Make the session header compact.", 24);
      },
   },
   {
      name: "artifacts",
      setup: async (page) => {
         await openSession(page, "Biome config cleanup");
         await send(page, "/artifacts Show the checkout flow and the flaky test runs");
         await openPanel(page, "Artifacts");
      },
   },
   {
      name: "tasks",
      setup: async (page) => {
         await page.getByRole("navigation", { name: "Tasks" }).getByRole("button").click();
      },
   },
   {
      name: "panels",
      setup: async (page) => {
         await openSession(page, MOCK_1);
         await page.keyboard.press("Meta+j");
         await openPanel(page, "Files");
         for (const name of ["src", "server", "router.ts"])
            await page.getByRole("treeitem", { name: new RegExp(`^${name}`) }).click();
         // The file gets the panel's full width.
         await page.getByRole("button", { name: "Show file tree" }).click();
         // A clean top edge: the chat from the second permission row down.
         await scrollChatTo(page, /^Edit\?/, 4);
      },
   },
   {
      name: "quick-overlay",
      path: "/?overlay=1",
      // The overlay's chat window: a 540x560 card and a 20 px shadow margin (`crates/harness-tauri/src/overlay`).
      viewport: { width: 580, height: 600 },
      frame: "none",
      setup: async (page) => {
         await send(page, "/artifacts Sketch the checkout flow");
         await scrollChatTo(page, "Sketch the checkout flow", 32);
      },
   },
   {
      name: "agents",
      setup: (page) => openSettings(page, "Agents"),
   },
   {
      name: "settings",
      setup: (page) => openSettings(page, "Appearance"),
   },
];
