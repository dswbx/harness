import { webLink, wouldLoop } from "../../derive/tasks";
import { CommandError } from "../../errors";
import type {
   AttachmentInput,
   Task,
   TaskActivityKind,
   TaskAsset,
   TaskDep,
   TaskStatus,
   TaskSummary,
   TaskUpstream,
} from "../../generated";
import type { MockTransport } from "../mock";
import type { Handlers } from "./types";

// The core's Task store (`tasks.rs`), in memory.

export function mockTask(mock: MockTransport, id: string): Task {
   const t = mock.tasks.get(id);
   if (!t) throw new CommandError("not_found", `no task "${id}"`);
   return t;
}

function summary(t: Task): TaskSummary {
   const { body, activity: _a, body_updated_ms: _b, v: _v, ...rest } = t;
   return structuredClone({
      ...rest,
      has_body: body.trim() !== "",
      excerpt: excerpt(body),
      deps: rest.deps ?? [],
      props: rest.props ?? {},
   });
}

/** Roughly the core's excerpt: the body as plain text, cut at a word to 160 chars with "…". */
function excerpt(body: string): string {
   const text = body
      .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^[ \t]*(>[ \t]*)*(#{1,6}[ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)?/gm, "")
      .replace(/[*`~]|(?<!\w)_+|_+(?!\w)/g, "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
   const chars = [...text];
   if (chars.length <= 160) return text;
   const cut = chars.slice(0, 159).join("");
   const at = chars[159] === " " ? cut.length : cut.lastIndexOf(" ");
   return `${at > 0 ? cut.slice(0, at) : cut}…`;
}

function cleanTitle(title: string): string {
   const t = title.split(/\s+/).filter(Boolean).join(" ");
   if (!t) throw new CommandError("invalid", "a title is required");
   return t;
}

function checkDue(due: string): string {
   const d = due.trim();
   if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d))
      throw new CommandError("invalid", `"${d}" is not a date (YYYY-MM-DD)`);
   return d;
}

/** As the core's `check_upstream`: an `http(s)://` link; `null` for an empty url. */
function checkUpstream(u: TaskUpstream | null | undefined): TaskUpstream | null {
   const url = u?.url.trim();
   if (!url) return null;
   if (webLink(url) !== url)
      throw new CommandError(
         "invalid",
         `the upstream url "${url}" is not a web link: it must start with https:// or http://`,
      );
   return { url, label: u?.label?.trim() || null };
}

/** As the core's `check_deps`: each other task exists once, and none leads back to `id` ("" for a new task). */
function checkDeps(mock: MockTransport, id: string, deps: TaskDep[]): TaskDep[] {
   const all = [...mock.tasks.values()].map((t) => ({ id: t.id, deps: t.deps ?? [] }));
   deps.forEach((d, i) => {
      if (id && d.id === id)
         throw new CommandError("invalid", `task ${id} cannot depend on itself`);
      if (deps.slice(0, i).some((e) => e.id === d.id))
         throw new CommandError("invalid", `task ${d.id} is listed twice in deps`);
      if (!mock.tasks.has(d.id)) throw new CommandError("not_found", `no task "${d.id}"`);
      if (id && wouldLoop(all, id, d.id))
         throw new CommandError(
            "invalid",
            `task ${id} cannot depend on task ${d.id}: it would make a loop`,
         );
   });
   return deps.map((d) => ({ id: d.id, kind: d.kind }));
}

/** As the core's `clean_props`: keys 1-32 of `a-z0-9_-`, values 1-64 chars on one line, at most 16. */
function cleanProps(props: Record<string, string>): Record<string, string> {
   const entries = Object.entries(props);
   if (entries.length > 16)
      throw new CommandError("invalid", `a task has at most 16 props, not ${entries.length}`);
   return Object.fromEntries(
      entries.map(([k, raw]) => {
         if (!/^[a-z0-9_-]{1,32}$/.test(k))
            throw new CommandError(
               "invalid",
               `the prop key "${k}" must be 1-32 characters of a-z, 0-9, _ and -`,
            );
         const v = raw.trim();
         if (!v || [...v].length > 64 || /[\r\n]/.test(v))
            throw new CommandError(
               "invalid",
               `the value of prop "${k}" must be 1-64 characters on one line`,
            );
         return [k, v];
      }),
   );
}

/** A time after the Task's last change. */
const stamp = (t: Task) => Math.max(Date.now(), t.updated_ms + 1);

function record(t: Task, at: number, kind: TaskActivityKind, sessionId: string | null = null) {
   t.activity.push({ at_ms: at, by: "user", session_id: sessionId, kind });
   if (t.activity.length > 100) t.activity.splice(0, t.activity.length - 100);
}

function siblings(mock: MockTransport, parent: string | null, except: string): Task[] {
   return [...mock.tasks.values()]
      .filter((t) => t.parent_id === parent && t.id !== except)
      .sort((a, b) => a.order - b.order);
}

function lastOrder(mock: MockTransport, parent: string | null, except: string): number {
   const last = siblings(mock, parent, except).at(-1);
   return last ? last.order + 1 : 1;
}

function descendsFrom(mock: MockTransport, id: string, ancestor: string): boolean {
   let at = mock.tasks.get(id)?.parent_id ?? null;
   for (let i = 0; at && i <= mock.tasks.size; i++) {
      if (at === ancestor) return true;
      at = mock.tasks.get(at)?.parent_id ?? null;
   }
   return false;
}

/** `TasksChanged` with the current summaries of the `ids` that still exist. */
function changed(mock: MockTransport, ids: string[]) {
   const tasks = ids.flatMap((id) => {
      const t = mock.tasks.get(id);
      return t ? [summary(t)] : [];
   });
   mock.emitApp({ type: "TasksChanged", ids, tasks });
}

const mimeOf = (name: string) =>
   /\.(png|jpe?g|gif|webp)$/i.test(name)
      ? `image/${name.split(".").pop()?.toLowerCase().replace("jpg", "jpeg")}`
      : "application/octet-stream";

function asset(input: AttachmentInput): { name: string; mime: string; data: string } {
   if (input.type === "data") return { name: input.name, mime: input.mime, data: input.data };
   // Path inputs have no bytes in the browser.
   const name = input.path.split("/").pop() || "file";
   return { name, mime: mimeOf(name), data: "" };
}

function freeName(assets: TaskAsset[], raw: string): string {
   const name = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "file";
   const taken = (n: string) => assets.some((a) => a.name === n);
   if (!taken(name)) return name;
   const dot = name.lastIndexOf(".");
   const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
   for (let n = 2; ; n++) if (!taken(`${stem}-${n}${ext}`)) return `${stem}-${n}${ext}`;
}

/** "Start Session from a task" (`Tasks::link_session`): the link, and the status set once. */
export function linkSessionTask(
   mock: MockTransport,
   id: string,
   sessionId: string,
   title: string,
   status: TaskStatus | null,
) {
   const t = mockTask(mock, id);
   const now = stamp(t);
   t.sessions.push({ session_id: sessionId, title, started_ms: now });
   record(t, now, { type: "session_started", session_id: sessionId });
   if (status && status !== t.status) {
      record(t, now, { type: "status_changed", from: t.status, to: status });
      t.status = status;
   }
   t.updated_ms = now;
   changed(mock, [id]);
}

/** Removes a deleted Session from every Task's `sessions`, and tells which Tasks changed. */
export function forgetSessionTasks(mock: MockTransport, sessionId: string) {
   const ids: string[] = [];
   for (const t of mock.tasks.values()) {
      if (!t.sessions.some((l) => l.session_id === sessionId)) continue;
      t.sessions = t.sessions.filter((l) => l.session_id !== sessionId);
      ids.push(t.id);
   }
   if (ids.length) changed(mock, ids);
}

export const tasksHandlers = {
   ListTasks: (mock) => ({
      type: "Tasks",
      tasks: [...mock.tasks.values()]
         .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)))
         .map(summary),
   }),
   ReadTask: (mock, cmd) => ({ type: "Task", task: structuredClone(mockTask(mock, cmd.id)) }),
   CreateTask: (mock, cmd) => {
      const title = cleanTitle(cmd.title);
      const due = cmd.due ? checkDue(cmd.due) : null;
      const upstream = checkUpstream(cmd.upstream);
      const parent = cmd.parent_id ?? null;
      if (parent) mockTask(mock, parent);
      const origin = cmd.session_id ? mock.session(cmd.session_id) : null;
      const deps = checkDeps(mock, "", cmd.deps ?? []);
      const props = cleanProps(cmd.props ?? {});
      const id = `t${mock.taskN++}`;
      const now = Date.now();
      const t: Task = {
         v: 1,
         id,
         title,
         body: cmd.body ?? "",
         status: cmd.status ?? "todo",
         priority: cmd.priority ?? "none",
         due,
         upstream,
         parent_id: parent,
         order: lastOrder(mock, parent, id),
         origin_session_id: origin?.id ?? null,
         origin_title: origin?.title ?? null,
         sessions: [],
         assets: [],
         created_ms: now,
         updated_ms: now,
         body_updated_ms: now,
         activity: [],
         deps,
         props,
      };
      record(t, now, { type: "created" }, origin?.id ?? null);
      mock.tasks.set(id, t);
      changed(mock, [id]);
      return { type: "Task", task: structuredClone(t) };
   },
   UpdateTask: (mock, cmd) => {
      const t = mockTask(mock, cmd.id);
      const p = cmd.patch;
      const title = p.title != null ? cleanTitle(p.title) : null;
      const due = p.due != null ? checkDue(p.due) : null;
      const upstream = checkUpstream(p.upstream);
      const deps = p.deps ? checkDeps(mock, t.id, p.deps) : null;
      const props = p.props ? cleanProps(p.props) : null;
      const now = stamp(t);
      if (p.body != null && p.body !== t.body) {
         const base = cmd.base_updated_ms;
         if (base != null && t.body_updated_ms > base)
            throw new CommandError(
               "conflict",
               `the body of task ${t.id} changed elsewhere: reload it`,
            );
         t.body = p.body;
         t.body_updated_ms = now;
      }
      for (const f of p.clear ?? []) {
         if (f === "due") t.due = null;
         else t.upstream = null;
      }
      if (title) t.title = title;
      if (due) t.due = due;
      if (upstream) t.upstream = upstream;
      if (p.priority) t.priority = p.priority;
      if (p.status && p.status !== t.status) {
         record(t, now, { type: "status_changed", from: t.status, to: p.status });
         t.status = p.status;
      }
      if (deps) {
         const old = t.deps ?? [];
         for (const d of old)
            if (!deps.some((n) => n.id === d.id)) record(t, now, { type: "dep_removed", id: d.id });
         for (const d of deps)
            if (!old.some((o) => o.id === d.id && o.kind === d.kind))
               record(t, now, { type: "dep_added", id: d.id, kind: d.kind });
         t.deps = deps;
      }
      if (props && JSON.stringify(props) !== JSON.stringify(t.props ?? {})) {
         record(t, now, { type: "props_changed" });
         t.props = props;
      }
      t.updated_ms = now;
      changed(mock, [t.id]);
      return { type: "Task", task: structuredClone(t) };
   },
   MoveTask: (mock, cmd) => {
      const t = mockTask(mock, cmd.id);
      const parent = cmd.parent_id ?? null;
      if (parent) {
         mockTask(mock, parent);
         if (parent === t.id || descendsFrom(mock, parent, t.id))
            throw new CommandError(
               "invalid",
               `task ${t.id} cannot move under itself or one of its subtasks`,
            );
      }
      let order: number;
      if (cmd.before) {
         const list = siblings(mock, parent, t.id);
         const at = list.findIndex((s) => s.id === cmd.before);
         const next = list[at];
         if (!next)
            throw new CommandError(
               "invalid",
               `task ${cmd.before} is not under ${parent ? `task ${parent}` : "the top level"}`,
            );
         const prev = list[at - 1];
         order = prev ? (prev.order + next.order) / 2 : next.order - 1;
      } else order = lastOrder(mock, parent, t.id);
      const now = stamp(t);
      if (t.parent_id !== parent) {
         record(t, now, { type: "moved", from: t.parent_id, to: parent });
         t.parent_id = parent;
      }
      t.order = order;
      t.updated_ms = now;
      changed(mock, [t.id]);
      return { type: "Task", task: structuredClone(t) };
   },
   DeleteTask: (mock, cmd) => {
      const t = mockTask(mock, cmd.id);
      const base = lastOrder(mock, t.parent_id, t.id);
      const kids = siblings(mock, t.id, "");
      kids.forEach((c, i) => {
         const now = stamp(c);
         record(c, now, { type: "moved", from: t.id, to: t.parent_id });
         c.parent_id = t.parent_id;
         c.order = base + i;
         c.updated_ms = now;
      });
      mock.tasks.delete(t.id);
      // The id leaves the deps of other tasks.
      const unlinked: string[] = [];
      for (const o of mock.tasks.values()) {
         if (!o.deps?.some((d) => d.id === t.id)) continue;
         o.deps = o.deps.filter((d) => d.id !== t.id);
         o.updated_ms = stamp(o);
         unlinked.push(o.id);
      }
      for (const k of mock.taskAssets.keys())
         if (k.startsWith(`${t.id}/`)) mock.taskAssets.delete(k);
      changed(mock, [...new Set([t.id, ...kids.map((c) => c.id), ...unlinked])]);
      return { type: "Ok" };
   },
   AddTaskAssets: (mock, cmd) => {
      const t = mockTask(mock, cmd.id);
      if (cmd.files.length === 0) throw new CommandError("invalid", "no files");
      for (const f of cmd.files) {
         const a = asset(f);
         const name = freeName(t.assets, a.name);
         mock.taskAssets.set(`${t.id}/${name}`, { mime: a.mime, data: a.data });
         t.assets.push({ name, mime: a.mime, size: Math.floor((a.data.length * 3) / 4) });
      }
      t.updated_ms = stamp(t);
      changed(mock, [t.id]);
      return { type: "Task", task: structuredClone(t) };
   },
   RemoveTaskAsset: (mock, cmd) => {
      const t = mockTask(mock, cmd.id);
      if (!t.assets.some((a) => a.name === cmd.name))
         throw new CommandError("not_found", `task ${t.id} has no file "${cmd.name}"`);
      t.assets = t.assets.filter((a) => a.name !== cmd.name);
      mock.taskAssets.delete(`${t.id}/${cmd.name}`);
      t.updated_ms = stamp(t);
      changed(mock, [t.id]);
      return { type: "Task", task: structuredClone(t) };
   },
   ReadTaskAsset: (mock, cmd) => {
      const t = mockTask(mock, cmd.id);
      const a = t.assets.find((x) => x.name === cmd.name);
      if (!a) throw new CommandError("not_found", `task ${t.id} has no file "${cmd.name}"`);
      const stored = mock.taskAssets.get(`${t.id}/${cmd.name}`);
      return { type: "Attachment", mime: a.mime, data: stored?.data ?? "" };
   },
} satisfies Partial<Handlers>;
