# grove

## Documentation (`docs/`)

The `docs/` folder holds topic-focused guides that capture **non-obvious knowledge** worth carrying between sessions: library quirks, architectural decisions and their rationale, gotchas that took time to figure out, recipes for patterns that recur.

**Persist only durable knowledge** — facts that stay true across sessions and outlive the moment. Before writing anything, ask: *will this still be useful in six months?* If not, it doesn't belong here. Never persist one-time or transient facts.

| Durable — persist | Transient — never persist |
|---|---|
| How a subsystem is built and **why** | "Refactored the auth module today" |
| A library default that bites + its workaround | "Currently debugging the login flow" |
| A convention to apply across the codebase | A specific date's deploy/CI status |
| A recurring recipe or pattern | A one-off task's step-by-step log |

Each file is named after its topic in `SCREAMING_SNAKE_CASE.md` (e.g., `BOTTOM_SHEET.md`).

**Current docs:**

- _(none yet)_

**When working in this repo, proactively offer to create or update a doc file** whenever you:

- Learn a non-obvious fact about a library, framework, or platform (a default that bites, a known bug, a workaround)
- Make an architectural decision the user agrees to (which library to use, which pattern to follow, why one option was rejected)
- Discover a pattern or convention that should be applied consistently across the codebase
- Find a recipe that solves a problem cleanly and is likely to come up again
- Notice an existing doc is now **wrong, outdated, or incomplete** — correct it, extend it with the new finding, and prune anything stale, superseded, **or transient**

Treat the docs as living: as you learn, fold new findings into the relevant existing doc rather than letting it drift, and delete content that no longer holds **or that turned out to be transient and shouldn't have been persisted**.

Don't write or rewrite a doc silently — propose it ("worth documenting this in `docs/X.md`?" / "this contradicts `docs/X.md`, update it?") and only proceed if the user agrees. After creating or meaningfully updating a doc, add or refresh its entry in the **Current docs** list above so future sessions can find it.
