# changelog.d

One file per change. Never edit the `Unreleased` section of `CHANGELOG.md`.

Every branch that edits the same block at the top of `CHANGELOG.md` conflicts
with every other branch that does, on a line neither author cares about. A file
per change means two branches touch two different paths, and git has nothing to
resolve.

## Adding an entry

Create `changelog.d/<slug>.md`, where `<slug>` is the issue number and a short
name: `12-tier-floor.md`, `26-unpriced-spend.md`. One bullet per user-visible
change, in the voice of the released sections: what changed, and why it matters
to someone using it.

```markdown
- **The floor refuses rather than degrading.** A task pinned to a frontier model
  is never answered by a small local one behind the caller's back.
```

No heading, no date, no version. The file name orders the entry and nothing else
depends on it.

## Releasing

```sh
scripts/changelog.sh preview          # what Unreleased currently reads as
scripts/changelog.sh release 3.8.0    # fold every fragment into CHANGELOG.md
```

`release` writes a new dated section under the title, deletes the fragments it
consumed and leaves the rest of the file alone. Commit the result.
