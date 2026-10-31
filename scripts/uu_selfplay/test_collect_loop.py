"""Run the production collection loop against an isolated failing block."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(shutil.which("zsh"), "Collection controller uses zsh")
class CollectLoopTests(unittest.TestCase):
    def run_loop(self, flag):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            for name in ("scripts/uu_selfplay", "config/local", "tmp/uu-collect", "bin"):
                (root/name).mkdir(parents=True)
            script=root/"scripts/uu_selfplay/collect.sh"
            script.write_bytes(Path(__file__).with_name("collect.sh").read_bytes())
            (root/"config/local/collect-modes.zsh").write_text('''
collect_block_id() { print f$2; }
collect_block() {
  print $2 >> tmp/uu-collect/calls
  print retained > tmp/uu-collect/$2-failed-record
  if [ $2 = f1 ]; then return 7; fi
  touch tmp/uu-collect/STOP-fixture
  return 0
}
collect_rest() { print 0; }
''')
            for name,body in {
                "remrun": "print '{\"status\":\"valid\",\"devices\":[]}'\n",
                "sleep": "exit 0\n",
            }.items():
                path=root/"bin"/name;path.write_text("#!/bin/zsh\n"+body);path.chmod(0o755)
            env={**os.environ,"PATH":str(root/"bin")+os.pathsep+os.environ["PATH"],
                 "COLLECT_STOP_ON_FAILURE":flag}
            env.pop("COLLECT_START_UNTIL_EPOCH",None)
            result=subprocess.run(["zsh",str(script),"fixture-mode"],env=env,
                                  capture_output=True,text=True,timeout=10)
            records={p.name:p.read_text() for p in (root/"tmp/uu-collect").iterdir()}
            return result,records

    def test_first_failure_stops_and_preserves_its_record(self):
        result,records=self.run_loop("1")
        self.assertEqual(result.returncode,7,result.stderr)
        self.assertEqual(records["calls"],"f1\n")
        self.assertEqual(records["f1-failed-record"],"retained\n")
        self.assertEqual(records["fixture-mode.counter"],"1\n")

    def test_default_policy_still_advances_after_failure(self):
        result,records=self.run_loop("0")
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(records["calls"],"f1\nf2\n")
        self.assertIn("f1-failed-record",records)

    def test_malformed_policy_fails_before_a_block_starts(self):
        result,records=self.run_loop("invalid")
        self.assertEqual(result.returncode,2)
        self.assertNotIn("calls",records)


if __name__=="__main__":unittest.main()
