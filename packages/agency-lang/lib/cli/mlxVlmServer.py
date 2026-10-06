"""mlx_vlm.server, started so that it exits with `agency local serve`.

`mlx_vlm.server` is an upstream program that Agency runs as it is. This
script runs it the way `python -m mlx_vlm.server` would, after starting the
thread that exits when the parent process goes. The arguments are
mlx_vlm.server's own.
"""

import os
import runpy
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from localServerCommon import exit_when_parent_goes  # noqa: E402

if __name__ == "__main__":
    exit_when_parent_goes()
    runpy.run_module("mlx_vlm.server", run_name="__main__", alter_sys=True)
