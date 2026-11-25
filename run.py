"""启动纸面实验室。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="本地美股策略回测台")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--selftest", action="store_true", help="只跑不联网的引擎自检")
    args = parser.parse_args()
    if args.selftest:
        from simtrader.selftest import run_all

        run_all()
        return
    from simtrader.server import serve

    serve(args.host, args.port)


if __name__ == "__main__":
    main()
