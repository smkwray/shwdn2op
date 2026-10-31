"""A short pass cannot override a failed sustained memory confirmation."""
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
import training_sweep as program


def row(batch,rate):
    return {"batch":batch,"name":f"batch-{batch}","summary":{"trajectorySamplesPerHour":rate}}


class ConfirmationTests(unittest.TestCase):
    def test_compiled_attention_proof_rejects_globally_disabled_dynamo(self):
        import attention_probe
        for config,environment in ((True,"0"),(False,"1")):
            with self.subTest(config=config,environment=environment),tempfile.TemporaryDirectory() as tmp:
                argv=["attention_probe","--mode","MATH","--out",str(Path(tmp)/"report.json"),
                      "--compiled","--lengths","1","--batches","1","--seeds","0"]
                with patch("sys.argv",argv),patch.object(attention_probe.torch._dynamo.config,"disable",config),patch.dict(
                        "os.environ",{"TORCHDYNAMO_DISABLE":environment}),patch.object(
                        attention_probe,"probe",return_value={"pass":True}):
                    with self.assertRaisesRegex(ValueError,"disabled"):attention_probe.main()

    def test_memory_stops_remain_rejected_while_lower_batches_are_confirmed(self):
        calls=[]
        def confirm(batch):
            calls.append(batch)
            return None if batch in (48,64) else row(batch,{8:40,32:30}[batch])
        result=program.confirm_stable([row(8,100),row(32,90),row(48,80),row(64,70)],confirm)
        self.assertEqual(calls,[64,48,32,8])
        self.assertEqual(result["largestStableBatch"],32)
        self.assertEqual(result["bestMeasuredBatch"],8)
        self.assertEqual(result["memoryRejectedBatches"],[64,48])
        self.assertEqual({r["batch"] for r in result["confirmed"]},{8,32})

    def test_selection_uses_sustained_rates_and_does_not_reconfirm_one_batch(self):
        calls=[]
        def confirm(batch):
            calls.append(batch);return row(batch,{8:20,32:30}[batch])
        result=program.confirm_stable([row(8,100),row(32,90)],confirm)
        self.assertEqual(result["bestMeasuredBatch"],32)
        self.assertEqual(calls,[32,8])
        calls.clear();result=program.confirm_stable([row(8,20),row(32,90)],confirm)
        self.assertEqual(calls,[32])

    def test_no_sustained_pass_cannot_qualify_any_batch(self):
        result=program.confirm_stable([row(8,100),row(32,90)],lambda batch:None)
        self.assertIsNone(result["largestStableBatch"])
        self.assertIsNone(result["bestMeasuredBatch"])
        self.assertEqual(result["memoryRejectedBatches"],[32,8])
        self.assertEqual(result["confirmed"],[])


if __name__=="__main__":unittest.main()
