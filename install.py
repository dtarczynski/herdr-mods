#!/usr/bin/env python3
"""Install one package into a new personal layout; dry run unless --apply."""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

PACKAGES = ('github-issues', 'ai-limits', 'agents-context-window-progress')


def find(node, name):
    if node.get('id') == name:
        return node
    for child in node.get('children', []):
        found = find(child, name)
        if found is not None:
            return found
    return None


def patch_layout(source, package):
    layout = copy.deepcopy(source)
    if package == 'github-issues':
        tabs, panel = find(layout, 'tabs'), find(layout, 'panel-body')
        if tabs is None or panel is None or panel.get('type') != 'stack':
            raise ValueError('This layout needs tabs and a panel-body stack. See RECIPE.md for manual integration.')
        if tabs.get('content', {}).get('mod') != 'tabs':
            raise ValueError('The tab bar is already customized. Merge the GitHub Issues tab manually; see RECIPE.md.')
        if find(layout, 'github-issues') is not None:
            raise ValueError('GitHub Issues already exists in this layout.')
        tabs['content']['mod'] = 'tabs-github-issues'
        panel.setdefault('children', []).append({'id':'github-issues', 'type':'block', 'content':{'mod':'github-issues'}})
    elif package == 'ai-limits':
        sidebar = find(layout, 'sidebar-lists')
        if sidebar is None or sidebar.get('type') != 'column':
            raise ValueError('This layout needs a sidebar-lists column. See RECIPE.md for manual integration.')
        if find(layout, 'ai-limits') is not None:
            raise ValueError('AI Limits already exists in this layout.')
        sidebar.setdefault('children', []).append({'id':'ai-limits', 'type':'block', 'size':{'px':300}, 'min':60, 'content':{'mod':'ai-limits'}})
    elif package == 'agents-context-window-progress':
        agents = find(layout, 'agents')
        if agents is None or agents.get('content', {}).get('mod') != 'agents':
            raise ValueError('The agents block is missing or already customized. See RECIPE.md for manual integration.')
        agents['content']['mod'] = 'agents-context'
    return layout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', choices=PACKAGES)
    parser.add_argument('--from-layout', default='main')
    parser.add_argument('--layout', required=True, help='New personal layout name')
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', str(Path.home()/'.config/herdr-app'))))
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    for name in (args.from_layout, args.layout):
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', name):
            parser.error('Layout names may contain letters, numbers, hyphens and underscores.')
    package = Path(__file__).resolve().parent / args.package
    manifest = json.loads((package/'manifest.json').read_text())
    target = args.home/'layouts'/f'{args.layout}.json'
    if target.exists():
        parser.error('Target layout already exists; choose a new name.')
    mods = manifest['mods']
    for name in mods:
        if (args.home/'mods'/name).exists():
            parser.error(f'Mod {name} already exists; no files were overwritten. Follow the manual update instructions.')
    source = json.loads((args.home/'layouts'/f'{args.from_layout}.json').read_text())
    patch_layout(source, args.package)  # Validate before any writes or commands.
    print(f'Package: {args.package}\nCopy mods: {", ".join(mods)}\nClone layout: {args.from_layout} -> {args.layout}')
    if not args.apply:
        print('Dry run only. Review the package, then repeat with --apply.')
        return
    env = {**os.environ, 'HERDR_APP_HOME': str(args.home)}
    copied = []
    try:
        for name in mods:
            destination = args.home/'mods'/name
            shutil.copytree(package/'mods'/name, destination)
            copied.append(destination)
            subprocess.run(['herdr-app', 'check', str(destination)], env=env, check=True)
    except Exception:
        for destination in copied:
            shutil.rmtree(destination)
        raise
    # Herdr owns cloning, including saved sizes/clicks, and switches to the clone.
    subprocess.run(['herdr-app', 'do', 'layout.clone', json.dumps({'name':args.from_layout, 'as':args.layout})], env=env, check=True)
    result = patch_layout(json.loads(target.read_text()), args.package)
    temporary = target.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(result, indent=2) + '\n')
    temporary.replace(target)
    print(f'Installed in {args.layout}. Switch back with: herdr-app do layout.switch --name {args.from_layout}')


if __name__ == '__main__':
    main()
