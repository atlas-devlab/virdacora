"""Workflow and leakage guards with invented data; no environmental archive fit."""
import copy
import math
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import owasco_local_median as runner


def model(intercept=0.0):
    return {'preprocessing': {'means': [0.0]*8, 'variances': [0.0]*8,
                              'scales': [1.0]*8, 'constantMask': [True]*8},
            'coefficients': {'intercept': intercept, 'weights': [0.0]*8}}


def rows(count=1306):
    return [{'index': i, 'origin': f'2020-08-{1+i//48:02d}T{(i//2)%24:02d}:{30*(i%2):02d}:00Z',
             'target': '2020-08-29T00:00:00Z', 'actual': 5.1 if i % 2 else 5.3,
             'persistence': 5.0, 'features': [5.0]+[0.0]*7,
             'oldR': 5.15, 'evidence': {}, 'oxygenHistory': []} for i in range(count)]


SPEC = {'candidate': {'id': 'owasco-july-local-linear-lad-v1'},
        'features': list(runner.integrity.FEATURES), 'stationId': runner.integrity.STATION}


def environment_fixture(valid=True):
    return {'synthetic': True, 'distributions': {
        package: {'fileManifest': {'allIncludedFilesHashed': valid,
                                   'allAvailableRecordChecksMatch': valid}}
        for package in ('numpy', 'scipy')}}


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        # These workflow fixtures test reporting and stage separation; the strict
        # production protocol/source bindings have their own isolated loader tests.
        binding_patch = patch.object(runner.data, 'source_bindings', return_value=[])
        binding_patch.start()
        self.addCleanup(binding_patch.stop)

    def test_full_cohort_mae_and_partitions_recompose(self):
        report = runner.build_report(SPEC, model(0.2), 'a'*64, rows(), 'b'*40)
        self.assertEqual(report['summary']['pairs'], 1306)
        self.assertAlmostEqual(report['summary']['maePersistenceMgL'], .2)
        self.assertAlmostEqual(report['summary']['maeCandidateMgL'], .1)
        self.assertTrue(report['decision']['passedDevelopmentScreen'])
        self.assertEqual(sum(g['pairs'] for g in report['outcomeGroups'].values()), 1306)
        self.assertEqual(sum(g['pairs'] for g in report['utcDays'].values()), 1306)
        self.assertFalse(report['decision']['independentValidation'])
        self.assertFalse(report['decision']['septemberOpened'])

    def test_negative_predictions_stay_in_denominator_and_fail(self):
        report = runner.build_report(SPEC, model(-6), 'a'*64, rows(), 'b'*40)
        self.assertEqual(report['summary']['pairs'], 1306)
        self.assertEqual(report['summary']['invalidPredictions'], 1306)
        self.assertEqual(report['outcomeGroups']['invalid']['pairs'], 1306)
        self.assertEqual(report['rows'][0]['predictionMgL'], -1)
        self.assertIsNotNone(report['summary']['maeCandidateMgL'])
        self.assertFalse(report['decision']['passedDevelopmentScreen'])

    def test_uncomputable_prediction_is_null_not_persistence_rescue(self):
        with patch.object(runner, 'predict', side_effect=ValueError('invented overflow')):
            report = runner.build_report(SPEC, model(), 'a'*64, rows(), 'b'*40)
        self.assertEqual(report['summary']['pairs'], 1306)
        self.assertIsNone(report['summary']['maeCandidateMgL'])
        self.assertIsNone(report['decision']['gainMgL'])
        self.assertFalse(report['decision']['passedDevelopmentScreen'])
        self.assertIsNone(report['rows'][0]['predictionMgL'])
        self.assertEqual(report['rows'][0]['persistenceMgL'], 5)

    def test_nonfinite_raw_result_stays_invalid(self):
        with patch.object(runner, 'predict', return_value={'deltaHat': math.inf, 'prediction': math.inf}):
            row = runner.evaluate_row(model(), rows(1)[0])
        self.assertFalse(row['candidateValid'])
        self.assertIsNone(row['predictionMgL'])
        self.assertIsNone(row['absoluteErrorsMgL']['L'])
        self.assertIsNone(row['predictionChanged'])

    def test_single_invalid_among_1305_valid_does_not_drop_the_row(self):
        regular = runner.predict(model(.2), rows(1)[0]['features'], 5)
        outputs = [regular]*1305 + [{'deltaHat': math.inf, 'prediction': math.inf}]
        with patch.object(runner, 'predict', side_effect=outputs):
            report = runner.build_report(SPEC, model(.2), 'a'*64, rows(), 'b'*40)
        self.assertEqual(report['summary']['pairs'], 1306)
        self.assertEqual(report['summary']['invalidPredictions'], 1)
        self.assertEqual(report['outcomeGroups']['invalid']['pairs'], 1)
        self.assertIsNone(report['summary']['maeCandidateMgL'])
        self.assertFalse(report['decision']['passedDevelopmentScreen'])

    def test_wrong_development_count_stops_before_any_prediction(self):
        with patch.object(runner, 'predict') as prediction:
            with self.assertRaises(ValueError):
                runner.build_report(SPEC, model(), 'a'*64, rows(1305), 'b'*40)
        prediction.assert_not_called()

    def test_equal_mae_and_numerical_ties_do_not_pass(self):
        report = runner.build_report(SPEC, model(), 'a'*64, rows(), 'b'*40)
        self.assertFalse(report['decision']['passedDevelopmentScreen'])
        self.assertEqual(report['outcomeGroups']['ties']['pairs'], 1306)
        self.assertEqual(report['summary']['changedPredictions'], 0)

    def test_exclusive_attempt_preserves_first_record(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = runner.begin_attempt(root, 'train', {'invented': True})
            path = root/'.runtime/owasco-local-median'/runner.PROTOCOL_SHA/'train-attempt.json'
            original = path.read_bytes()
            with self.assertRaises(FileExistsError):
                runner.begin_attempt(root, 'train', {})
            self.assertEqual(path.read_bytes(), original)
            runner.finish_attempt(root, 'train', first, 'FAILED_STOP_NO_RETRY', 'synthetic')
            self.assertEqual(path.read_bytes(), original)

    def test_train_uses_only_training_role_and_fits_once(self):
        fake_fit = {**model(.1), 'solver': {'success': True},
                    'trainingDiagnostics': {'pairs': 2, 'maeCandidate': .1}}
        environment_module = types.SimpleNamespace(capture_environment=Mock(return_value=environment_fixture()))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/Path(runner.MODEL).parent).mkdir(parents=True)
            loader = Mock(return_value=rows(2))
            with patch.object(runner, 'load_protocol', return_value=SPEC), \
                 patch.object(runner, 'verify_freeze', return_value=({'implementationCommit': 'c'*40}, 'd'*64)), \
                 patch.object(runner.data, 'load_cohort', loader), \
                 patch.object(runner.data, 'source_bindings', return_value=[]), \
                 patch.dict(sys.modules, {'owasco_lad_environment': environment_module}), \
                 patch('owasco_lad_core.fit_lad', return_value=fake_fit) as fit:
                out = runner.train(root)
                self.assertEqual(out['modelFile'], runner.MODEL)
                loader.assert_called_once_with(root, SPEC, 'training')
                fit.assert_called_once_with(loader.return_value, SPEC['candidate'])
                with self.assertRaises(ValueError):
                    runner.train(root)
                self.assertEqual(fit.call_count, 1)

    def test_failed_fit_consumes_attempt_without_writing_a_model(self):
        environment_module = types.SimpleNamespace(capture_environment=Mock(return_value=environment_fixture()))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/Path(runner.MODEL).parent).mkdir(parents=True)
            with patch.object(runner, 'load_protocol', return_value=SPEC), \
                 patch.object(runner, 'verify_freeze', return_value=({'implementationCommit': 'c'*40}, 'd'*64)), \
                 patch.object(runner.data, 'load_cohort', return_value=rows(2)), \
                 patch.dict(sys.modules, {'owasco_lad_environment': environment_module}), \
                 patch('owasco_lad_core.fit_lad', side_effect=ValueError('synthetic optimizer failure')) as fit:
                with self.assertRaisesRegex(ValueError, 'synthetic optimizer failure'):
                    runner.train(root)
                with self.assertRaises(FileExistsError):
                    runner.train(root)
                self.assertEqual(fit.call_count, 1)
                self.assertFalse((root/runner.MODEL).exists())

    def test_bad_environment_manifest_stops_before_source_read_or_fit(self):
        fake_environment = types.SimpleNamespace(capture_environment=Mock(return_value=environment_fixture(False)))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(runner, 'load_protocol', return_value=SPEC), \
                 patch.object(runner, 'verify_freeze', return_value=({'implementationCommit': 'c'*40}, 'd'*64)), \
                 patch.dict(sys.modules, {'owasco_lad_environment': fake_environment}), \
                 patch.object(runner.data, 'load_cohort') as loader, \
                 patch('owasco_lad_core.fit_lad') as fit:
                with self.assertRaisesRegex(ValueError, 'integrity failed'):
                    runner.train(root)
                loader.assert_not_called()
                fit.assert_not_called()

    def test_score_reads_only_development_and_does_not_refit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/Path(runner.REPORT).parent).mkdir(parents=True)
            with patch.object(runner, 'load_protocol', return_value=SPEC), \
                 patch.object(runner, 'checked_model', return_value=(model(.2), 'a'*64)), \
                 patch.object(runner, 'assert_published_head', return_value='b'*40), \
                 patch.object(runner.data, 'source_bindings', return_value=[]), \
                 patch.object(runner.data, 'load_cohort', return_value=rows()) as loader, \
                 patch('owasco_lad_core.fit_lad', side_effect=AssertionError('Score must not fit')):
                report = runner.score(root)
                self.assertTrue(report['decision']['passedDevelopmentScreen'])
                loader.assert_called_once_with(root, SPEC, 'development')
                with self.assertRaises(ValueError):
                    runner.score(root)

    def test_score_requires_model_freeze_before_reading_august(self):
        with patch.object(runner, 'load_protocol', return_value=SPEC), \
             patch.object(runner, 'checked_model', side_effect=ValueError('not frozen')), \
             patch.object(runner.data, 'load_cohort') as loader:
            with self.assertRaisesRegex(ValueError, 'not frozen'):
                runner.score(Path('.'))
        loader.assert_not_called()

    def test_missing_or_mismatched_training_audit_prevents_score_readiness(self):
        receipt = {'status': 'PASS', 'modelRawSha256': 'a'*64,
                   'implementationFreezeRawSha256': 'b'*64,
                   'developmentOpened': False, 'optimizerInvoked': False}
        with patch.object(runner, 'read_document', return_value=(receipt, 'c'*64)), \
             patch.object(runner, 'assert_tracked_bytes') as committed:
            self.assertEqual(runner.require_training_audit(Path('.'), 'a'*64, 'b'*64), receipt)
            committed.assert_called_once_with(Path('.'), runner.MODEL_AUDIT)
            with self.assertRaisesRegex(ValueError, 'independent July audit'):
                runner.require_training_audit(Path('.'), 'd'*64, 'b'*64)
        with patch.object(runner, 'read_document', side_effect=FileNotFoundError('no audit')):
            with self.assertRaises(FileNotFoundError):
                runner.require_training_audit(Path('.'), 'a'*64, 'b'*64)

    def test_failed_score_loader_consumes_attempt_and_does_not_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(runner, 'load_protocol', return_value=SPEC), \
                 patch.object(runner, 'checked_model', return_value=(model(), 'a'*64)), \
                 patch.object(runner, 'assert_published_head', return_value='b'*40), \
                 patch.object(runner.data, 'load_cohort', side_effect=ValueError('synthetic source failure')) as loader:
                with self.assertRaisesRegex(ValueError, 'synthetic source failure'):
                    runner.score(root)
                with self.assertRaises(FileExistsError):
                    runner.score(root)
                self.assertEqual(loader.call_count, 1)

    def test_verify_report_is_no_write_no_fit_and_detects_tamper(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/Path(runner.REPORT).parent).mkdir(parents=True)
            with patch.object(runner.data, 'source_bindings', return_value=[]):
                report = runner.build_report(SPEC, model(.2), 'a'*64, rows(), 'b'*40)
                runner.write_exclusive(root, runner.REPORT, report)
                runner.write_exclusive(root, runner.SUMMARY, {k:v for k,v in report.items() if k!='rows'})
                before = {str(p):p.read_bytes() for p in root.rglob('*') if p.is_file()}
                with patch.object(runner, 'load_protocol', return_value=SPEC), \
                     patch.object(runner, 'checked_model', return_value=(model(.2), 'a'*64)), \
                     patch.object(runner, 'git', return_value=b''), \
                     patch.object(runner, 'assert_tracked_bytes'), \
                     patch.object(runner.data, 'load_cohort', return_value=rows()), \
                     patch('owasco_lad_core.fit_lad', side_effect=AssertionError('Replay must not fit')):
                    self.assertTrue(runner.verify_report(root)['verified'])
                    self.assertEqual(before, {str(p):p.read_bytes() for p in root.rglob('*') if p.is_file()})
                    broken = copy.deepcopy(report)
                    broken['rows'][0]['predictionMgL'] += .1
                    with patch.object(runner, 'read_document', return_value=(broken, 'e'*64)):
                        with self.assertRaisesRegex(ValueError, 'differs'):
                            runner.verify_report(root)

    def test_code_change_invalidates_freeze(self):
        freeze = {'version': runner.FREEZE_VERSION, 'protocolRawSha256': runner.PROTOCOL_SHA,
                  'codeFiles': [{'file': 'a.py', 'rawSha256': 'a'*64}]}
        with patch.object(runner, 'load_protocol'), \
             patch.object(runner, 'read_document', return_value=(freeze, 'd'*64)), \
             patch.object(runner, 'code_bindings', return_value=[{'file':'a.py','rawSha256':'b'*64}]):
            with self.assertRaisesRegex(ValueError, 'changed'):
                runner.verify_freeze(Path('.'))

    def test_published_head_guard_requires_exact_expected_remote_branch_sha(self):
        def fake_git(root, *args):
            if args == ('rev-parse', 'HEAD'): return ('a'*40+'\n').encode()
            if args == ('branch', '--show-current'): return b'feat/synthetic\n'
            if args == ('remote', 'get-url', 'origin'): return b'https://github.com/atlas-devlab/virdacora.git\n'
            return ('b'*40+'\trefs/heads/feat/synthetic\n').encode()
        with patch.object(runner, 'git', side_effect=fake_git):
            with self.assertRaisesRegex(ValueError, 'pushed'):
                runner.assert_published_head(Path('.'))


if __name__ == '__main__':
    unittest.main()
