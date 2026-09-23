- **The fleet cursor file stops growing forever.** It kept one entry per workspace that ever
  drained — 228 of them on a long-lived machine, parsed on every append and every read. Entries
  are now retired after a month of silence. Retirement is by last-seen time and never by
  checking whether the path is readable: an unmounted volume or a detached container is not a
  deleted workspace, and forgetting a live one would make it re-see everything it had collected.
