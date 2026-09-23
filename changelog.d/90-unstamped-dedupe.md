- **A provider circuit opening is reported once, not twice.** Events that belong to no single
  workspace were deduplicated against the cursor of callers that name no workspace, as if that
  were everybody's. On a busy machine it sits far ahead, so those events always looked already
  collected and duplicates went through — two identical `provider.circuit_open` rows blocked a
  real turn. They are now judged against the baseline, which is what every workspace inherits.
