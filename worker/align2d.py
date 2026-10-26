"""Trusted offline timing: measured PCM cues for Kaa, Whisper words for RU/UZ.

Immutable reference text owns captions. Cue mode makes no speech-recognition or
word-timing claims; word mode keeps the existing ASR evidence gate.
"""
import argparse
import difflib
import hashlib
import io
import json
import math
import re
import subprocess
import time
import wave
import os
import stat
import unicodedata
from pathlib import Path

LANGUAGE = 'ru'

ONES = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять']
TEENS = ['десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто']
FORMS = {'одна': 'один', 'одну': 'один', 'одного': 'один', 'одной': 'один', 'одному': 'один', 'две': 'два', 'двух': 'два', 'двум': 'два', 'двумя': 'два', 'трех': 'три', 'трем': 'три', 'тремя': 'три', 'четырех': 'четыре', 'четырем': 'четыре', 'пяти': 'пять', 'шести': 'шесть', 'семи': 'семь', 'восьми': 'восемь', 'девяти': 'девять', 'десяти': 'десять', 'двенадцати': 'двенадцать', 'пятнадцати': 'пятнадцать', 'двадцати': 'двадцать', 'тридцати': 'тридцать', 'сорока': 'сорок', 'пятидесяти': 'пятьдесят', 'нулю': 'ноль', 'нуля': 'ноль', 'нулем': 'ноль', 'javascript': 'javascript', 'джаваскрипт': 'javascript', 'джаваскрипте': 'javascript', 'джаваскрипта': 'javascript', 'undefined': 'андефайнд', 'андефайнд': 'андефайнд', 'андефайн': 'андефайнд'}
FORMS.update({'push': 'пуш', 'pop': 'поп', 'splice': 'сплайс', 'for': 'фор', 'of': 'оф', 'off': 'оф'})
NUMBERS = set(ONES + TEENS + TENS[2:] + ['сто'])
ANCHOR_WORDS = NUMBERS | {'меньше', 'равно', 'равен', 'равна', 'больше', 'сумма', 'сумму', 'максимум', 'индекс', 'индексы', 'длина', 'длину', 'длины', 'ноль', 'минус', 'первом', 'второй', 'третья', 'первый', 'последний', 'пуш', 'поп', 'сплайс', 'конст', 'андефайнд', 'вправо', 'влево', 'останавливается', 'увеличивает', 'уменьшает', 'пятнадцать'}

# Script equivalences, not translations or a pronunciation guess. Keep distinct
# Karakalpak vowels distinct; removing all accents would inflate ASR coverage.
# Cyrillic/current Latin: https://arhiiv.eki.ee/knab/lat/kblkaa.pdf (EKI, 2018).
KAA_LETTERS = str.maketrans({
    'а': 'a', 'ә': 'á', 'ə': 'á', 'б': 'b', 'в': 'v', 'г': 'g', 'ғ': 'ǵ',
    'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'j', 'з': 'z', 'и': 'i', 'й': 'y',
    'к': 'k', 'қ': 'q', 'л': 'l', 'м': 'm', 'н': 'n', 'ң': 'ń', 'о': 'o',
    'ө': 'ó', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ү': 'ú',
    'ў': 'w', 'ф': 'f', 'х': 'x', 'ҳ': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh',
    'щ': 'shch', 'ъ': '', 'ы': 'ı', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    # Whisper can label Karakalpak as Kazakh or Azerbaijani. These letters
    # represent the same sounds, without treating either language as Karakalpak.
    'і': 'i', 'ұ': 'u', 'í': 'ı', 'ä': 'á', 'ö': 'ó', 'ü': 'ú', 'ğ': 'ǵ', 'ş': 'sh',
    'ç': 'ch',
})
KAA_APOSTROPHES = {'a': 'á', 'g': 'ǵ', 'n': 'ń', 'o': 'ó', 'u': 'ú', 'i': 'ı'}


def kaa_orthography(text):
    source = unicodedata.normalize('NFC', text.lower()).replace('i\u0307', 'i')
    # Earlier official Latin spelling uses apostrophes within a letter.
    source = re.sub(r"([agnoui])['’ʻʼ‘`]", lambda m: KAA_APOSTROPHES[m[1]], source)
    return source.translate(KAA_LETTERS)

def numeric_words(n):
    if n < 10: return [ONES[n]]
    if n < 20: return [TEENS[n - 10]]
    if n < 100: return [TENS[n // 10]] + ([ONES[n % 10]] if n % 10 else [])
    if n == 100: return ['сто']
    return [str(n)]

def units(text):
    source = kaa_orthography(text) if LANGUAGE == 'kaa' else text.lower().replace('ё', 'е')
    source = re.sub(r'\b4[- ]off\b', 'фор оф', source)
    source = re.sub(r'\bненайдено\b', 'не найдено', source)
    source = re.sub(r'\bнеравно\b', 'не равно', source)
    tokens = re.findall(r'[^\W_]+', source, re.UNICODE)
    result = []
    for token in tokens:
        if token.isdigit() and len(token) <= 3 and LANGUAGE == 'ru': result.extend(numeric_words(int(token)))
        else: result.append(FORMS.get(token, token))
    return result

def sha(data): return hashlib.sha256(data).hexdigest()

def atomic(file, value):
    tmp = file.with_suffix(file.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    tmp.replace(file)

def word_units(words, timed=False):
    result = []
    for index, word in enumerate(words):
        us = units(word['text'] if timed else word)
        for part, unit in enumerate(us):
            if timed:
                start, end = float(word['start']), float(word['end'])
                result.append({'unit': unit, 'index': index, 'start': start + (end - start) * part / len(us), 'end': start + (end - start) * (part + 1) / len(us)})
            else: result.append({'unit': unit, 'index': index})
    return result

def align(reference, heard, duration):
    words = reference.split()
    a, b = word_units(words), word_units(heard, True)
    n, m = len(a), len(b)
    dp = [[0.] * (m + 1) for _ in range(n + 1)]
    back = [[None] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1): dp[i][0], back[i][0] = float(i), 'delete'
    for j in range(1, m + 1): dp[0][j], back[0][j] = float(j), 'insert'
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            x, y = a[i-1]['unit'], b[j-1]['unit']
            similarity = 1. if x == y else difflib.SequenceMatcher(None, x, y).ratio()
            substitution = 0. if x == y else (1. - similarity if similarity >= .65 else 1.15)
            cost, operation = min((dp[i-1][j-1] + substitution, 'match'), (dp[i-1][j] + 1., 'delete'), (dp[i][j-1] + 1., 'insert'))
            dp[i][j], back[i][j] = cost, operation
    paired = {}
    i, j = n, m
    while i or j:
        action = back[i][j]
        if action == 'match':
            x, y = a[i-1]['unit'], b[j-1]['unit']
            similarity = 1. if x == y else difflib.SequenceMatcher(None, x, y).ratio()
            if similarity >= .65:
                paired.setdefault(a[i-1]['index'], []).append((b[j-1], similarity))
            i -= 1; j -= 1
        elif action == 'delete': i -= 1
        elif action == 'insert': j -= 1
        else: raise RuntimeError('Alignment backtrace failed')
    aligned = []
    for index, text in enumerate(words):
        matches = paired.get(index, [])
        if matches:
            confidence = sum(score for _, score in matches) / len(matches)
            aligned.append({'text': text, 'start': max(0., min(item['start'] for item, _ in matches)), 'end': min(duration, max(item['end'] for item, _ in matches)), 'match': 'exact' if confidence == 1. else 'normalized', 'confidence': round(confidence, 3)})
        else: aligned.append({'text': text, 'start': None, 'end': None, 'match': 'interpolated', 'confidence': 0.})
    index = 0
    while index < len(aligned):
        if aligned[index]['start'] is not None: index += 1; continue
        first = index
        while index < len(aligned) and aligned[index]['start'] is None: index += 1
        left = aligned[first-1]['end'] if first else 0.
        right = aligned[index]['start'] if index < len(aligned) else duration
        right = max(left, right)
        weights = [max(1, len(re.sub(r'\W', '', item['text']))) for item in aligned[first:index]]
        total = sum(weights)
        for item, weight in zip(aligned[first:index], weights):
            end = left + (right - left) * weight / total
            item['start'], item['end'] = left, end
            total -= weight; left = end
    previous = 0.
    for item in aligned:
        item['start'] = round(max(previous, min(duration, item['start'])), 3)
        item['end'] = round(max(item['start'], min(duration, item['end'])), 3)
        previous = item['end']
    exact = sum(item['match'] == 'exact' for item in aligned)
    interpolated = [index for index, item in enumerate(aligned) if item['match'] == 'interpolated']
    lexical = [index for index, text in enumerate(words) if units(text)]
    lexical_missing = [index for index in interpolated if index in lexical]
    stats = {'lexicalReferenceWords': len(lexical), 'lexicalMatchedWords': len(lexical) - len(lexical_missing), 'lexicalCoverage': round((len(lexical) - len(lexical_missing)) / max(1, len(lexical)), 4), 'referenceWords': len(words), 'asrWords': len(heard), 'matchedWords': len(words) - len(interpolated), 'exactOrNumberNormalizedWords': exact, 'fuzzyWords': len(words) - exact - len(interpolated), 'interpolatedWords': len(interpolated), 'coverage': round((len(words) - len(interpolated)) / max(1, len(words)), 4), 'normalizedEditDistance': round(dp[n][m] / max(1, n, m), 4), 'interpolatedIndices': interpolated}
    anchors = []
    for index, item in enumerate(aligned):
        canonical = units(item['text'])
        if any(token in ANCHOR_WORDS for token in canonical):
            anchors.append({'text': item['text'], 'at': item['start'], 'end': item['end'], 'referenceWordIndex': index, 'confidence': item['confidence']})
    return aligned, anchors, stats

def safe_file(file, limit=64*1024*1024):
    info=file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size>limit:
        raise RuntimeError('ALIGNMENT_INVALID_LOCAL_FILE')
    return file.read_bytes()


def measured_cue_alignment(job, manifest):
    """Attest source PCM cue boundaries without claiming to recognize speech.

    Whisper has no Karakalpak language mode. Its guessed language and word
    spelling cannot verify this narration. The independently synthesized cues
    already have immutable, sample-measured starts and lengths. Expose those
    boundaries explicitly rather than inventing per-word timestamps or scores.
    """
    rate = 24000

    def check(value, reason):
        if not value:
            raise RuntimeError('ALIGNMENT_INVALID_MEASURED_CUE: ' + reason)

    def frames(value, label):
        check(isinstance(value, (int, float)) and not isinstance(value, bool)
              and math.isfinite(value) and 0 <= value <= 600, label)
        count = round(value * rate)
        check(abs(value * rate - count) <= .00001, label + ' sample boundary')
        return count

    check(isinstance(manifest, dict) and manifest.get('language') == 'kaa', 'language')
    chapters = manifest.get('chapters')
    check(isinstance(chapters, list) and 0 < len(chapters) <= 40, 'chapters')
    target_frames = frames(manifest.get('duration'), 'duration')
    check(target_frames > 0, 'duration')
    chapter_ids, cue_ids, entries = set(), set(), []
    chapter_cursor = 0
    for chapter in chapters:
        check(isinstance(chapter, dict), 'chapter')
        cid = chapter.get('id')
        check(isinstance(cid, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', cid)
              and cid not in chapter_ids, 'chapter id')
        chapter_ids.add(cid)
        chapter_start = frames(chapter.get('start'), 'chapter start')
        chapter_length = frames(chapter.get('duration'), 'chapter duration')
        check(chapter_start == chapter_cursor and chapter_length > 0, 'chapter timeline')
        data = safe_file(job / 'audio' / (cid + '.wav'))
        try:
            with wave.open(io.BytesIO(data), 'rb') as audio:
                check(audio.getnchannels() == 1 and audio.getsampwidth() == 2
                      and audio.getframerate() == rate and audio.getcomptype() == 'NONE',
                      '24kHz mono PCM16 required')
                sample_count = audio.getnframes()
                pcm = audio.readframes(sample_count)
        except (wave.Error, EOFError):
            raise RuntimeError('ALIGNMENT_INVALID_MEASURED_CUE: invalid WAV') from None
        check(len(pcm) == sample_count * 2 and sample_count > 0, 'truncated WAV')
        check(sample_count == chapter_length, 'chapter WAV duration')
        audio_hash = sha(data)
        cues = chapter.get('cues')
        check(isinstance(cues, list) and 0 < len(cues) <= 40, 'chapter cues')
        cue_cursor = 0
        for cue in cues:
            check(isinstance(cue, dict), 'cue')
            cue_id = cue.get('id')
            check(isinstance(cue_id, str) and re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', cue_id)
                  and cue_id not in cue_ids, 'cue id')
            cue_ids.add(cue_id)
            reference = cue.get('text')
            check(isinstance(reference, str) and bool(reference.strip()), 'cue reference')
            cue_start = frames(cue.get('start'), 'cue start') - chapter_start
            cue_length = frames(cue.get('duration'), 'cue duration')
            voice_length = frames(cue.get('audioDuration'), 'cue audio duration')
            check(cue_start == cue_cursor and voice_length > 0 and cue_length >= voice_length,
                  'cue timeline')
            check(cue_length - voice_length <= rate * 3.001, 'cue hold')
            cut_end = cue_start + voice_length
            check(0 <= cue_start < cut_end <= sample_count, 'cue PCM cut')
            check(cue_start + cue_length <= chapter_length, 'cue outside chapter')
            entries.append({
                'id': cue_id, 'chapter': cid, 'chapterAudioSha256': audio_hash,
                'referenceTextSha256': sha(reference.encode()), 'referenceText': reference,
                'duration': cue['audioDuration'], 'cutSampleStart': cue_start,
                'cutSampleEnd': cut_end, 'cuePcmSha256': sha(pcm[cue_start * 2:cut_end * 2]),
                'words': [], 'anchors': [],
                'segments': [{'text': reference, 'start': 0, 'end': cue['audioDuration']}],
            })
            cue_cursor += cue_length
        check(cue_cursor == chapter_length, 'incomplete chapter cues')
        chapter_cursor += chapter_length
    check(chapter_cursor == target_frames and len(entries) <= 40, 'incomplete lesson timeline')
    return {
        'passed': True, 'version': 2, 'language': 'kaa', 'timingGranularity': 'cue',
        'method': 'measured PCM cue boundaries', 'sampleRate': rate, 'channels': 1,
        'bitsPerSample': 16, 'cues': entries,
        'summary': {'allReady': True, 'completed': len(entries), 'expected': len(cue_ids)},
    }

def main():
    global LANGUAGE
    parser=argparse.ArgumentParser()
    parser.add_argument('--job', required=True)
    parser.add_argument('--cli', required=True)
    parser.add_argument('--output', required=True)
    args=parser.parse_args()
    job=Path(args.job).resolve()
    manifest=json.loads(safe_file(job/'input.json', 2*1024*1024))
    LANGUAGE=manifest.get('language','ru')
    if LANGUAGE not in ('ru','uz','kaa'): raise RuntimeError('ALIGNMENT_INVALID_LANGUAGE')
    cache=job/'.trusted-asr'
    cache.mkdir(exist_ok=True, mode=0o700)
    if cache.is_symlink(): raise RuntimeError('ALIGNMENT_INVALID_CACHE')
    if LANGUAGE == 'kaa':
        try:
            report = measured_cue_alignment(job, manifest)
        except RuntimeError as error:
            atomic(Path(args.output), {'passed': False, 'version': 2, 'language': 'kaa',
                                      'timingGranularity': 'cue', 'issues': [str(error)]})
            raise
        atomic(Path(args.output), report)
        print('ALIGNMENT COMPLETE ' + str(report['summary']['completed']), flush=True)
        return
    entries=[]
    for chapter in manifest['chapters']:
        cid=chapter['id']
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}',cid): raise RuntimeError('ALIGNMENT_INVALID_ID')
        audio=job/'audio'/(cid+'.wav')
        data=safe_file(audio)
        audio_hash=sha(data)
        directory=cache/cid
        directory.mkdir(exist_ok=True, mode=0o700)
        if directory.is_symlink(): raise RuntimeError('ALIGNMENT_INVALID_CACHE')
        transcript=directory/'transcript.json'
        stamp=directory/'provenance.json'
        expected={'audioSha256':audio_hash,'model':'small','language':LANGUAGE}
        cached=json.loads(safe_file(stamp,16384)) if stamp.exists() else {}
        if cached != expected or not transcript.exists():
            transcript.unlink(missing_ok=True)
            print('ASR '+cid, flush=True)
            command=[os.environ.get('NODE_BIN','node'),args.cli,'transcribe',str(audio),'--dir',str(directory),'--engine','whisper','--model','small','--no-runtime-install','--json']
            if LANGUAGE!='kaa': command += ['--language',LANGUAGE]
            with (directory/'run.log').open('w') as log:
                result=subprocess.run(command,cwd=directory,stdout=log,stderr=log,timeout=600)
            if result.returncode or not transcript.exists(): raise RuntimeError('ALIGNMENT_ASR_FAILED: '+cid)
            atomic(stamp,expected)
        raw=json.loads(safe_file(transcript,2*1024*1024))
        heard=raw.get('words',[]) if isinstance(raw,dict) else raw
        if not isinstance(heard,list) or not heard: raise RuntimeError('ALIGNMENT_EMPTY_TRANSCRIPT: '+cid)
        for cue in chapter['cues']:
            start=cue['start']-chapter['start']
            duration=cue['audioDuration']
            selected=[]
            for word in heard:
                a,b=float(word['start']),float(word['end'])
                if start <= (a+b)/2 < start+duration:
                    selected.append({'text':word['text'],'start':max(0,a-start),'end':min(duration,b-start)})
            aligned,anchors,stats=align(cue['text'],selected,duration)
            entry={'id':cue['id'],'chapter':cid,'chapterAudioSha256':audio_hash,'referenceTextSha256':sha(cue['text'].encode()),'referenceText':cue['text'],'duration':duration,'words':aligned,'anchors':anchors,'matchStats':stats}
            entries.append(entry)
            if stats['lexicalCoverage']<.65:
                atomic(Path(args.output),{'passed':False,'cues':entries,'issues':['ALIGNMENT_LOW_COVERAGE: '+cue['id']]})
                raise RuntimeError('ALIGNMENT_LOW_COVERAGE: '+cue['id'])
            print('ALIGNMENT '+cue['id']+' '+str(stats['lexicalCoverage']),flush=True)
    expected_count=sum(len(c['cues']) for c in manifest['chapters'])
    report={'passed':True,'version':1,'language':LANGUAGE,'engine':'offline whisper.cpp','model':'small','captionSource':'exact immutable reference text','timing':'seconds relative to each cue start; original speed','cues':entries,'summary':{'allReady':len(entries)==expected_count,'completed':len(entries),'expected':expected_count,'minimumLexicalCoverage':min(x['matchStats']['lexicalCoverage'] for x in entries),'lexicalCoverage':sum(x['matchStats']['lexicalMatchedWords'] for x in entries)/max(1,sum(x['matchStats']['lexicalReferenceWords'] for x in entries))}}
    atomic(Path(args.output),report)
    print('ALIGNMENT COMPLETE '+str(expected_count),flush=True)

if __name__=='__main__':
    main()

