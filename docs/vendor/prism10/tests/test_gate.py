import sys, unittest
from pathlib import Path
R=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(R/'scripts'))
from experiment_gate import assess, one_sided_sign_pvalue, GateError

def rows_for_test(num=12, repeats=2, synthetic=False):
    rows=[]
    for case in range(num):
        for trial in range(repeats):
            baseline_success = 0 if case < 10 else 1
            candidate_success = 1
            rows.append({'case_id':f'case-{case}','trial':trial,'split':'protected_holdout',
              'environment_id':'test-env-sha256:123','grader_id':'test-grader-v1','synthetic':synthetic,
              'critical':case>=10,
              'baseline':{'success':baseline_success,'confirmed_discoveries':0,'cost_usd':1.0,'latency_s':1.0,'safety_violations':0,'receipt':f'b{case}{trial}'},
              'candidate':{'success':candidate_success,'confirmed_discoveries':1 if case<10 else 0,'cost_usd':1.1,'latency_s':1.1,'safety_violations':0,'receipt':f'c{case}{trial}'}})
    return rows
class ExperimentGateTests(unittest.TestCase):
    def test_math(self):
        self.assertAlmostEqual(one_sided_sign_pvalue(4,0),1/16)
        self.assertEqual(one_sided_sign_pvalue(0,0),1)
    def test_pass_logic_only(self):
        result=assess(rows_for_test())
        self.assertEqual(result['status'],'PROMOTE_CANDIDATE')
    def test_synthetic_never_promotes(self):
        self.assertEqual(assess(rows_for_test(synthetic=True))['status'],'INSUFFICIENT_EVIDENCE')
    def test_discovery_objective(self):
        self.assertEqual(assess(rows_for_test(), objective='discovery')['status'],'PROMOTE_CANDIDATE')
    def test_safety_veto(self):
        rows=rows_for_test(); rows[0]['candidate']['safety_violations']=1
        self.assertEqual(assess(rows)['status'],'REJECT')
    def test_critical_regression(self):
        rows=rows_for_test(); rows[-1]['candidate']['success']=0
        self.assertEqual(assess(rows)['status'],'REJECT')
    def test_cost_guardrail(self):
        rows=rows_for_test()
        for row in rows:row['candidate']['cost_usd']=2.0
        self.assertEqual(assess(rows)['status'],'REJECT')
    def test_sample_size(self):
        rows=rows_for_test(num=4)
        self.assertEqual(assess(rows)['status'],'INSUFFICIENT_EVIDENCE')
    def test_mismatched_grader(self):
        rows=rows_for_test();rows[0]['grader_id']='other'
        with self.assertRaises(GateError):assess(rows)
    def test_duplicate_key(self):
        rows=rows_for_test();rows.append(rows[0])
        with self.assertRaises(GateError):assess(rows)
    def test_missing_receipt(self):
        rows=rows_for_test();rows[0]['baseline']['receipt']=''
        with self.assertRaises(GateError):assess(rows)
    def test_invalid_scores(self):
        rows=rows_for_test();rows[0]['candidate']['success']=0.7
        with self.assertRaises(GateError):assess(rows)
if __name__=='__main__':unittest.main()
