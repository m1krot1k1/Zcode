#!/usr/bin/env python3
"""Build a standalone PRISM 10.0 prompt. Text compilation != an agent runtime.
Examples:
  python scripts/compile_prompt.py --profile fast --output generated/fast.md
  python scripts/compile_prompt.py --profile swarm --output generated/swarm.md
  python scripts/compile_prompt.py --profile full --output generated/full.md
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def compile_profile(profile):
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    if profile == 'full':
        return (ROOT / manifest['full_master']).read_text(encoding='utf-8')
    if profile not in manifest['profiles']:
        raise ValueError(f'Unknown profile {profile}; expected {list(manifest["profiles"])+["full"]}')
    core = (ROOT / manifest['core']).read_text(encoding='utf-8').rstrip()
    module_names = manifest['profiles'][profile]
    modules = []
    for name in module_names:
        mod = (ROOT / manifest['modules'][name]['path']).read_text(encoding='utf-8').rstrip()
        modules.append(mod)
    header = f'\n\n---\n\n## Подключённые профильные инструкции: {profile.upper()}\n\n' if modules else ''
    result = core + header + '\n\n---\n\n'.join(modules) + '\n'
    if result.count('PRISM ∞ 10.0 активирован.') != 1:
        raise ValueError('Activation invariant failed')
    return result

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--profile', choices=['fast','research','coding','swarm','evolution','discovery','all','full'],default='fast')
    ap.add_argument('--output', type=Path,required=True)
    args = ap.parse_args()
    target = args.output if args.output.is_absolute() else ROOT / args.output
    content = compile_profile(args.profile)
    target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(content,encoding='utf-8')
    print(f'profile={args.profile} bytes={target.stat().st_size} lines={len(content.splitlines())} output={target}')

if __name__ == '__main__':
    main()
