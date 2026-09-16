---
description: Ask several models the same question in parallel and get a judged synthesis (second opinions, design decisions, root-cause hypotheses).
argument-hint: <question>
allowed-tools: mcp__break-free-gateway__panel, mcp__break-free-gateway__list_models
---
Run a `panel` for: $ARGUMENTS

- Seats: 3 diverse vendors that are usable (check `list_models` if unsure), e.g. `["deepseek/deepseek-v4-pro","kimi/kimi-k3","zai/glm-5.3"]`; add `"local"` if the user wants a local opinion.
- `judge: "strong"`. Include relevant repo context in `context`; give seats `capabilities:["read"]` if the question is about this codebase.
- Report: consensus, the disagreements and the judge's rulings, then **your own** recommendation (you are allowed to disagree with the judge — say why).
