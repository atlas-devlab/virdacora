"""Separate July LAD training from one frozen August development screen.

Scientific packages are imported only by the explicitly invoked train command.
Verification never refits. No command acquires observations or opens September.
"""
import argparse
import gzip
import math
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import owasco_local_median_preflight as integrity
import owasco_lad_data as data
from owasco_lad_core import predict, validate_model_components

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = 'docs/datasets/owasco-local-median/protocol.json'
PROTOCOL_SHA = 'e92fa18d16ed82b72e45089e8a0c86d9f49c924ce8cd449aec090a9cd34e6b51'
PREFLIGHT = 'docs/evidence/owasco-local-median/preflight.json'
FREEZE = 'docs/evidence/owasco-local-median/implementation-freeze.json'
MODEL = 'docs/evidence/owasco-local-median/frozen-model.json'
MODEL_AUDIT = 'docs/evidence/owasco-local-median/training-audit.json'
REPORT = 'docs/evidence/owasco-local-median/development.json.gz'
SUMMARY = 'docs/evidence/owasco-local-median/development-summary.json'
MODEL_VERSION = 'owasco-july-local-lad-model-v1'
REPORT_VERSION = 'owasco-august-local-lad-development-v1'
FREEZE_VERSION = 'owasco-local-lad-implementation-freeze-v1'
TOL = 1e-9
CODE_FILES = (
    'scripts/owasco_local_median.py', 'scripts/owasco_lad_core.py',
    'scripts/owasco_lad_data.py', 'scripts/owasco_lad_environment.py',
    'scripts/owasco_local_median_preflight.py',
    'scripts/audit_owasco_local_median.py',
    'scripts/requirements-owasco-lad.txt',
)
encoded, loads, sha = integrity.encoded, integrity.loads, integrity.sha256


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root, stderr=subprocess.PIPE)


def commit_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('Need an exact Git commit SHA')
    return value


def bound(root, name):
    return integrity.safe_path(root, name)


def read_document(root, name):
    raw = bound(root, name).read_bytes()
    decoded = gzip.decompress(raw) if name.endswith('.gz') else raw
    return loads(decoded), sha(raw)


def write_exclusive(root, name, value):
    path = bound(root, name)
    raw = encoded(value)
    if name.endswith('.gz'):
        raw = gzip.compress(raw, mtime=0)
    # The caller creates the fixed parent explicitly; never replace prior evidence.
    with path.open('xb') as handle:
        handle.write(raw)
    return sha(raw)


def load_protocol(root):
    raw = bound(root, PROTOCOL).read_bytes()
    if sha(raw) != PROTOCOL_SHA:
        raise ValueError('Frozen PR20 protocol bytes changed')
    return integrity.validate_protocol(loads(raw))


def code_bindings(root):
    return [{'file': name, 'rawSha256': sha(bound(root, name).read_bytes())}
            for name in CODE_FILES]


def assert_tracked_bytes(root, name, revision='HEAD'):
    if git(root, 'show', f'{revision}:{name}') != bound(root, name).read_bytes():
        raise ValueError('Artifact/code bytes are not committed: ' + name)


def assert_published_head(root):
    """A workflow guard, not proof against a hostile local Git custodian."""
    head = commit_id(git(root, 'rev-parse', 'HEAD').decode().strip())
    branch = git(root, 'branch', '--show-current').decode().strip()
    if not branch or not re.fullmatch(r'[A-Za-z0-9_.\-/]+', branch):
        raise ValueError('Need a named research branch')
    origin = git(root, 'remote', 'get-url', 'origin').decode().strip()
    if origin not in ('https://github.com/atlas-devlab/virdacora.git',
                      'git@github.com:atlas-devlab/virdacora.git'):
        raise ValueError('Unexpected research repository remote')
    line = git(root, 'ls-remote', '--exit-code', 'origin', 'refs/heads/' + branch).decode().strip()
    if not line or line.split()[0] != head:
        raise ValueError('Current commit must be pushed before executing this stage')
    return head


def assert_clean(root):
    if git(root, 'status', '--porcelain').strip():
        raise ValueError('Commit tracked and untracked research changes first')


def freeze_implementation(root):
    load_protocol(root)
    assert_clean(root)
    head = assert_published_head(root)
    for name in CODE_FILES:
        assert_tracked_bytes(root, name)
    actual = integrity.preflight(PROTOCOL, root)
    prior, prior_sha = read_document(root, PREFLIGHT)
    if encoded(actual) != encoded(prior):
        raise ValueError('Metadata preflight no longer matches the frozen receipt')
    record = {'version': FREEZE_VERSION, 'createdAtUTC': utc_now(),
              'protocolFile': PROTOCOL, 'protocolRawSha256': PROTOCOL_SHA,
              'metadataPreflightRawSha256': prior_sha,
              'implementationCommit': head, 'codeFiles': code_bindings(root),
              'environmentalFitExecuted': False,
              'candidatePredictionsOrScoresComputed': False,
              'meaning': 'Code/protocol freeze before July fit; commit and push this receipt next.'}
    write_exclusive(root, FREEZE, record)
    return record


def verify_freeze(root, require_publication=False):
    load_protocol(root)
    record, raw_sha = read_document(root, FREEZE)
    if (record.get('version') != FREEZE_VERSION
            or record.get('protocolRawSha256') != PROTOCOL_SHA
            or record.get('codeFiles') != code_bindings(root)):
        raise ValueError('Implementation freeze or numerical code changed')
    code_commit = commit_id(record.get('implementationCommit'))
    git(root, 'merge-base', '--is-ancestor', code_commit, 'HEAD')
    for item in record['codeFiles']:
        assert_tracked_bytes(root, item['file'], code_commit)
    assert_tracked_bytes(root, FREEZE)
    if require_publication:
        assert_clean(root)
        assert_published_head(root)
    return record, raw_sha


def begin_attempt(root, stage, details):
    """Consume a single canonical stage before numerical fitting or first scoring."""
    directory = bound(root, '.runtime/owasco-local-median/' + PROTOCOL_SHA)
    directory.mkdir(parents=True, exist_ok=True)
    name = directory / (stage + '-attempt.json')
    value = {'stage': stage, 'startedAtUTC': utc_now(), 'state': 'STARTED',
             'protocolRawSha256': PROTOCOL_SHA, **details}
    with name.open('xb') as handle:
        handle.write(encoded(value))
    return value


def finish_attempt(root, stage, attempt, result, error=None):
    # Completion is a separate event; the first-attempt claim is never overwritten.
    value = {**attempt, 'completedAtUTC': utc_now(), 'state': result}
    if error is not None:
        value['error'] = str(error)
    directory = bound(root, '.runtime/owasco-local-median/' + PROTOCOL_SHA)
    with (directory / (stage + '-completion.json')).open('xb') as handle:
        handle.write(encoded(value))
    return value


def train(root):
    spec = load_protocol(root)
    frozen, freeze_sha = verify_freeze(root, require_publication=True)
    if bound(root, MODEL).exists():
        raise ValueError('Canonical model already exists; verification never refits')
    from owasco_lad_environment import capture_environment
    environment = capture_environment(require_pins=True)
    for package in ('numpy', 'scipy'):
        manifest = environment.get('distributions', {}).get(package, {}).get('fileManifest') or {}
        if (manifest.get('allIncludedFilesHashed') is not True
                or manifest.get('allAvailableRecordChecksMatch') is not True):
            raise ValueError('Installed numerical distribution integrity failed: ' + package)
    # Integrity/lineage validation is not an optimizer attempt and computes no scaler.
    # A malformed archive must be diagnosed before consuming the sole fit attempt.
    rows = data.load_cohort(root, spec, 'training')
    attempt = begin_attempt(root, 'train', {'implementationFreezeRawSha256': freeze_sha})
    try:
        # The loader above opens only three July files. No August reader is called.
        from owasco_lad_core import fit_lad
        fitted = fit_lad(rows, spec['candidate'])
        record = {'version': MODEL_VERSION, 'candidateId': spec['candidate']['id'],
                  'createdAtUTC': utc_now(), 'protocolFile': PROTOCOL,
                  'protocolRawSha256': PROTOCOL_SHA,
                  'implementationFreezeRawSha256': freeze_sha,
                  'implementationCommit': frozen['implementationCommit'],
                  'features': list(spec['features']),
                  'trainingSources': data.source_bindings(spec, 'training'),
                  'trainingPairs': len(rows), 'trainedOnlyOnJuly': True,
                  'environment': environment, **fitted,
                  'developmentPredictionsComputed': False,
                  'scope': 'One July fit; training diagnostics are in-sample, not validation.'}
        validate_model_components(record)
        digest = write_exclusive(root, MODEL, record)
    except Exception as exc:
        finish_attempt(root, 'train', attempt, 'FAILED_STOP_NO_RETRY', exc)
        raise
    completed = finish_attempt(root, 'train', attempt, 'COMPLETE')
    return {'modelFile': MODEL, 'modelRawSha256': digest,
            'trainingDiagnostics': record['trainingDiagnostics'], 'attempt': completed,
            'nextStep': 'Audit, commit and push this exact model before any August prediction.'}


def checked_model(root, require_publication=False):
    spec = load_protocol(root)
    frozen, freeze_sha = verify_freeze(root, require_publication)
    model, raw_sha = read_document(root, MODEL)
    if (model.get('version') != MODEL_VERSION
            or model.get('candidateId') != spec['candidate']['id']
            or model.get('protocolRawSha256') != PROTOCOL_SHA
            or model.get('implementationFreezeRawSha256') != freeze_sha
            or model.get('implementationCommit') != frozen['implementationCommit']
            or model.get('features') != spec['features']
            or model.get('trainingSources') != data.source_bindings(spec, 'training')
            or model.get('trainingPairs') != 1275
            or model.get('trainedOnlyOnJuly') is not True
            or model.get('developmentPredictionsComputed') is not False):
        raise ValueError('Frozen model provenance or training scope changed')
    validate_model_components(model)
    if require_publication:
        assert_tracked_bytes(root, MODEL)
        require_training_audit(root, raw_sha, freeze_sha)
    return model, raw_sha


def require_training_audit(root, model_sha, freeze_sha):
    receipt, _ = read_document(root, MODEL_AUDIT)
    if (receipt.get('status') != 'PASS' or receipt.get('modelRawSha256') != model_sha
            or receipt.get('implementationFreezeRawSha256') != freeze_sha
            or receipt.get('developmentOpened') is not False
            or receipt.get('optimizerInvoked') is not False):
        raise ValueError('Need the independent July audit for this exact frozen model')
    assert_tracked_bytes(root, MODEL_AUDIT)
    return receipt


def audit_model(root):
    checked_model(root)
    from audit_owasco_local_median import audit
    result = audit(root, include_development=False)
    if result.get('status') != 'PASS' or result.get('developmentOpened') is not False:
        raise ValueError('July-only arithmetic audit did not pass')
    write_exclusive(root, MODEL_AUDIT, result)
    return result


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def safe_number(value):
    return value if finite(value) else None


def mean(values):
    if not values or not all(finite(v) for v in values):
        return None
    try:
        return safe_number(math.fsum(values) / len(values))
    except OverflowError:
        return None


def evaluate_row(model, row):
    try:
        result = predict(model, row['features'], row['persistence'])
        delta, prediction = result['deltaHat'], result['prediction']
    except (OverflowError, ValueError) as exc:
        delta = prediction = None
        arithmetic_error = str(exc)
    else:
        arithmetic_error = None
    valid = finite(prediction) and prediction >= 0
    p, actual, old = row['persistence'], row['actual'], row['oldR']
    errors = {'P': safe_number(abs(p-actual)),
              'L': safe_number(abs(prediction-actual)) if finite(prediction) else None,
              'oldR': safe_number(abs(old-actual)) if finite(old) else None}
    gain = safe_number(errors['P']-errors['L']) if errors['L'] is not None else None
    outcome = ('invalid' if not valid or gain is None else
               'helps' if gain > TOL else 'harms' if gain < -TOL else 'ties')
    return {'sourceRowIndex': row['index'], 'origin': row['origin'], 'target': row['target'],
            'actualMgL': actual, 'persistenceMgL': p, 'oldRMgL': old,
            'deltaHatMgL': safe_number(delta), 'predictionMgL': safe_number(prediction),
            'candidateValid': valid, 'arithmeticError': arithmetic_error,
            'predictionChanged': prediction != p if finite(prediction) else None,
            'absoluteErrorsMgL': errors, 'gainAgainstPersistenceMgL': gain,
            'signedErrorMgL': safe_number(prediction-actual) if finite(prediction) else None,
            'outcome': outcome}


def summarize(rows):
    return {'pairs': len(rows),
            'maePersistenceMgL': mean([r['absoluteErrorsMgL']['P'] for r in rows]),
            'maeCandidateMgL': mean([r['absoluteErrorsMgL']['L'] for r in rows]),
            'maeOldRMgL': mean([r['absoluteErrorsMgL']['oldR'] for r in rows]),
            'meanGainAgainstPersistenceMgL': mean([r['gainAgainstPersistenceMgL'] for r in rows]),
            'meanSignedErrorMgL': mean([r['signedErrorMgL'] for r in rows]),
            'maxCandidateAbsoluteErrorMgL': max((r['absoluteErrorsMgL']['L'] for r in rows), default=None)
                if all(r['absoluteErrorsMgL']['L'] is not None for r in rows) else None,
            'invalidPredictions': sum(not r['candidateValid'] for r in rows),
            'changedPredictions': sum(r['predictionChanged'] is True for r in rows)}


def build_report(spec, model, model_sha, rows, model_freeze_commit):
    if len(rows) != 1306:
        raise ValueError('Development cohort must retain all 1306 accepted origins')
    records = [evaluate_row(model, row) for row in rows]
    summary = summarize(records)
    p_mae, l_mae = summary['maePersistenceMgL'], summary['maeCandidateMgL']
    gain = p_mae-l_mae if p_mae is not None and l_mae is not None else None
    passed = summary['invalidPredictions'] == 0 and gain is not None and gain > TOL
    groups = {name: summarize([r for r in records if r['outcome'] == name])
              for name in ('helps', 'ties', 'harms', 'invalid')}
    days = {day: summarize([r for r in records if r['origin'][:10] == day])
            for day in sorted({r['origin'][:10] for r in records})}
    if sum(g['pairs'] for g in groups.values()) != len(rows):
        raise ValueError('Outcome partition loses development rows')
    # Verify groups recompose errors without averaging group means unweighted.
    for method in ('P', 'L', 'oldR'):
        errors = [r['absoluteErrorsMgL'][method] for r in records]
        if all(finite(x) for x in errors):
            grouped = [r['absoluteErrorsMgL'][method] for label in groups
                       for r in records if r['outcome'] == label]
            if abs(math.fsum(errors)/len(rows)-math.fsum(grouped)/len(rows)) > TOL:
                raise ValueError('Grouped errors do not recompose full-cohort MAE')
    return {'version': REPORT_VERSION, 'candidateId': spec['candidate']['id'],
            'protocolRawSha256': PROTOCOL_SHA, 'modelFile': MODEL,
            'modelRawSha256': model_sha, 'modelFreezeCommit': model_freeze_commit,
            'developmentSources': data.source_bindings(spec, 'development'),
            'stationId': spec['stationId'], 'horizonSeconds': 3600,
            'summary': summary,
            'decision': {'primaryMetric': 'Full-cohort August MAE against persistence',
                         'gainMgL': gain, 'numericalToleranceMgL': TOL,
                         'passedDevelopmentScreen': passed,
                         'status': 'DEVELOPMENT_GAIN_ONLY' if passed else 'STOP_CANDIDATE',
                         'independentValidation': False, 'septemberOpened': False,
                         'meaning': 'No automatic tuning, alternative candidate or operational promotion.'},
            'outcomeGroups': groups, 'utcDays': days,
            'examples': {label: next((r for r in records if r['outcome'] == label), None)
                         for label in ('helps', 'harms')},
            'rows': records,
            'limits': ['August was previously examined: development only.',
                       'One finalized near-surface archive; not whole-lake or real-time validation.',
                       'The recipe changes locality, loss and coefficient regularization together.',
                       'Counts/tests are not independent environmental evidence or ecological benefit.']}


def score(root):
    spec = load_protocol(root)
    model, model_sha = checked_model(root, require_publication=True)
    if bound(root, REPORT).exists() or bound(root, SUMMARY).exists():
        raise ValueError('First development score already exists; use verify-report')
    published = assert_published_head(root)
    attempt = begin_attempt(root, 'score', {'modelRawSha256': model_sha,
                                          'modelFreezeCommit': published})
    try:
        # No fit or preprocessing function is called in this command.
        rows = data.load_cohort(root, spec, 'development')
        record = build_report(spec, model, model_sha, rows, published)
        digest = write_exclusive(root, REPORT, record)
        write_exclusive(root, SUMMARY, {k: v for k, v in record.items() if k != 'rows'})
    except Exception as exc:
        finish_attempt(root, 'score', attempt, 'FAILED_STOP_NO_RETRY', exc)
        raise
    completed = finish_attempt(root, 'score', attempt, 'COMPLETE')
    return {'reportFile': REPORT, 'reportRawSha256': digest,
            'summary': record['summary'], 'decision': record['decision'], 'attempt': completed}


def verify_model(root):
    spec = load_protocol(root)
    model, raw_sha = checked_model(root)
    rows = data.load_cohort(root, spec, 'training')
    p_errors, l_errors, residual_errors = [], [], []
    for row in rows:
        out = predict(model, row['features'], row['persistence'])
        p_errors.append(abs(row['persistence']-row['actual']))
        l_errors.append(abs(out['prediction']-row['actual']))
        residual_errors.append(abs((row['actual']-row['persistence'])-out['deltaHat']))
    saved = model['trainingDiagnostics']
    for key, actual in [('maePersistence', mean(p_errors)), ('maeCandidate', mean(l_errors)),
                        ('deltaResidualMAE', mean(residual_errors))]:
        if actual is None or abs(actual-saved[key]) > TOL:
            raise ValueError('Frozen training diagnostics differ: ' + key)
    from audit_owasco_local_median import audit
    saved_audit, _ = read_document(root, MODEL_AUDIT)
    if encoded(saved_audit) != encoded(audit(root, include_development=False)):
        raise ValueError('Training audit receipt differs from independent no-fit replay')
    return {'verified': True, 'modelRawSha256': raw_sha, 'trainingPairs': len(rows),
            'fitExecuted': False, 'augustOpened': False,
            'meaning': 'Read-only model prediction/diagnostic replay; no optimizer call.'}


def verify_report(root):
    spec = load_protocol(root)
    model, model_sha = checked_model(root)
    saved, raw_sha = read_document(root, REPORT)
    frozen_commit = commit_id(saved.get('modelFreezeCommit'))
    git(root, 'merge-base', '--is-ancestor', frozen_commit, 'HEAD')
    assert_tracked_bytes(root, MODEL, frozen_commit)
    rows = data.load_cohort(root, spec, 'development')
    replay = build_report(spec, model, model_sha, rows, frozen_commit)
    if encoded(saved) != encoded(replay):
        raise ValueError('Frozen development report differs from no-fit replay')
    summary, _ = read_document(root, SUMMARY)
    if encoded(summary) != encoded({k: v for k, v in replay.items() if k != 'rows'}):
        raise ValueError('Human-readable summary differs from complete report')
    return {'verified': True, 'reportRawSha256': raw_sha,
            'pairs': len(rows), 'fitExecuted': False, 'filesWritten': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['freeze-implementation', 'train', 'audit-model', 'score',
                                           'verify-model', 'verify-report'])
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args(argv)
    actions = {'freeze-implementation': freeze_implementation, 'train': train, 'audit-model': audit_model,
               'score': score, 'verify-model': verify_model, 'verify-report': verify_report}
    try:
        result = actions[args.command](args.root.resolve())
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as exc:
        parser.error(str(exc))
    print(encoded(result).decode(), end='')


if __name__ == '__main__':
    main()
