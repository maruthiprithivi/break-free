- **The turn-end guard no longer deadlocks the session.** It told the agent to call
  `fleet_status`, which the compact tool profile had moved behind discovery, so the way out it
  named could be neither seen nor called and the same events blocked every turn forever. The
  tool is resident again, and the guard names the call that actually drains it (`drain:true`).
- **One standing condition is one event, not one per check.** An idle harness session raised a
  fresh `harness.idle` every few seconds for as long as it stayed idle — a real queue held 287
  copies of a single session — and a finished job reappeared whenever two gateways raced on the
  shared snapshot. Identical events are now suppressed while the last one is still uncollected,
  and raised again once it has been.
- **Reading a job's outcome collects it.** `job_result` resolves that job's wake event, for
  failures as well as successes, so finished work stops being reported as still pending.
