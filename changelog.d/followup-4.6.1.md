- **Workers can find files at any depth.** A `**` glob in `list_files` or `search` stopped after
  one directory, so a worker listing every `.ts` file got only the top-level ones. Worktree path
  claims had the same bug. The worker jail's deny list is deliberately unchanged.
- **Live sub-agents are no longer reported as exited.** A gateway started inside a Claude swarm
  pane asked the swarm's own tmux server whether a crewmate was alive, and was told no. tmux is
  now always asked on the right server, and a tmux that cannot be asked keeps the last known
  state instead of recording an exit. Exited records are removed a day after they are confirmed
  gone.
- **A symlinked path is the same workspace as its real path.** An event stamped through a
  symlink was invisible to the session that owned it and could never be retired.
- **The installer's self-test runs in a scrubbed environment.** It inherited provider keys - one
  test made live, paid calls to TypeSafe - and the markers of whatever session launched it, which
  produced false failures when installing from inside Claude Code.
