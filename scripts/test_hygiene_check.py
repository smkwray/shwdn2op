"""The denylist scan must read the payload, not its own program text.

A denylist that silently passes everything lets a private identifier into a commit message or a
staged file while every gate reports green. These tests drive the real entry points (the script's
--message and --staged modes, and a real `git commit` through the commit-msg hook) in a throwaway
repository with a synthetic denylist, and require both a FAIL on the marker and a PASS without it.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MARKER = "zq-synthetic-marker-7731"


class DenylistScan(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
                    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
                    "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}
        for key in ("GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"):
            self.env.pop(key, None)
        (self.repo / "scripts").mkdir()
        (self.repo / ".githooks").mkdir()
        for rel in ("scripts/hygiene_check.sh", ".githooks/commit-msg"):
            shutil.copy2(ROOT / rel, self.repo / rel)
        (self.repo / ".private-denylist").write_text(f"# synthetic\n{MARKER}\n", encoding="utf-8")
        (self.repo / ".gitignore").write_text(".private-denylist\n", encoding="utf-8")
        self.git("init", "-q", "-b", "main")
        self.git("config", "core.hooksPath", ".githooks")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, timeout=30)

    def hygiene(self, *args):
        return subprocess.run(["bash", "scripts/hygiene_check.sh", *args], cwd=self.repo,
                              env=self.env, capture_output=True, text=True, timeout=60)

    def message(self, text):
        path = self.repo / "msg.txt"
        path.write_text(text, encoding="utf-8")
        return self.hygiene("--message", str(path))

    def test_message_mode(self):
        hit = self.message(f"Fix the parser for {MARKER.upper()}\n")
        self.assertEqual(hit.returncode, 1, hit.stdout + hit.stderr)
        self.assertIn("denylisted identifier in commit-message", hit.stderr)
        clean = self.message("Fix the parser\n")
        self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)

    def test_staged_mode(self):
        (self.repo / "src").mkdir()
        target = self.repo / "src" / "a.py"
        target.write_text(f"HOST = '{MARKER}'\n", encoding="utf-8")
        self.git("add", "src/a.py")
        hit = self.hygiene("--staged")
        self.assertEqual(hit.returncode, 1, hit.stdout + hit.stderr)
        self.assertIn("denylisted identifier in src/a.py", hit.stderr)
        target.write_text("HOST = 'example'\n", encoding="utf-8")
        self.git("add", "src/a.py")
        clean = self.hygiene("--staged")
        self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)

    def test_staged_mode_scans_the_index_not_the_working_file(self):
        # The commit takes the staged blob: a marker staged and then hidden by a clean unstaged edit must FAIL,
        # and a clean staged blob must PASS even while the working file carries a marker.
        (self.repo / "src").mkdir()
        target = self.repo / "src" / "a.py"
        home = "/" + "Users" + "/someone/project"  # built from parts so this file itself stays clean
        for staged in (f"HOST = '{MARKER}'\n", f"ROOT = '{home}'\n"):
            target.write_text(staged, encoding="utf-8")
            self.git("add", "src/a.py")
            target.write_text("HOST = 'example'\n", encoding="utf-8")
            hit = self.hygiene("--staged")
            self.assertEqual(hit.returncode, 1, hit.stdout + hit.stderr)
        self.git("add", "src/a.py")
        target.write_text(f"HOST = '{MARKER}'  # {home}\n", encoding="utf-8")
        clean = self.hygiene("--staged")
        self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)

    def test_commit_msg_hook_rejects_marker(self):
        self.git("add", ".gitignore")
        hit = self.git("commit", "-q", "-m", f"Add notes for {MARKER}")
        self.assertNotEqual(hit.returncode, 0, hit.stdout + hit.stderr)
        self.assertIn("private-identifier scan", hit.stderr)
        self.assertNotEqual(self.git("rev-parse", "-q", "--verify", "HEAD").returncode, 0)
        clean = self.git("commit", "-q", "-m", "Add notes")
        self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)


if __name__ == "__main__":
    unittest.main()
