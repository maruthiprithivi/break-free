- **The wake queue no longer grows forever.** Events nobody can still see are dropped once the
  file passes a threshold, so the cost of answering "is anything pending" is bounded by what is
  actually happening rather than by how long the install has been running. Sequence numbers are
  never renumbered and an event any workspace has yet to collect is never dropped.
- **Writers to the shared queue take a lock.** Several gateways run against one session
  directory — one per workspace and worktree — and the file only ever assumed a single writer.
