- **A provider that starts answering and then goes quiet is caught in seconds, not minutes.**
  The header deadline only ever caught a host that never spoke; one that sent headers and half
  a token and then stopped was left to the full request timeout, three minutes later, having
  produced nothing usable. The gap between body chunks now has its own deadline, reported as
  `body_stall` so the circuit breaker can weigh it apart from a timeout. It resets on every
  chunk, so a model that generates slowly but keeps emitting is never touched, and
  `providers.<name>.bodyStallMs` tunes it for a host that pauses mid-answer.
