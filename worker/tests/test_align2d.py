"""Orthography may change across ASR scripts; evidence and timings must not."""
import importlib.util
import copy
import hashlib
import json
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch


MODULE = Path(__file__).resolve().parents[1] / 'align2d.py'
spec = importlib.util.spec_from_file_location('align2d', MODULE)
alignment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alignment)


def heard(text):
    return [{'text': word, 'start': index * .5 + .1, 'end': index * .5 + .4}
            for index, word in enumerate(text.split())]


class KarakalpakOrthographyTests(unittest.TestCase):
    def setUp(self):
        self.previous_language = alignment.LANGUAGE
        alignment.LANGUAGE = 'kaa'

    def tearDown(self):
        alignment.LANGUAGE = self.previous_language

    def test_cyrillic_equivalents_keep_reference_and_real_timing(self):
        reference = 'Ájiniyaz Qosıbay ulı el jer hám yad'
        recognized = heard('Әжинияз Қосыбай улы ел жер ҳәм яд')
        words, _, stats = alignment.align(reference, recognized, 4)
        self.assertEqual(stats['lexicalCoverage'], 1)
        self.assertEqual([word['text'] for word in words], reference.split())
        self.assertEqual([(word['start'], word['end']) for word in words],
                         [(word['start'], word['end']) for word in recognized])
        self.assertTrue(all(word['match'] == 'exact' for word in words))

    def test_current_apostrophe_and_asr_equivalent_letters(self):
        expected = alignment.units('á ǵ ń ó ú ı sh ch')
        self.assertEqual(alignment.units("a’ gʻ nʼ o' u‘ i` sh ch"), expected)
        self.assertEqual(alignment.units('ə ğ ń ö ü ı ş ç'), expected)
        self.assertEqual(alignment.units('ә ғ ң ө ү ы ш ч'), expected)
        self.assertEqual(alignment.units('a\u0301 g\u0301 n\u0301 o\u0301 u\u0301'),
                         alignment.units('á ǵ ń ó ú'))
        self.assertEqual(alignment.units('QOSÍBAY'), alignment.units('Qosıbay'))

    def test_vowels_and_consonants_are_not_blanket_folded(self):
        for left, right in [('a', 'á'), ('o', 'ó'), ('u', 'ú'), ('i', 'ı'),
                            ('n', 'ń'), ('g', 'ǵ'), ('k', 'q'), ('x', 'h')]:
            with self.subTest(left=left, right=right):
                self.assertNotEqual(alignment.units(left), alignment.units(right))

    def test_unrelated_or_missing_speech_still_fails_original_gate(self):
        _, _, unrelated = alignment.align('Ájiniyaz Qosıbay ulı el jer hám yad',
                                           heard('календарь минута запись кнопка'), 4)
        _, _, absent = alignment.align('Ájiniyaz Qosıbay ulı el jer hám yad', [], 4)
        self.assertLess(unrelated['lexicalCoverage'], .65)
        self.assertEqual(absent['lexicalCoverage'], 0)

    def test_partial_evidence_is_not_promoted_to_complete_coverage(self):
        words, _, stats = alignment.align('Ájiniyaz Qosıbay ulı el jer hám yad',
                                           heard('Әжинияз Қосыбай'), 4)
        self.assertEqual(stats['lexicalMatchedWords'], 2)
        self.assertLess(stats['lexicalCoverage'], .65)
        self.assertEqual(sum(word['match'] == 'interpolated' for word in words), 5)

    def test_russian_and_uzbek_normalization_stays_unchanged(self):
        alignment.LANGUAGE = 'ru'
        self.assertEqual(alignment.units('двух 24 ёлка'), ['два', 'двадцать', 'четыре', 'елка'])
        self.assertEqual(alignment.units('Қарақалпақ'), ['қарақалпақ'])
        alignment.LANGUAGE = 'uz'
        self.assertEqual(alignment.units('Қарақалпақ 24'), ['қарақалпақ', '24'])


class MeasuredCueTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.job = Path(self.directory.name)
        (self.job / 'audio').mkdir()
        self.manifest = {
            'language': 'kaa', 'duration': 2,
            'chapters': [{'id': 'intro', 'start': 0, 'duration': 2, 'cues': [
                {'id': 'cue-one', 'text': 'Ájiniyaz Qosıbay ulı.', 'start': 0,
                 'audioDuration': .75, 'duration': 1},
                {'id': 'cue-two', 'text': 'El, jer hám yad.', 'start': 1,
                 'audioDuration': .75, 'duration': 1},
            ]}],
        }
        self.pcm = self.write_wav()

    def write_wav(self, rate=24000, channels=1, width=2, frames=48000):
        pcm = b''.join(struct.pack('<h', index % 100 * 20) for index in range(frames))
        if width == 1:
            pcm = b'\x80' * frames
        pcm *= channels
        with wave.open(str(self.job / 'audio/intro.wav'), 'wb') as audio:
            audio.setnchannels(channels)
            audio.setsampwidth(width)
            audio.setframerate(rate)
            audio.writeframes(pcm)
        return pcm

    def test_cue_report_attests_exact_text_pcm_cuts_without_word_claims(self):
        report = alignment.measured_cue_alignment(self.job, self.manifest)
        self.assertEqual(report['version'], 2)
        self.assertEqual(report['timingGranularity'], 'cue')
        self.assertEqual(report['method'], 'measured PCM cue boundaries')
        self.assertEqual(report['summary'], {'allReady': True, 'completed': 2, 'expected': 2})
        self.assertNotIn('minimumLexicalCoverage', report['summary'])
        for index, entry in enumerate(report['cues']):
            text = self.manifest['chapters'][0]['cues'][index]['text']
            start, end = index * 24000, index * 24000 + 18000
            self.assertEqual((entry['cutSampleStart'], entry['cutSampleEnd']), (start, end))
            self.assertEqual(entry['cuePcmSha256'], hashlib.sha256(self.pcm[start * 2:end * 2]).hexdigest())
            self.assertEqual(entry['referenceTextSha256'], hashlib.sha256(text.encode()).hexdigest())
            self.assertEqual(entry['segments'], [{'text': text, 'start': 0, 'end': .75}])
            self.assertEqual(entry['chapterAudioSha256'],
                             hashlib.sha256((self.job / 'audio/intro.wav').read_bytes()).hexdigest())
            self.assertEqual(entry['words'], [])
            self.assertEqual(entry['anchors'], [])
            self.assertNotIn('matchStats', entry)

    def test_karakalpak_main_never_calls_asr(self):
        (self.job / 'input.json').write_text(json.dumps(self.manifest))
        output = self.job / 'alignment.json'
        previous = alignment.LANGUAGE
        self.addCleanup(setattr, alignment, 'LANGUAGE', previous)
        with patch.object(sys, 'argv', ['align2d', '--job', str(self.job), '--cli', '/no-asr',
                                       '--output', str(output)]), \
                patch.object(alignment.subprocess, 'run', side_effect=AssertionError('ASR called')):
            alignment.main()
        self.assertTrue(json.loads(output.read_text())['passed'])
        self.assertTrue((self.job / '.trusted-asr').is_dir())

    def test_wrong_wav_format_and_duration_are_rejected(self):
        for options in [{'rate': 16000}, {'channels': 2}, {'width': 1}, {'frames': 50000}]:
            with self.subTest(options=options):
                self.write_wav(**options)
                with self.assertRaisesRegex(RuntimeError, 'ALIGNMENT_INVALID_MEASURED_CUE'):
                    alignment.measured_cue_alignment(self.job, self.manifest)

    def test_missing_reference_and_invalid_timeline_are_rejected(self):
        cases = [
            ('missing text', lambda m: m['chapters'][0]['cues'][0].pop('text')),
            ('blank text', lambda m: m['chapters'][0]['cues'][0].update(text='  ')),
            ('unrelated reference type', lambda m: m['chapters'][0]['cues'][0].update(text={'other': 'text'})),
            ('missing voice duration', lambda m: m['chapters'][0]['cues'][0].pop('audioDuration')),
            ('zero voice duration', lambda m: m['chapters'][0]['cues'][0].update(audioDuration=0)),
            ('cue gap', lambda m: m['chapters'][0]['cues'][1].update(start=1.1)),
            ('fractional sample', lambda m: m['chapters'][0]['cues'][1].update(start=1 + 1 / 48000)),
            ('voice outside cue', lambda m: m['chapters'][0]['cues'][1].update(audioDuration=1.1)),
            ('truncated chapter timeline', lambda m: m['chapters'][0]['cues'].pop()),
            ('duplicate cue', lambda m: m['chapters'][0]['cues'][1].update(id='cue-one')),
            ('nonfinite duration', lambda m: m.update(duration=float('nan'))),
            ('wrong language', lambda m: m.update(language='ru')),
            ('missing chapters', lambda m: m.pop('chapters')),
        ]
        for name, mutate in cases:
            with self.subTest(name=name):
                manifest = copy.deepcopy(self.manifest)
                mutate(manifest)
                with self.assertRaisesRegex(RuntimeError, 'ALIGNMENT_INVALID_MEASURED_CUE'):
                    alignment.measured_cue_alignment(self.job, manifest)

    def test_source_pcm_may_not_be_shorter_than_timeline(self):
        manifest = copy.deepcopy(self.manifest)
        # Even a fraction of a millisecond cannot be attested as source PCM
        # when its samples do not exist in the source file.
        self.write_wav(frames=47990)
        manifest['chapters'][0]['cues'][1]['audioDuration'] = 1
        with self.assertRaisesRegex(RuntimeError, 'chapter WAV duration'):
            alignment.measured_cue_alignment(self.job, manifest)

    def test_long_artificial_hold_is_rejected(self):
        manifest = copy.deepcopy(self.manifest)
        manifest['duration'] = 6
        manifest['chapters'][0]['duration'] = 6
        manifest['chapters'][0]['cues'][0]['duration'] = 5
        manifest['chapters'][0]['cues'][1]['start'] = 5
        self.write_wav(frames=144000)
        with self.assertRaisesRegex(RuntimeError, 'cue hold'):
            alignment.measured_cue_alignment(self.job, manifest)

    def test_word_mode_does_not_accept_measured_cue_policy(self):
        for language in ['ru', 'uz']:
            with self.subTest(language=language):
                manifest = copy.deepcopy(self.manifest)
                manifest['language'] = language
                with self.assertRaisesRegex(RuntimeError, 'language'):
                    alignment.measured_cue_alignment(self.job, manifest)

    def test_russian_and_uzbek_main_keep_existing_verified_word_report(self):
        previous = alignment.LANGUAGE
        self.addCleanup(setattr, alignment, 'LANGUAGE', previous)
        cache = self.job / '.trusted-asr/intro'
        cache.mkdir(parents=True)
        for language, phrases in [('ru', ['Привет друг', 'Пока друг']),
                                  ('uz', ['Salom dunyo', 'Xayr dunyo'])]:
            with self.subTest(language=language):
                manifest = copy.deepcopy(self.manifest)
                manifest['language'] = language
                transcript = []
                for index, text in enumerate(phrases):
                    manifest['chapters'][0]['cues'][index]['text'] = text
                    transcript += [{'text': word, 'start': index + .1 + part * .3,
                                    'end': index + .3 + part * .3}
                                   for part, word in enumerate(text.split())]
                (self.job / 'input.json').write_text(json.dumps(manifest))
                (cache / 'provenance.json').write_text(json.dumps({
                    'audioSha256': hashlib.sha256((self.job / 'audio/intro.wav').read_bytes()).hexdigest(),
                    'model': 'small', 'language': language,
                }))
                (cache / 'transcript.json').write_text(json.dumps(transcript))
                output = self.job / 'word-alignment.json'
                with patch.object(sys, 'argv', ['align2d', '--job', str(self.job), '--cli', '/no-asr',
                                               '--output', str(output)]), \
                        patch.object(alignment.subprocess, 'run', side_effect=AssertionError('ASR called')):
                    alignment.main()
                report = json.loads(output.read_text())
                self.assertEqual(report['version'], 1)
                self.assertEqual(report['model'], 'small')
                self.assertEqual(report['summary']['minimumLexicalCoverage'], 1)
                self.assertTrue(all(cue['words'] for cue in report['cues']))
                self.assertNotIn('timingGranularity', report)

    def test_truncated_and_symlinked_audio_are_rejected(self):
        file = self.job / 'audio/intro.wav'
        data = file.read_bytes()
        file.write_bytes(data[:-2])
        with self.assertRaisesRegex(RuntimeError, 'truncated WAV'):
            alignment.measured_cue_alignment(self.job, self.manifest)
        target = self.job / 'real-audio.wav'
        target.write_bytes(data)
        file.unlink()
        file.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'ALIGNMENT_INVALID_LOCAL_FILE'):
            alignment.measured_cue_alignment(self.job, self.manifest)


if __name__ == '__main__':
    unittest.main()
