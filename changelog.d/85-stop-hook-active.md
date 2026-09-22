- **The turn-end guard stands down instead of wedging a session.** It now honours
  `stop_hook_active`: once the harness reports it has already blocked on the guard's account,
  the guard allows the turn to end rather than repeating itself. Previously a condition the
  agent could not clear -- for any reason -- blocked every turn until Claude Code overrode the
  hook.
