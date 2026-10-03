# 🌱 Commit Garden

Grow your GitHub contribution graph. Enter a repo URL in the web UI and Commit Garden will:

1. Create a local workspace in `workspaces/<owner>__<repo>` and a `test.txt` file
2. Add your GitHub repo as the `origin` remote
3. Keep changing `test.txt`, committing and pushing, with live progress in the browser

No dependencies. Requires Node 18+ and git.

```bash
npm start          # opens http://localhost:3000
PORT=4000 npm start
NO_OPEN=1 npm start  # don't auto-open the browser
```

## Modes

- **Live**: one commit every N seconds, right now (makes today green).
- **Backfill**: spreads commits across the past N days with backdated timestamps (fills past squares).

## For commits to show up on your graph

- git must be able to push to the repo without prompting (SSH key, or `gh auth login` / a credential helper).
- Your `git config user.email` must be a verified email on your GitHub account.
- Commits must land on the repo's default branch (the app uses it automatically).
- Private repo contributions only show if "Private contributions" is enabled on your profile.
