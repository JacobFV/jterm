# Working in this repo

## Commit as you go

Land work in small commits as each piece starts working, rather than one commit
at the end. A feature that touches state, rendering, persistence and the backend
is four commits, not one — each one a change that builds, passes the checks, and
could be reverted on its own without taking the others with it.

Do not wait to be asked to commit, and do not batch a session's work into a
single "implement X" commit. Push and release without asking once the work is
done and the checks pass.

## Checks before a commit

What CI runs, in order of how quickly they fail:

```
npx tsc -b          # types
npm test            # vitest, no browser environment — keep logic testable in node
npx vite build      # the bundle
```

For anything under `src-tauri/`:

```
cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
```

Prettier's defaults do **not** match this repo's style (the repo wraps at 100).
Do not run `prettier --write` over a file; match the formatting around you.

## House style

- Comments explain *why*, and are worth writing at length where the reason is
  not obvious from the code. Match the density of the file you are in.
- Panes are live resources. A React component holding a shell must never be
  unmounted by a layout change — see the note at the top of
  `src/components/shell/Workspace.tsx` before touching how panes are rendered.
- Anything read off disk (the session snapshot, settings) is decoded as if it
  were hostile: validate per field, drop what fails, never let one bad value
  cost the whole file.
