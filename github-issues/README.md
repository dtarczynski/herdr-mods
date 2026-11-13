# GitHub Issues

Native issue browser beside Files and Changes. Supports colored labels, linked PRs with GitHub state icons, a Markdown reader with comments, maximize/restore, and a quick agent launcher on each row.

![Synthetic GitHub Issues preview](preview.png)

Requires Herdr App 0.1.15, `gh` authenticated with access to the repository, and at least one installed agent for handoff. In remote spaces, `gh` and agent discovery run on that machine. The active terminal must be inside a GitHub repository.

From the repository root:

```sh
python3 install.py github-issues --layout my-issues
python3 install.py github-issues --layout my-issues --apply
```

The two mods are `github-issues` and `tabs-github-issues`. Installation clones a standard layout; custom tab bars require the small manual merge described in [RECIPE.md](RECIPE.md).

Search uses GitHub search syntax and submits on Enter. Open/Closed/All filters and More load pages of 50 issues. The list refreshes every minute. Linked PRs include timeline references as well as explicit connections, so a reference is not necessarily a closing PR. The reader's green macOS-style button maximizes/restores; minimize is disabled.

The triangle on a row opens an installed-agent picker. Choosing an agent starts a new tab in the original repository/space with the issue as its task. Codex receives `--no-daemon`. Nothing launches merely by reading an issue; publishing or deployment permission is not granted by the handoff.

Access: runs read-only `gh repo view`, `gh issue list/view`, and `gh api graphql` queries, then Herdr `tab.new` only after agent selection. Issue content is untrusted task material. No credentials are bundled or written. Run `node --test github-issues/tests/*.test.mjs` from the repository root.
