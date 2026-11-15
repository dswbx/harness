// Browser mock: not part of the `@harness/api` entry, so production bundles load it lazily (`@harness/api/mock`).
//
// Magic prompts the mock reacts to (a Main Thread prompt, matched after trim; see `handlers/prompt.ts`):
//   /readonly      the Agent lost its session: the Thread turns read-only
//   /restorefail   a resume fails once; the next try works
//   /apprestart    the app was reopened: the Agent process is gone
//   /unsaved       the Session Log cannot be written (toast); again: it can be
//   /auth          the Agent needs sign-in (AuthRequired)
//   /quiz          a practice test built with Session State and slots (render_ui)
//   /artifacts     a reply with a diagram, a table and a pull request (Artifacts panel)
//   /prs           a reply with PR references in every form (chips, one batched lookup)
//   /card          a render_ui call with local images
// Anywhere in a prompt: "attention" leaves the Session needing attention; in a Side Thread, "edit" asks for a permission.
export { mockImage, mockRenderUi } from "./fixtures/renderUi";
export { MockTransport } from "./mock";
