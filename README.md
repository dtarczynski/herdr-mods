# Herdr mods

Three independent packages for the native [Herdr App](https://herdr.dev), tested with 0.1.15. All widget labels are in English.

| Package | What it adds |
|---|---|
| [GitHub Issues](github-issues/) | Issues beside Files/Changes, labels, linked PRs, Markdown reader and agent handoff |
| [AI Limits](ai-limits/) | Installed-agent discovery, quota usage, reset times and compact mode |
| [Agents Context Window Progress](agents-context-window-progress/) | Context bars, working shimmer and pulsing input-needed indicator |

## Install

Read the package's `README.md` and `RECIPE.md` first: these are trusted native mods that can run programs. Requires Herdr App and Python 3. The installer targets the standard layout tree, rejects existing mod/layout names, and clones your layout instead of replacing it. It leaves keys, accounts and preferences intact.

```sh
git clone https://github.com/dtarczynski/herdr-mods.git
cd herdr-mods
python3 install.py github-issues --layout my-issues
# Review the dry run, then install:
python3 install.py github-issues --layout my-issues --apply
```

Install another package on top by naming the previous layout:

```sh
python3 install.py ai-limits --from-layout my-issues --layout my-issues-limits --apply
python3 install.py agents-context-window-progress --from-layout my-issues-limits --layout my-agent-tools --apply
```

Use `--home /path/to/herdr-app` for a custom App home. For a modified tab bar/sidebar, follow manual integration in the package recipe. A name collision stops installation: back up and review differences before manually updating an existing personal mod. Never overwrite a shipped mod.

To undo, switch to the source layout (`herdr-app do layout.switch --name main`), then remove only the personal layout and package mod folders you installed, after checking no other layout uses them.

## Validate

```sh
node --test github-issues/tests/*.test.mjs agents-context-window-progress/tests/*.test.mjs
python3 -m unittest discover -s ai-limits/tests
python3 -m unittest discover -s tests
```

Run `herdr-app check <installed-mod-folder>` for each mod, inspect `herdr-app status`, and inspect a native `herdr-app shot /tmp/mod.png`. Previews use synthetic data; no account data, credentials, terminal transcripts or personal settings are included.

## Attribution

`tabs-github-issues` and `agents-context` are modified clones of Herdr App 0.1.15; their `cloned_from` metadata is retained. Herdr-derived code uses [Apache-2.0](LICENSE). Original additions in this repository use the same license. GitHub PR icons are [Primer Octicons](https://github.com/primer/octicons), with their MIT license included beside the icons. Brand icons and other shipped assets are loaded from the installed Herdr App.
