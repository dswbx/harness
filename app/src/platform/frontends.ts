import type { Frontend, FrontendToggle } from "@harness/api";
import { registry } from "./registry";

const all = (): Frontend[] => Object.values(registry);

/** The Frontend that renders Shared Artifacts (they have no Session): the first one in the registry that can. */
export const sharedView = () => all().find((fe) => fe.SharedView)?.SharedView;

/** The Frontend that renders the All tasks view (ADR 0028): the first one in the registry that can. */
export const tasksView = () => all().find((fe) => fe.TasksView)?.TasksView;

/** The Frontend's component catalog page, if any Frontend has one. */
export const gallery = () => all().find((fe) => fe.Gallery)?.Gallery;

/** The preference switches the Frontends offer for an Appearance `group`. */
export const frontendToggles = (group: FrontendToggle["group"]): FrontendToggle[] =>
   all().flatMap((fe) => fe.toggles?.filter((t) => t.group === group) ?? []);
