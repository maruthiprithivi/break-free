- **Finished jobs are announced once, not once per project.** The fleet snapshot held only the
  current workspace's jobs but was stored in a single file every gateway shared, so each one's
  record of "what I saw last time" was another project's job list — and its own finished work
  looked new again every time. One live queue carried 93 notices that had been announced more
  than once, several of them four times. Each workspace now keeps its own snapshot.
- **A gateway's first look is a baseline.** It cannot tell what is new from what has always been
  there, so it records what it sees and announces nothing. A job that finishes between two
  checks is still reported.
