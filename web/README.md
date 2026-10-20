# The dashboard (React)

React 19 + Vite, built into one HTML file that the Worker and `huddle server` serve at `/app`.

```sh
cd web
npm install
npm run build && node dev-server.cjs   # a local server on :7788 with a seeded team; prints PROJECT and TOKEN
#   open http://127.0.0.1:7788/app#project=PROJECT&token=TOKEN&name=kelly   (or /app#demo)
npm run ship                            # build and copy to ../src/dashboard.html (commit that file)
```

- `src/lib/state.js`: all project state (`S`), the API, live events, accounts and invites
- `src/lib/words.js`: pure helpers (titles, times, markdown); `feed.js` and `tasks.js` build on them
- `src/lib/keys.js`: keyboard navigation (any list item with `data-nav` joins j/k/Enter)
- `src/lib/store.js`: a tiny reactive store; call `useS()` at the top of a component and read or change `S` freely
- `src/views/`: one file per page; `src/components/`: the shell, dialogs, search, notifications, tour
- `src/app.css` is the original stylesheet; phone and new-layout rules are in `src/layout.css`
- `legacy/dashboard.html` is the previous single-file dashboard, kept for reference
