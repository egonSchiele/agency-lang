"""Checks for pack-archive: pack the sample tree, check every directory
including the output root and every file against the caps, unpack, and
compare bytes; then the same on a tree the agent never saw."""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile

WORKDIR = os.environ.get("WORKDIR", os.getcwd())
HERE = os.path.dirname(os.path.abspath(__file__))
MAX_ENTRIES = 12
MAX_BYTES = 16 * 1024


def run(script, *args):
    path = os.path.join(WORKDIR, script)
    assert os.path.exists(path), f"{script} was not written"
    result = subprocess.run([sys.executable, path, *args], cwd=WORKDIR, capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, f"{script} exited {result.returncode}:\n{result.stderr[-1500:]}"


def tree_hashes(root):
    out = {}
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(dirpath, name)
            with open(full, "rb") as f:
                out[os.path.relpath(full, root)] = hashlib.sha256(f.read()).hexdigest()
    return out


def cap_violations(root):
    problems = []
    for dirpath, dirs, files in os.walk(root):
        n = len(dirs) + len(files)
        if n > MAX_ENTRIES:
            problems.append(f"{os.path.relpath(dirpath, WORKDIR)} holds {n} entries (cap {MAX_ENTRIES})")
        for name in files:
            size = os.path.getsize(os.path.join(dirpath, name))
            if size > MAX_BYTES:
                problems.append(f"{os.path.relpath(os.path.join(dirpath, name), WORKDIR)} is {size} bytes (cap {MAX_BYTES})")
    return problems


def pack_and_check(source, packed):
    """Pack a copy of the source that is deleted before unpacking, so the
    archive has to be self-contained rather than point back at the source."""
    before = tree_hashes(source)
    assert before, f"{source} is empty"
    staged = packed + "-source"
    shutil.copytree(source, staged)
    run("pack.py", staged, packed)
    shutil.rmtree(staged)
    violations = cap_violations(packed)
    run("unpack.py", packed)
    after = tree_hashes(packed)
    return before, after, violations


def fresh(name):
    path = os.path.join(WORKDIR, name)
    if os.path.exists(path):
        shutil.rmtree(path)
    return path


def test_caps_sample():
    source = os.path.join(WORKDIR, "events")
    _before, _after, violations = pack_and_check(source, fresh("packed-sample-caps"))
    assert not violations, "\n".join(violations[:10])


def test_roundtrip_sample():
    source = os.path.join(WORKDIR, "events")
    before, after, _violations = pack_and_check(source, fresh("packed-sample-roundtrip"))
    assert before == after, diff_report(before, after)


def test_roundtrip_hidden():
    with tempfile.TemporaryDirectory(dir=WORKDIR) as tmp:
        source = os.path.join(tmp, "hidden")
        subprocess.run([sys.executable, os.path.join(HERE, "gen.py"), source, "2"], check=True)
        before, after, violations = pack_and_check(source, os.path.join(tmp, "packed"))
        assert not violations, "\n".join(violations[:10])
        assert before == after, diff_report(before, after)


def diff_report(before, after):
    missing = sorted(set(before) - set(after))
    extra = sorted(set(after) - set(before))
    changed = sorted(k for k in before if k in after and before[k] != after[k])
    return f"missing {missing[:5]}, extra {extra[:5]}, changed {changed[:5]}"
