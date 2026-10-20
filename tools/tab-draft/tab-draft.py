#!/usr/bin/env python3
"""tab-draft 실행 진입점. 사용법: tab-draft.py <음원> [옵션]  (tools/tab-draft/README.md 참고)"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tabdraft.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
