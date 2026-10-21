See which files a thread's agents read, edit, and search, live, beside the
conversation.

## What you get

- An **Agent files** tab in each thread's right panel. Open it with the file
  icon in the thread header, or from the panel's new-tab menu.
- The thread's working directory as a tree. Folders open along the paths the
  agents touch, untouched files stay dimmed, and the file being read or edited
  right now glows.
- A "now" line (what, which file, which agent), counts of files, reads and
  edits, how much of the repo has been seen, and a strip of recent activity.
- Read / edit / search badges, a heat meter per file and per folder, and a
  colored dot per agent. Click an agent to see only its trail; click a file to
  open it.

## How it works

The plugin reads the thread's own event log, which BB already records, and
keeps a small per-thread index in its local storage. Subagent calls are
attributed to the subagent that made them, and child threads are merged in.
Nothing leaves the machine. Shell commands such as `cat` or `grep` run through a terminal tool
are not counted.
