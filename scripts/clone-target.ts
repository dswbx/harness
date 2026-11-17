// post-checkout hook (lefthook): a new worktree starts with a copy-on-write clone (APFS `cp -c`) of the most recently built `target/` among the other worktrees, so cargo rebuilds only the workspace crates, not all ~600 deps. Clones share disk blocks until they diverge.
// Not a shared target or build dir: cargo fingerprints workspace crates by relative path + mtime, so worktrees sharing one would silently reuse each other's stale artifacts.
// Never fails the checkout.
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

try {
   const root = process.cwd();
   if (process.platform !== "darwin" || existsSync(join(root, "target"))) process.exit(0);

   const list = Bun.spawnSync(["git", "worktree", "list", "--porcelain"]).stdout.toString();
   const source = list
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .filter((p) => resolve(p) !== resolve(root))
      .map((p) => join(p, "target"))
      .filter((t) => existsSync(join(t, "debug", ".fingerprint")))
      .map((t) => ({ t, mtime: statSync(join(t, "debug")).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0]?.t;
   if (!source) process.exit(0);

   const cp = Bun.spawnSync(["cp", "-cR", source, join(root, "target")]);
   console.log(
      cp.success
         ? `target/: cloned from ${source}`
         : `target/: clone failed, cargo builds from scratch`,
   );
} catch {}
