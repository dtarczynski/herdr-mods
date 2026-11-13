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

The triangle on a row and **Start working…** in the reader open the same launch settings. Choose an agent, select permissions, optionally add a multiline prompt in **Additional instructions**, then click **Start**. The issue and your instructions open in a new tab pinned to the original repository/space. Selecting an agent or permission mode does not start work.

![Synthetic launch settings preview](launch-settings.png)

| Agent | Permission presets |
|---|---|
| Codex | Agent defaults, Read only, Workspace, YOLO |
| Claude | Agent defaults, Ask, Accept edits, Plan, YOLO |
| Antigravity (`agy`) | Agent defaults, Accept edits, Plan, YOLO |
| Other agents / wrappers | Agent defaults; additional instructions remain available |

**Agent defaults** preserves configured launch flags, including any existing bypass flags. Explicit presets replace conflicting permission flags while retaining model and other options. Codex always receives `--no-daemon`; its YOLO mode disables approvals and its sandbox. Claude/Antigravity YOLO skips permission prompts without overriding managed policies or other sandbox settings. A selected YOLO preset labels the action **Start in YOLO**. Use a compatible CLI version on the target machine; custom shell wrappers do not receive guessed flags.

Permissions reset to Agent defaults for every new launch dialog and when switching agents. Additional instructions stay only in that open dialog, survive switching agents, and are appended literally to the issue task. No global agent configuration is edited. Read only/Plan asks for investigation and a proposed plan. The issue alone does not grant publishing or deployment permission.

Access: runs read-only `gh repo view`, `gh issue list/view`, and `gh api graphql` queries, then Herdr `tab.new` only after agent selection. Issue content is untrusted task material. No credentials are bundled or written. Run `node --test github-issues/tests/*.test.mjs` from the repository root.
