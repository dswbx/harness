import {
  AlertTriangle, BarChart3, Bug, Calendar, Check, Clock, Code, Database, File, FlaskConical, Folder, GitBranch, GitCommitHorizontal,
  GitMerge, GitPullRequest, Globe, HelpCircle, Info, Key, Link, List, Lock, MessageSquare, Package, Rocket, Search, Server, Settings,
  Star, Terminal, User, Users, X, Zap, type LucideIcon,
} from "lucide-react";
import type { ICONS } from "./tools";

/** The `icon` prop's names (`ICONS` in tools.ts) -> lucide icons. */
export const uiIcons: Record<(typeof ICONS)[number], LucideIcon> = {
  check: Check, x: X, alert: AlertTriangle, info: Info, help: HelpCircle, file: File, folder: Folder, code: Code, terminal: Terminal,
  bug: Bug, test: FlaskConical, package: Package, "git-branch": GitBranch, "git-commit": GitCommitHorizontal, "git-pull-request": GitPullRequest,
  "git-merge": GitMerge, rocket: Rocket, server: Server, database: Database, globe: Globe, lock: Lock, key: Key, user: User, users: Users,
  clock: Clock, calendar: Calendar, search: Search, link: Link, settings: Settings, star: Star, zap: Zap, list: List, message: MessageSquare,
  chart: BarChart3,
};
