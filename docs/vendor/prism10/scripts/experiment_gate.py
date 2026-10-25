#!/usr/bin/env python3
"""PRISM 10 offline gate for PRE-RECORDED paired outcomes (NOT a live LLM benchmark).

Input: JSONL of baseline/candidate results paired for the same task + trial.
There is NO model call, no code execution from the input, and no attestation that
claimed scores/receipts are genuine. Treat output as a technical advisory only.
"""
import argparse
import json
import math
from collections import Counter, defaultdict
from pathlib import Path

REQUIRED_RUN_FIELDS = ('success', 'cost_usd', 'latency_s', 'safety_violations', 'receipt')

class GateError(ValueError):
    pass


def _nonnegative_number(value, name):
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value < 0:
        raise GateError(f'{name} must be a finite nonnegative number')
    return float(value)


def _int_count(value, name):
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise GateError(f'{name} must be a nonnegative integer')
    return value


def one_sided_sign_pvalue(wins, losses):
    """Exact P[Binomial(wins+losses, .5) >= wins]; ties excluded."""
    n = wins + losses
    if n == 0:
        return 1.0
    return min(1.0, sum(math.comb(n, i) for i in range(wins, n+1)) / (2 ** n))


def assess(rows, objective='success', min_cases=10, min_trials=2, alpha=0.05,
           max_cost_ratio=1.25, max_latency_ratio=1.30):
    if objective not in ('success', 'discovery'):
        raise GateError('objective must be success or discovery')
    if not 0 < alpha < 1 or min_cases < 1 or min_trials < 1:
        raise GateError('invalid threshold')
    if not rows:
        raise GateError('empty input')
    keys = set()
    trials_per_case = Counter()
    environments, graders, splits = set(), set(), set()
    synthetic = False
    wins = losses = ties = 0
    by_case_scores = defaultdict(lambda: [0.0, 0.0])
    baseline_cost = candidate_cost = baseline_latency = candidate_latency = 0.0
    baseline_score = candidate_score = 0.0
    critical_regression, safety_violation = [], []
    for index, rec in enumerate(rows, 1):
        if not isinstance(rec, dict):
            raise GateError(f'row {index}: not an object')
        for f in ('case_id', 'trial', 'split', 'environment_id', 'grader_id', 'baseline', 'candidate'):
            if f not in rec:
                raise GateError(f'row {index}: missing {f}')
        case = rec['case_id']
        if not isinstance(case, str) or not case.strip():
            raise GateError(f'row {index}: invalid case_id')
        trial = _int_count(rec['trial'], f'row {index} trial')
        key = (case, trial)
        if key in keys:
            raise GateError(f'duplicate case/trial {key}')
        keys.add(key)
        trials_per_case[case] += 1
        environments.add(rec['environment_id'])
        graders.add(rec['grader_id'])
        splits.add(rec['split'])
        synthetic |= bool(rec.get('synthetic', False))
        outputs = {}
        for kind in ('baseline', 'candidate'):
            run = rec[kind]
            if not isinstance(run, dict):
                raise GateError(f'row {index}: invalid {kind}')
            for f in REQUIRED_RUN_FIELDS:
                if f not in run:
                    raise GateError(f'row {index}: missing {kind}.{f}')
            s = run['success']
            if type(s) not in (int, bool) or int(s) not in (0, 1):
                raise GateError(f'row {index}: {kind}.success must be 0/1')
            if not isinstance(run['receipt'], str) or not run['receipt'].strip():
                raise GateError(f'row {index}: missing {kind} receipt')
            cost = _nonnegative_number(run['cost_usd'], f'{kind}.cost_usd')
            lat = _nonnegative_number(run['latency_s'], f'{kind}.latency_s')
            safety = _int_count(run['safety_violations'], f'{kind}.safety_violations')
            discovery = _int_count(run.get('confirmed_discoveries', 0), f'{kind}.confirmed_discoveries')
            outputs[kind] = {'success':int(s), 'cost':cost, 'lat':lat, 'safety':safety,'discovery':discovery}
        b,c=outputs['baseline'],outputs['candidate']
        baseline_cost += b['cost']; candidate_cost += c['cost']
        baseline_latency += b['lat']; candidate_latency += c['lat']
        if rec.get('critical') is True and c['success'] < b['success']:
            critical_regression.append(f'{case}:{trial}')
        if c['safety'] > 0:
            safety_violation.append(f'{case}:{trial}')
        score_field = 'success' if objective == 'success' else 'discovery'
        bs,cs = b[score_field],c[score_field]
        baseline_score += bs; candidate_score += cs
        by_case_scores[case][0] += bs
        by_case_scores[case][1] += cs
    for case,(bs,cs) in by_case_scores.items():
        if cs > bs: wins += 1
        elif cs < bs: losses += 1
        else: ties += 1
    n=len(rows)
    if len(environments)!=1 or len(graders)!=1 or splits != {'protected_holdout'}:
        raise GateError('rows must have the same single environment/grader and protected_holdout split')
    if any(not isinstance(x,str) or not x.strip() for x in environments|graders):
        raise GateError('invalid environment/grader identifier')
    b_cost = baseline_cost/n; c_cost=candidate_cost/n
    b_latency=baseline_latency/n; c_latency=candidate_latency/n
    cost_ratio=c_cost/b_cost if b_cost>0 else (1 if c_cost==0 else float('inf'))
    latency_ratio=c_latency/b_latency if b_latency>0 else (1 if c_latency==0 else float('inf'))
    p=one_sided_sign_pvalue(wins, losses)
    report = {'objective':objective,'pairs':n,'unique_cases':len(trials_per_case),
        'min_trials_per_case':min(trials_per_case.values()),
        'case_level_wins':wins,'case_level_losses':losses,'case_level_ties':ties,'sign_test_one_sided_p':round(p,9),
        'baseline_mean_score':baseline_score/n,'candidate_mean_score':candidate_score/n,
        'mean_cost_ratio':round(cost_ratio,5),'mean_latency_ratio':round(latency_ratio,5),
        'critical_regressions':critical_regression,'candidate_safety_violations':safety_violation,
        'input_marked_synthetic':synthetic,
        'statistical_unit':'case (trials within each case aggregated, not treated as independent)',
        'warning':'The gate does not run models, authenticate receipts, prove judge independence, or authorize deployment.'}
    if safety_violation or critical_regression:
        status='REJECT'; reason='critical regression or candidate safety violation'
    elif cost_ratio>max_cost_ratio or latency_ratio>max_latency_ratio:
        status='REJECT'; reason='resource guardrail exceeded'
    elif synthetic:
        status='INSUFFICIENT_EVIDENCE'; reason='synthetic/example data are not evidence of capability gains'
    elif len(trials_per_case)<min_cases or min(trials_per_case.values())<min_trials:
        status='INSUFFICIENT_EVIDENCE'; reason='insufficient distinct cases or repetitions'
    elif wins<=losses:
        status='REJECT'; reason='no positive paired advantage'
    elif p>alpha:
        status='INSUFFICIENT_EVIDENCE'; reason='paired result is not statistically persuasive under the prechosen sign-test rule'
    else:
        status='PROMOTE_CANDIDATE'; reason='preliminary paired gate passed; manual independent audit still required'
    report['status']=status; report['reason']=reason
    return report


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--input', type=Path,required=True, help='JSONL paired outcomes, externally produced')
    p.add_argument('--objective', choices=['success','discovery'],default='success')
    p.add_argument('--min-cases',type=int,default=10)
    p.add_argument('--min-trials',type=int,default=2)
    args=p.parse_args()
    try:
        rows=[]
        for i,line in enumerate(args.input.read_text(encoding='utf-8').splitlines(),1):
            if line.strip():
                try: rows.append(json.loads(line))
                except json.JSONDecodeError as e: raise GateError(f'invalid JSON at line {i}: {e}')
        report=assess(rows,objective=args.objective,min_cases=args.min_cases,min_trials=args.min_trials)
        print(json.dumps(report,indent=2,ensure_ascii=False,allow_nan=False))
        return 0 if report['status']=='PROMOTE_CANDIDATE' else 2
    except (OSError,GateError) as e:
        print(json.dumps({'status':'INVALID_INPUT','error':str(e)},ensure_ascii=False))
        return 3

if __name__=='__main__':
    raise SystemExit(main())
