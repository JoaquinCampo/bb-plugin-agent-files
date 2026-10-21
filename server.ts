// bb-plugin-agent-files — which files a thread's agents read, edit, and search.
//
// The thread event log already carries every file touch as a normalized item:
// `fileRead`, `fileChange`, `search`, plus raw `toolCall`s for providers that
// don't normalize. Subagent calls live in the same log, tagged with
// `parentToolCallId` → the `delegation` item that started them. Child BB
// threads have their own logs and are merged in at query time.
//
// The index is incremental: each thread keeps a seq cursor in kv, and only
// events after it are parsed. Threads are indexed once their panel is opened
// (or a parent's is); after that every event batch keeps them current and
// publishes a realtime signal so open panels refetch.
import { homedir } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

type TouchKind = "read" | "edit" | "search";

/** One file's activity inside one thread. Keyed by absolute path. */
interface FileStats {
  reads: number;
  edits: number;
  searches: number;
  lastAt: number;
  lastKind: TouchKind;
  /** Actor labels: "Main agent" or a subagent's label. */
  actors: string[];
}

interface PendingTouch {
  paths: string[];
  kind: TouchKind;
  actor: string;
  startedAt: number;
}

interface RecentTouch {
  at: number;
  kind: TouchKind;
  path: string;
  actor: string;
}

interface ThreadIndex {
  version: 2;
  cursor: number;
  files: Record<string, FileStats>;
  /** In-flight items by item id; cleared on completion or when the thread stops. */
  pending: Record<string, PendingTouch>;
  /** delegation item id → subagent label. */
  delegations: Record<string, string>;
  /** The latest touches, oldest first; drives the "now" line and the activity strip. */
  recent: RecentTouch[];
}

const MAIN_ACTOR = "Main agent";
const MAX_FILES = 1500;
const MAX_RECENT = 80;
const MAX_TREE_PATHS = 5000;
const PAGE = 100;
const ITEM_EVENT_TYPES = ["item/started", "item/completed"] as const;

const fileTargetSchema = z.union([
  z.object({ kind: z.literal("workspace"), environmentId: z.string(), path: z.string() }),
  z.object({ kind: z.literal("host"), hostId: z.string(), path: z.string() }),
]);

const fileActivitySchema = z.object({
  key: z.string(),
  name: z.string(),
  dir: z.string(),
  target: fileTargetSchema.nullable(),
  threadId: z.string(),
  threadTitle: z.string(),
  /** Path relative to the thread's worktree, or null when the file is outside it. */
  rel: z.string().nullable(),
  reads: z.number(),
  edits: z.number(),
  searches: z.number(),
  heat: z.number(),
  lastAt: z.number(),
  lastKind: z.enum(["read", "edit", "search"]),
  active: z.enum(["read", "edit", "search"]).nullable(),
  actors: z.array(z.string()),
});
export type FileActivity = z.infer<typeof fileActivitySchema>;

const recentSchema = z.object({
  at: z.number(),
  kind: z.enum(["read", "edit", "search"]),
  actor: z.string(),
  key: z.string(),
  label: z.string(),
  pending: z.boolean(),
});
export type RecentActivity = z.infer<typeof recentSchema>;

const activitySchema = z.object({
  threadIds: z.array(z.string()),
  files: z.array(fileActivitySchema),
  actors: z.array(z.string()),
  recent: z.array(recentSchema),
});
export type ThreadActivity = z.infer<typeof activitySchema>;

const treeSchema = z.object({
  environmentId: z.string().nullable(),
  rootName: z.string(),
  files: z.array(z.string()),
  dirs: z.array(z.string()),
  truncated: z.boolean(),
});
export type WorkspaceTree = z.infer<typeof treeSchema>;

const threadInput = z.object({ threadId: z.string().min(1).max(100) });

export const rpcContract = defineRpcContract({
  thread_activity: { input: threadInput, output: activitySchema },
  thread_tree: { input: threadInput, output: treeSchema },
});

/** Realtime channel; payload `{ threadId }` of the thread whose index changed. */
export const ACTIVITY_CHANGED = "activity-changed";

// ---------------------------------------------------------------------------
// Parsing: pure functions over untrusted event JSON.

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

interface Touch {
  itemId: string;
  phase: "started" | "completed";
  status: string;
  kind: TouchKind;
  paths: string[];
  parentToolCallId: string | null;
}

const READ_TOOLS = new Set(["Read", "read_file", "view"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "write_file", "edit_file"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "grep", "glob", "search_files"]);

/** Extract a file touch from one item event, or null if the item isn't one. */
export function parseTouch(eventType: string, data: unknown): Touch | null {
  if (!isObj(data) || !isObj(data.item)) return null;
  const item = data.item;
  const itemId = str(item.id);
  if (itemId === null) return null;
  const phase = eventType === "item/started" ? "started" : "completed";
  const base = {
    itemId,
    phase,
    status: str(item.status) ?? "completed",
    parentToolCallId: str(item.parentToolCallId),
  } as const;

  switch (item.type) {
    case "fileRead": {
      const path = str(item.path);
      return path === null ? null : { ...base, kind: "read", paths: [path] };
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.flatMap((c) => (isObj(c) && str(c.path) ? [c.path as string] : []));
      return paths.length === 0 ? null : { ...base, kind: "edit", paths };
    }
    case "search": {
      const path = str(item.path);
      return path === null ? null : { ...base, kind: "search", paths: [path] };
    }
    case "toolCall": {
      const tool = str(item.tool) ?? "";
      const args = isObj(item.arguments) ? item.arguments : {};
      const path = str(args.file_path) ?? str(args.notebook_path) ?? str(args.path);
      if (path === null) return null;
      if (READ_TOOLS.has(tool)) return { ...base, kind: "read", paths: [path] };
      if (EDIT_TOOLS.has(tool)) return { ...base, kind: "edit", paths: [path] };
      if (SEARCH_TOOLS.has(tool)) return { ...base, kind: "search", paths: [path] };
      return null;
    }
  }
  return null;
}

/** A delegation (subagent start) item: id → label. */
export function parseDelegation(data: unknown): { id: string; label: string } | null {
  if (!isObj(data) || !isObj(data.item) || data.item.type !== "delegation") return null;
  const id = str(data.item.id);
  if (id === null) return null;
  return { id, label: str(data.item.label) ?? "Subagent" };
}

export function emptyIndex(): ThreadIndex {
  return { version: 2, cursor: 0, files: {}, pending: {}, delegations: {}, recent: [] };
}

/** Fold one event into the index. Counts on start so in-flight work shows at once. */
export function applyEvent(index: ThreadIndex, eventType: string, data: unknown, at: number): void {
  const delegation = parseDelegation(data);
  if (delegation !== null) {
    index.delegations[delegation.id] = delegation.label;
    return;
  }
  const touch = parseTouch(eventType, data);
  if (touch === null) return;
  const actor =
    touch.parentToolCallId === null
      ? MAIN_ACTOR
      : (index.delegations[touch.parentToolCallId] ?? "Subagent");

  if (touch.phase === "started") {
    index.pending[touch.itemId] = { paths: touch.paths, kind: touch.kind, actor, startedAt: at };
    for (const path of touch.paths) bump(index, path, touch.kind, actor, at);
    return;
  }
  const wasPending = index.pending[touch.itemId] !== undefined;
  delete index.pending[touch.itemId];
  // A completion with no start (e.g. history before the cursor) still counts once.
  if (!wasPending && touch.status !== "failed") {
    for (const path of touch.paths) bump(index, path, touch.kind, actor, at);
  }
}

function bump(index: ThreadIndex, path: string, kind: TouchKind, actor: string, at: number): void {
  const stats = (index.files[path] ??= {
    reads: 0,
    edits: 0,
    searches: 0,
    lastAt: at,
    lastKind: kind,
    actors: [],
  });
  if (kind === "read") stats.reads += 1;
  else if (kind === "edit") stats.edits += 1;
  else stats.searches += 1;
  stats.lastAt = at;
  stats.lastKind = kind;
  if (!stats.actors.includes(actor)) stats.actors.push(actor);
  index.recent.push({ at, kind, path, actor });
  if (index.recent.length > MAX_RECENT) index.recent.splice(0, index.recent.length - MAX_RECENT);
}

/** Keep the stored value bounded: drop the least recently touched files. */
function trim(index: ThreadIndex): void {
  const paths = Object.keys(index.files);
  if (paths.length <= MAX_FILES) return;
  paths
    .sort((a, b) => index.files[a]!.lastAt - index.files[b]!.lastAt)
    .slice(0, paths.length - MAX_FILES)
    .forEach((p) => delete index.files[p]);
}

/** Shorten a directory outside the workspace: ~ for home, keep the last segments. */
export function shortDir(dir: string, home = homedir()): string {
  const tilde = dir === home || dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir;
  const parts = tilde.split("/");
  return parts.length <= 4 ? tilde : `${parts[0] || "/"}/…/${parts.slice(-2).join("/")}`.replace("//", "/");
}

export const heatOf = (s: { reads: number; edits: number; searches: number }) =>
  s.reads + 2 * s.edits + s.searches;

// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const kvKey = (threadId: string) => `thread:${threadId}`;
  const envRoots = new Map<string, { root: string; hostId: string } | null>();

  async function load(threadId: string): Promise<ThreadIndex | null> {
    const stored = await bb.storage.kv.get<ThreadIndex>(kvKey(threadId));
    return stored?.version === 2 ? stored : null;
  }

  /** Run index mutations for one thread one at a time. */
  const locks = new Map<string, Promise<unknown>>();
  function locked<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const prev = locks.get(threadId) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.catch(() => undefined);
    locks.set(threadId, tail);
    void tail.then(() => {
      if (locks.get(threadId) === tail) locks.delete(threadId);
    });
    return next;
  }

  /** Parse every event after the cursor, then optionally adjust and save. */
  function sync(threadId: string, after?: (index: ThreadIndex) => void): Promise<ThreadIndex> {
    return locked(threadId, async () => {
      const index = (await load(threadId)) ?? emptyIndex();
      const before = JSON.stringify([index.cursor, Object.keys(index.pending).length]);
      const isNew = index.cursor === 0;
      for (;;) {
        const rows = await bb.sdk.threads.events.list({
          threadId,
          afterSeq: String(index.cursor),
          limit: String(PAGE),
          order: "asc",
          types: [...ITEM_EVENT_TYPES],
        });
        for (const row of rows) {
          applyEvent(index, row.type, row.data, row.createdAt);
          index.cursor = Math.max(index.cursor, row.seq);
        }
        if (rows.length < PAGE) break;
      }
      after?.(index);
      const changed = JSON.stringify([index.cursor, Object.keys(index.pending).length]) !== before;
      if (changed || isNew) {
        trim(index);
        await bb.storage.kv.set(kvKey(threadId), index);
      }
      return index;
    });
  }

  async function envRoot(environmentId: string | null) {
    if (environmentId === null) return null;
    if (!envRoots.has(environmentId)) {
      try {
        const env = await bb.sdk.environments.get({ environmentId });
        const e = env as unknown as { path?: string; hostId?: string; environment?: { path?: string; hostId?: string } };
        const path = e.path ?? e.environment?.path;
        const hostId = e.hostId ?? e.environment?.hostId;
        envRoots.set(environmentId, path && hostId ? { root: path.replace(/\/+$/, ""), hostId } : null);
      } catch (error) {
        bb.log.warn(`environment lookup failed for ${environmentId}: ${String(error)}`);
        envRoots.set(environmentId, null);
      }
    }
    return envRoots.get(environmentId) ?? null;
  }

  async function threadActivity(threadId: string): Promise<ThreadActivity> {
    const descendants = await bb.sdk.threads.experimental_listDescendants({
      threadIds: [threadId],
      includeHidden: true,
    });
    const childIds = descendants.threads.find((t) => t.threadId === threadId)?.descendantIds ?? [];
    const threadIds = [threadId, ...childIds];

    const files: FileActivity[] = [];
    const actors = new Set<string>();
    const recent: RecentActivity[] = [];
    for (const id of threadIds) {
      const [thread, index] = await Promise.all([bb.sdk.threads.get({ threadId: id }), sync(id)]);
      const t = (thread as unknown as { thread?: typeof thread }).thread ?? thread;
      const isRoot = id === threadId;
      const threadTitle = t.title ?? t.titleFallback ?? id;
      const env = await envRoot(t.environmentId);
      const active = new Map<string, TouchKind>();
      for (const p of Object.values(index.pending)) for (const path of p.paths) active.set(path, p.kind);
      const relOf = (path: string) =>
        env !== null && (path === env.root || path.startsWith(env.root + "/"))
          ? path.slice(env.root.length + 1) || "."
          : null;
      const pendingKeys = new Set(
        Object.values(index.pending).flatMap((p) => p.paths.map((path) => `${p.actor}:${path}`)),
      );
      for (const r of index.recent) {
        recent.push({
          at: r.at,
          kind: r.kind,
          actor: isRoot ? r.actor : `Thread: ${threadTitle}`,
          key: `${id}:${r.path}`,
          label: relOf(r.path) ?? r.path.replace(homedir(), "~"),
          pending: pendingKeys.has(`${r.actor}:${r.path}`),
        });
      }

      for (const [path, stats] of Object.entries(index.files)) {
        const inside = env !== null && (path === env.root || path.startsWith(env.root + "/"));
        const rel = inside ? path.slice(env.root.length + 1) || "." : path;
        const slash = rel.lastIndexOf("/");
        const fileActors = isRoot ? stats.actors : [`Thread: ${threadTitle}`];
        fileActors.forEach((a) => actors.add(a));
        files.push({
          key: `${id}:${path}`,
          name: slash === -1 ? rel : rel.slice(slash + 1),
          dir: slash === -1 ? (inside ? "" : "/") : inside ? rel.slice(0, slash) : shortDir(rel.slice(0, slash)),
          target:
            env === null
              ? null
              : inside
                ? { kind: "workspace", environmentId: t.environmentId!, path: rel }
                : { kind: "host", hostId: env.hostId, path },
          threadId: id,
          threadTitle,
          rel: inside ? rel : null,
          reads: stats.reads,
          edits: stats.edits,
          searches: stats.searches,
          heat: heatOf(stats),
          lastAt: stats.lastAt,
          lastKind: stats.lastKind,
          active: active.get(path) ?? null,
          actors: fileActors,
        });
      }
    }
    recent.sort((a, b) => a.at - b.at);
    // A pending touch stays pending only on its most recent occurrence.
    const seen = new Set<string>();
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i]!;
      const k = `${r.actor}:${r.key}`;
      if (seen.has(k)) r.pending = false;
      seen.add(k);
    }
    return { threadIds, files, actors: [...actors], recent: recent.slice(-MAX_RECENT) };
  }

  /** The worktree's paths (Git-ignore aware), cached briefly per environment. */
  const treeCache = new Map<string, { at: number; tree: WorkspaceTree }>();
  async function threadTree(threadId: string): Promise<WorkspaceTree> {
    const thread = await bb.sdk.threads.get({ threadId });
    const t = (thread as unknown as { thread?: typeof thread }).thread ?? thread;
    const env = await envRoot(t.environmentId);
    if (t.environmentId === null || env === null) {
      return { environmentId: null, rootName: "", files: [], dirs: [], truncated: false };
    }
    const cached = treeCache.get(t.environmentId);
    if (cached && Date.now() - cached.at < 30_000) return cached.tree;
    const listing = await bb.sdk.environments.paths({
      environmentId: t.environmentId,
      includeFiles: "true",
      includeDirectories: "true",
      limit: String(MAX_TREE_PATHS),
    });
    const tree: WorkspaceTree = {
      environmentId: t.environmentId,
      rootName: env.root.slice(env.root.lastIndexOf("/") + 1),
      files: listing.paths.filter((p) => p.kind === "file").map((p) => p.path),
      dirs: listing.paths.filter((p) => p.kind === "directory").map((p) => p.path.replace(/\/+$/, "")),
      truncated: listing.truncated,
    };
    treeCache.set(t.environmentId, { at: Date.now(), tree });
    return tree;
  }

  bb.rpc.register(rpcContract, {
    thread_activity: ({ threadId }) => threadActivity(threadId),
    thread_tree: ({ threadId }) => threadTree(threadId),
  });

  /** Signal open panels: the thread itself and every ancestor that might show it. */
  async function publishFor(thread: { id: string; parentThreadId: string | null }) {
    bb.realtime.publish(ACTIVITY_CHANGED, { threadId: thread.id });
    if (thread.parentThreadId === null) return;
    try {
      const { threads } = await bb.sdk.threads.experimental_listAncestors({ threadIds: [thread.id] });
      const ids = threads.find((t) => t.threadId === thread.id)?.ancestorIds ?? [thread.parentThreadId];
      for (const id of ids) bb.realtime.publish(ACTIVITY_CHANGED, { threadId: id });
    } catch {
      bb.realtime.publish(ACTIVITY_CHANGED, { threadId: thread.parentThreadId });
    }
  }

  // Only threads someone has looked at are kept live; others index lazily on open.
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if ((await load(thread.id)) === null) return;
    await sync(thread.id);
    await publishFor(thread);
  });

  // A stopped turn leaves no item in flight: clear stale "now" markers.
  const settle = async ({ thread }: { thread: { id: string; parentThreadId: string | null } }) => {
    const index = await load(thread.id);
    if (index === null || Object.keys(index.pending).length === 0) return;
    await sync(thread.id, (fresh) => {
      fresh.pending = {};
    });
    await publishFor(thread);
  };
  bb.events.on("thread.idle", settle);
  bb.events.on("thread.failed", settle);

  bb.events.on("thread.deleted", async ({ thread }) => {
    await bb.storage.kv.delete(kvKey(thread.id));
  });
}
