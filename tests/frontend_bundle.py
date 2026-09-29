"""Inline actual first-party JS modules for offline UI tests, without external fetches."""
import re
from pathlib import Path

def frontend_bundle(root: Path, svg: str = '') -> str:
    modules = ['supervision-ui.js', 'ops-ui.js', 'security-ui.js', 'continuity-ui.js', 'admin-ui.js', 'ai-ui.js', 'app.js']
    parts = []
    for name in modules:
        code = (root / 'public' / name).read_text()
        code = re.sub(r'^import\s+[^\n]+;\s*$', '', code, flags=re.MULTILINE)
        code = code.replace('export function', 'function')
        if svg:
            code = code.replace('/favicon.svg', svg)
        parts.append(code)
    return '\n'.join(parts)
