import { agentsHandlers } from "./agents";
import { commentsHandlers } from "./comments";
import { frontendFilesHandlers } from "./frontendFiles";
import { gitHandlers } from "./git";
import { noteHandlers } from "./note";
import { promptHandlers } from "./prompt";
import { prsHandlers } from "./prs";
import { sessionsHandlers } from "./sessions";
import { settingsHandlers } from "./settings";
import { sharedHandlers } from "./shared";
import { tasksHandlers } from "./tasks";
import { terminalHandlers } from "./terminal";
import { threadsHandlers } from "./threads";
import type { Handlers } from "./types";

export const handlers: Handlers = {
   ...agentsHandlers,
   ...sessionsHandlers,
   ...gitHandlers,
   ...prsHandlers,
   ...sharedHandlers,
   ...tasksHandlers,
   ...noteHandlers,
   ...commentsHandlers,
   ...terminalHandlers,
   ...frontendFilesHandlers,
   ...threadsHandlers,
   ...promptHandlers,
   ...settingsHandlers,
};
