// bb-plugin-agent-files — the "Agent files" thread panel tab.
//
// The worktree as a tree. Folders open along the paths the thread's agents
// (main agent, subagents, child threads) touch; the file being worked on right
// now glows; a "now" line, a stats strip and an activity strip sit on top.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { FileActivity, RecentActivity, ThreadActivity, WorkspaceTree, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Kind = "read" | "edit" | "search";

const KIND_COLOR: Record<Kind, string> = { read: "#4f8ff7", edit: "#e8833a", search: "#9b7bea" };
const KIND_VERB: Record<Kind, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  search: ["Searching", "Searched"],
};
const MAIN_COLOR = "#8a8f98";
const AGENT_COLORS = ["#3fb68b", "#d65db1", "#22a6b3", "#c9a227", "#e05561", "#7c8cf8"];
const OUTSIDE = "\u0000outside";
const LIVE_MS = 6000;
const INDENT = 16;

// ---------------------------------------------------------------------------
// Data

function useThreadData(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [activity, setActivity] = useState<ThreadActivity | null>(null);
  const [tree, setTree] = useState<WorkspaceTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const again = useRef(false);
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));

  const refetch = useCallback(() => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    rpc
      .call("thread_activity", { threadId })
      .then((result) => {
        setActivity(result);
        setError(null);
      }, report)
      .finally(() => {
        inFlight.current = false;
        if (again.current) {
          again.current = false;
          refetch();
        }
      });
  }, [rpc, threadId]);

  const refetchTree = useCallback(() => {
    rpc.call("thread_tree", { threadId }).then(setTree, report);
  }, [rpc, threadId]);

  useEffect(() => {
    setActivity(null);
    setTree(null);
    refetch();
    refetchTree();
  }, [refetch, refetchTree]);

  // New files the agent creates show up when the (cached) listing refreshes.
  useEffect(() => {
    const id = setInterval(refetchTree, 30_000);
    return () => clearInterval(id);
  }, [refetchTree]);

  const ids = useRef<string[]>([threadId]);
  ids.current = activity?.threadIds ?? [threadId];
  // A brand-new thread has no workspace yet, so keep asking for the tree until one exists.
  const hasTree = useRef(false);
  hasTree.current = tree?.environmentId != null;
  useRealtime("activity-changed", (payload) => {
    const changed = (payload as { threadId?: unknown } | null)?.threadId;
    if (typeof changed !== "string" || !ids.current.includes(changed)) return;
    refetch();
    if (!hasTree.current) refetchTree();
  });

  return { activity, tree, error };
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Touch stats for one tree file, merged across threads. */
interface Stats {
  reads: number;
  edits: number;
  searches: number;
  heat: number;
  lastAt: number;
  actors: Set<string>;
  file: FileActivity;
}

interface DirNode {
  path: string;
  name: string;
  dirs: Map<string, DirNode>;
  files: Map<string, string>; // name → tree key
}

const newDir = (path: string, name: string): DirNode => ({ path, name, dirs: new Map(), files: new Map() });

function dirAt(root: DirNode, parts: string[]): DirNode {
  let node = root;
  parts.forEach((part, i) => {
    let next = node.dirs.get(part);
    if (!next) node.dirs.set(part, (next = newDir(parts.slice(0, i + 1).join("/"), part)));
    node = next;
  });
  return node;
}

function addFile(root: DirNode, path: string) {
  const parts = path.split("/");
  dirAt(root, parts.slice(0, -1)).files.set(parts[parts.length - 1]!, path);
}

const ancestors = (path: string) => {
  if (path.startsWith(OUTSIDE)) return [];
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
};

/** A tree key for a touched file: its worktree path, or one slot under "Outside". */
const keyOf = (f: FileActivity) => f.rel ?? `${OUTSIDE}/${f.dir}\u0001${f.name}`;
const outsideName = (key: string) => key.slice(key.indexOf("\u0001") + 1);

// ---------------------------------------------------------------------------
// Small pieces

function Dot({ color, title, pulse }: { color: string; title?: string; pulse?: boolean }) {
  return (
    <span
      title={title}
      className={cn("inline-block size-[7px] shrink-0 rounded-full", pulse && "af-pulse")}
      style={{ background: color }}
    />
  );
}

function HeatMeter({ heat }: { heat: number }) {
  const level = heat === 0 ? 0 : Math.min(5, 1 + Math.floor(Math.log2(heat + 1) * 0.9));
  return (
    <span className="flex shrink-0 items-end gap-[2px]">
      {[1, 2, 3, 4, 5].map((k) => (
        <i
          key={k}
          className="block w-[3px] rounded-[1px]"
          style={{
            height: 4 + k * 1.6,
            background: k <= level ? KIND_COLOR.edit : "var(--border)",
            opacity: k <= level ? 0.4 + k * 0.12 : 1,
          }}
        />
      ))}
    </span>
  );
}

function Badge({ n, kind, letter }: { n: number; kind: Kind; letter: string }) {
  if (n === 0) return null;
  return (
    <span
      className="rounded-[3px] px-1 font-mono text-[10px] font-semibold leading-[14px]"
      style={{ color: KIND_COLOR[kind], background: `${KIND_COLOR[kind]}1f` }}
    >
      {n > 1 ? n : ""}
      {letter}
    </span>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[11.5px]",
        on ? "border-muted-foreground/60 text-foreground" : "border-border text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

const STYLES = `
@keyframes af-pulse { 50% { opacity: .25 } }
.af-pulse { animation: af-pulse 1.1s ease-in-out infinite }
@keyframes af-flash { 0% { box-shadow: inset 0 0 0 999px color-mix(in srgb, var(--primary) 18%, transparent) } }
.af-flash { animation: af-flash 1.4s ease-out }
`;

// ---------------------------------------------------------------------------

function AgentFilesPanel({ threadId }: PluginThreadPanelProps) {
  const { activity, tree, error } = useThreadData(threadId);
  const navigate = useBbNavigate();
  const now = useNow(1000);
  const [agent, setAgent] = useState<string | null>(null);
  const [touchedOnly, setTouchedOnly] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const seenAt = useRef(0);

  const colorOf = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    for (const a of activity?.actors ?? []) {
      map.set(a, a === "Main agent" ? MAIN_COLOR : AGENT_COLORS[i++ % AGENT_COLORS.length]!);
    }
    return (a: string) => map.get(a) ?? MAIN_COLOR;
  }, [activity?.actors]);

  // Touch stats keyed by tree path, filtered to the selected agent.
  const stats = useMemo(() => {
    const out = new Map<string, Stats>();
    for (const f of activity?.files ?? []) {
      if (agent !== null && !f.actors.includes(agent)) continue;
      const key = keyOf(f);
      const s = out.get(key) ?? {
        reads: 0,
        edits: 0,
        searches: 0,
        heat: 0,
        lastAt: 0,
        actors: new Set<string>(),
        file: f,
      };
      s.reads += f.reads;
      s.edits += f.edits;
      s.searches += f.searches;
      s.heat += f.heat;
      s.lastAt = Math.max(s.lastAt, f.lastAt);
      f.actors.forEach((a) => s.actors.add(a));
      out.set(key, s);
    }
    return out;
  }, [activity, agent]);

  const keyByFileKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of activity?.files ?? []) m.set(f.key, keyOf(f));
    return m;
  }, [activity]);

  const recent = useMemo(
    () => (activity?.recent ?? []).filter((r) => agent === null || r.actor === agent),
    [activity, agent],
  );
  const latest: RecentActivity | undefined = recent[recent.length - 1];

  // What is live: in flight, or touched in the last few seconds.
  const liveKeys = useMemo(() => {
    const m = new Map<string, Kind>();
    for (const r of recent) {
      const k = keyByFileKey.get(r.key);
      if (k && (r.pending || now - r.at < LIVE_MS)) m.set(k, r.kind);
    }
    return m;
  }, [recent, keyByFileKey, now]);

  // Open folders along every newly touched path; the first load opens them all.
  useEffect(() => {
    if (activity === null) return;
    const initial = seenAt.current === 0;
    const fresh = activity.recent.filter((r) => r.at > seenAt.current);
    if (!initial && fresh.length === 0) return;
    const keys = initial
      ? [...stats.keys()]
      : fresh.flatMap((r) => keyByFileKey.get(r.key) ?? []);
    seenAt.current = Math.max(1, seenAt.current, ...activity.recent.map((r) => r.at));
    setOpen((prev) => {
      const next = new Set(prev);
      for (const k of keys) for (const a of ancestors(k)) next.add(a);
      return next;
    });
  }, [activity, stats, keyByFileKey]);

  const root = useMemo(() => {
    const r = newDir("", tree?.rootName ?? "");
    for (const d of tree?.dirs ?? []) dirAt(r, d.split("/"));
    for (const f of tree?.files ?? []) addFile(r, f);
    for (const k of stats.keys()) {
      if (k.startsWith(OUTSIDE)) dirAt(r, [OUTSIDE]).files.set(k, k);
      else addFile(r, k);
    }
    return r;
  }, [tree, stats]);

  // Folder roll-ups: heat, agents, and whether something inside is live.
  const dirAgg = useMemo(() => {
    const m = new Map<string, { heat: number; files: number; actors: Set<string>; live: Kind | null }>();
    for (const [key, s] of stats) {
      const dirs = key.startsWith(OUTSIDE) ? [OUTSIDE] : ancestors(key);
      for (const a of dirs) {
        const cur = m.get(a) ?? { heat: 0, files: 0, actors: new Set<string>(), live: null };
        cur.heat += s.heat;
        cur.files += 1;
        s.actors.forEach((x) => cur.actors.add(x));
        cur.live = cur.live ?? liveKeys.get(key) ?? null;
        m.set(a, cur);
      }
    }
    return m;
  }, [stats, liveKeys]);

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const openFile = (key: string) => {
    const s = stats.get(key);
    if (s?.file.target) {
      navigate.experimental_openFilePreview({ target: s.file.target, location: null });
    } else if (!key.startsWith(OUTSIDE) && tree?.environmentId) {
      navigate.experimental_openFilePreview({
        target: { kind: "workspace", environmentId: tree.environmentId, path: key },
        location: null,
      });
    }
  };

  const rows: ReactNode[] = [];
  // Guide lines: one per ancestor level, tinted when that folder holds live work.
  const guides = (chain: string[]) =>
    chain.map((dirPath, level) => {
      const live = dirAgg.get(dirPath)?.live;
      return (
        <span
          key={level}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px"
          style={{ left: level * INDENT + 12, background: live ? KIND_COLOR[live] : "var(--muted-foreground)", opacity: live ? 0.7 : 0.22 }}
        />
      );
    });

  const walk = (node: DirNode, chain: string[]) => {
    const depth = chain.length;
    const dirs = [...node.dirs.values()].sort((a, b) =>
      a.path === OUTSIDE ? 1 : b.path === OUTSIDE ? -1 : a.name.localeCompare(b.name),
    );
    for (const top of dirs) {
      if (touchedOnly && !dirAgg.get(top.path)) continue;
      // Compact a chain of single-child folders into one row: src/server/routes.
      let d = top;
      let label = top.path === OUTSIDE ? "Outside the workspace" : top.name;
      while (d.path !== OUTSIDE && d.files.size === 0 && d.dirs.size === 1) {
        const only = [...d.dirs.values()][0]!;
        if (touchedOnly && !dirAgg.get(only.path)) break;
        d = only;
        label += `/${only.name}`;
      }
      const agg = dirAgg.get(d.path);
      const isOpen = open.has(d.path);
      rows.push(
        <div
          key={`d:${d.path}`}
          role="button"
          tabIndex={0}
          onClick={() => toggle(d.path)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(d.path)}
          className="relative flex h-[26px] cursor-pointer select-none items-center gap-1.5 rounded-md pr-2 hover:bg-muted/60"
          style={{ paddingLeft: depth * INDENT + 6 }}
        >
          {guides(chain)}
          <span
            className="flex w-3 shrink-0 justify-center text-[8px] text-muted-foreground transition-transform"
            style={{ transform: isOpen ? "rotate(90deg)" : undefined }}
          >
            ▶
          </span>
          <Icon
            name={isOpen ? "FolderOpen" : "Folder"}
            className={cn("size-[15px] shrink-0", agg ? "text-foreground/70" : "text-muted-foreground/50")}
          />
          <span className={cn("min-w-0 flex-1 truncate", agg ? "font-medium" : "text-muted-foreground/70")}>
            {label}
            {agg && !isOpen ? (
              <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{agg.files}</span>
            ) : null}
          </span>
          {agg?.live && !isOpen ? <Dot color={KIND_COLOR[agg.live]} pulse /> : null}
          <span className="flex gap-[3px]">
            {[...(agg?.actors ?? [])].map((a) => (
              <Dot key={a} color={colorOf(a)} title={a} />
            ))}
          </span>
          <HeatMeter heat={agg?.heat ?? 0} />
        </div>,
      );
      if (isOpen) walk(d, [...chain, d.path]);
    }
    const files = [...node.files.entries()].sort((a, b) =>
      node.path === OUTSIDE
        ? (stats.get(b[1])?.heat ?? 0) - (stats.get(a[1])?.heat ?? 0)
        : a[0].localeCompare(b[0]),
    );
    for (const [name, key] of files) {
      const s = stats.get(key);
      if (touchedOnly && !s) continue;
      const live = liveKeys.get(key);
      const outside = key.startsWith(OUTSIDE);
      rows.push(
        <div
          key={`f:${key}:${live ? (s?.lastAt ?? "") : ""}`}
          role="button"
          tabIndex={0}
          onClick={() => openFile(key)}
          onKeyDown={(e) => e.key === "Enter" && openFile(key)}
          title={
            s
              ? `${s.file.rel ?? `${s.file.dir}/${s.file.name}`}\n${s.reads} reads · ${s.edits} edits · ${s.searches} searches\nBy ${[...s.actors].join(", ")} · last ${ago(s.lastAt, now)} ago`
              : key
          }
          className={cn(
            "relative flex h-[26px] cursor-pointer items-center gap-1.5 rounded-md pr-2 hover:bg-muted/60",
            live && "af-flash",
          )}
          style={{ paddingLeft: depth * INDENT + 6 + 18, background: live ? `${KIND_COLOR[live]}26` : undefined }}
        >
          {guides(chain)}
          <Icon
            name="File"
            className="size-[14px] shrink-0"
            style={{ color: live ? KIND_COLOR[live] : s ? (s.edits > 0 ? KIND_COLOR.edit : KIND_COLOR.read) : undefined, opacity: s ? 0.9 : 0.35 }}
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              s ? (s.edits > 0 ? "font-semibold" : "") : "text-muted-foreground/60",
            )}
          >
            {outside ? outsideName(name) : name}
            {outside && s ? <span className="ml-1.5 text-[11px] text-muted-foreground">{s.file.dir}</span> : null}
          </span>
          {live ? (
            <span className="shrink-0 text-[11px]" style={{ color: KIND_COLOR[live] }}>
              {KIND_VERB[live][0]}…
            </span>
          ) : null}
          {s ? (
            <>
              <Badge n={s.edits} kind="edit" letter="E" />
              <Badge n={s.reads} kind="read" letter="R" />
              <Badge n={s.searches} kind="search" letter="S" />
              <span className="flex gap-[3px]">
                {[...s.actors].map((a) => (
                  <Dot key={a} color={colorOf(a)} title={a} />
                ))}
              </span>
            </>
          ) : null}
          <HeatMeter heat={s?.heat ?? 0} />
        </div>,
      );
    }
  };
  walk(root, []);

  const totals = [...stats.values()].reduce(
    (t, s) => ({ reads: t.reads + s.reads, edits: t.edits + s.edits }),
    { reads: 0, edits: 0 },
  );
  const workspaceFiles = tree?.files.length ?? 0;
  const seen = [...stats.keys()].filter((k) => !k.startsWith(OUTSIDE)).length;
  const coverage =
    tree === null || workspaceFiles === 0 || tree.truncated
      ? "–"
      : `${Math.min(100, Math.round((100 * seen) / workspaceFiles))}%`;
  const liveNow = latest !== undefined && (latest.pending || now - latest.at < LIVE_MS);

  return (
    <div className="flex h-full min-h-0 flex-col text-[13px]">
      <style>{STYLES}</style>

      <div className="flex min-h-9 items-center gap-2 border-b border-border px-3 py-2 text-xs">
        {latest === undefined ? (
          <span className="text-muted-foreground">Waiting for the agent…</span>
        ) : (
          <>
            <Dot color={KIND_COLOR[latest.kind]} pulse={liveNow} />
            <span className="min-w-0 flex-1 truncate">
              <span className="font-semibold">
                {latest.pending ? KIND_VERB[latest.kind][0] : KIND_VERB[latest.kind][1]}
              </span>{" "}
              {latest.label}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
              <Dot color={colorOf(latest.actor)} />
              {latest.actor}
              {latest.pending ? null : <span className="tabular-nums">· {ago(latest.at, now)}</span>}
            </span>
          </>
        )}
      </div>

      <div className="grid grid-cols-4 border-b border-border">
        {(
          [
            ["files", String(stats.size), undefined],
            ["reads", String(totals.reads), KIND_COLOR.read],
            ["edits", String(totals.edits), KIND_COLOR.edit],
            ["of repo seen", coverage, undefined],
          ] as const
        ).map(([label, value, color]) => (
          <div key={label} className="px-3 pb-1 pt-2">
            <div className="text-base font-semibold tabular-nums" style={{ color }}>
              {value}
            </div>
            <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
          </div>
        ))}
        <div className="col-span-4 flex h-[22px] items-end gap-px px-3 pb-2">
          {recent.slice(-60).map((r, i) => (
            <i
              key={i}
              title={`${KIND_VERB[r.kind][1]} ${r.label} · ${r.actor}`}
              className="block min-w-[2px] max-w-[6px] flex-1 rounded-[1px]"
              style={{ height: r.kind === "edit" ? 14 : r.kind === "read" ? 9 : 5, background: KIND_COLOR[r.kind] }}
            />
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5">
        <Chip on={agent === null} onClick={() => setAgent(null)}>
          All
        </Chip>
        {(activity?.actors ?? []).map((a) => (
          <Chip key={a} on={agent === a} onClick={() => setAgent(agent === a ? null : a)}>
            <Dot color={colorOf(a)} />
            {a}
          </Chip>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setTouchedOnly((v) => !v)}
          className={cn("text-[11.5px]", touchedOnly ? "text-foreground underline" : "text-muted-foreground")}
        >
          touched only
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {error !== null ? (
          <p role="alert" className="p-3 text-sm text-destructive">
            {error}
          </p>
        ) : activity === null || tree === null ? (
          <p className="p-3 text-sm text-muted-foreground">Indexing this thread…</p>
        ) : rows.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No files touched yet.</p>
        ) : (
          rows
        )}
        {tree?.truncated ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            Large workspace: showing the first {tree.files.length} files plus every touched one.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Thread header button: opens (or focuses) this thread's Agent files tab. */
function AgentFilesHeaderButton(_: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground hover:text-foreground"
      aria-label="Show agent files"
      onClick={() => navigate.openThreadPanel({ actionId: "agent-files", title: "Agent files" })}
    >
      <Icon name="FileText" className="size-4" />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "agent-files",
    title: "Agent files",
    icon: "FileText",
    layout: "flush",
    component: AgentFilesPanel,
  });
  app.slots.experimental_threadHeaderAction({
    id: "agent-files-header",
    title: "Agent files",
    component: AgentFilesHeaderButton,
  });
});
