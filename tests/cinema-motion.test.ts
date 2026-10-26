import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { labCues, labCueAt, labCueById } from '../client/src/lesson/labCues.js';
import { labFormulaAt } from '../client/src/lesson/labFormula.js';
import { sceneProgressAt } from '../client/src/lesson/lessonMotion.js';
import type { CinemaChapter, DerivativeSceneKey } from '../client/src/lesson/types.js';

test('spatial action cues match the preserved finished voice timeline in all ten chapters', async () => {
  const lesson = JSON.parse(await readFile(new URL('../content/derivative/lesson.json', import.meta.url), 'utf8'));
  const voice = JSON.parse(await readFile(new URL('../content/derivative/voice/voice.json', import.meta.url), 'utf8'));
  for (const chapter of lesson.chapters as CinemaChapter[]) {
    const audio = voice.chapters.find((entry: { id: string }) => entry.id === chapter.id);
    assert.ok(audio, chapter.id);
    const actual = { ...chapter, duration: audio.duration + 2.5,
      beats: chapter.beats!.map((beat, index) => ({ ...beat, at: audio.beatTimes[index] })) };
    const cues = labCues[chapter.scene];
    assert.ok(cues.length >= 5);
    assert.equal(cues[0].at, 0);
    assert.equal(new Set(cues.map(cue => cue.id)).size, cues.length);
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      assert.ok(cue.at < audio.duration, `${chapter.id}/${cue.id} after voice`);
      if (i) assert.ok(cue.at > cues[i - 1].at && cue.progress > cues[i - 1].progress);
      const expected = sceneProgressAt(actual, cue.at / actual.duration);
      assert.ok(Math.abs(expected - cue.progress) < 1e-7, `${chapter.id}/${cue.id} drift`);
      assert.equal(labCueAt(chapter.scene, cue.progress + 1e-8).id, cue.id);
      if (i) assert.equal(labCueAt(chapter.scene, cue.progress - 1e-8).id, cues[i - 1].id);
    }
  }
});

test('numeric results appear at their spoken word, and reverse seeking restores the earlier statement', () => {
  const cases: [DerivativeSceneKey, string, string][] = [
    ['motion', 'mark-9', '9 м'], ['secant', 'h-001', '0,01'],
    ['tangent', 'coffee-69', '69 °C'], ['rules', 'six-x', '6x'],
    ['chain', 'chain-result', '6(3x + 1)'], ['extrema', 'ball-height-4', '4 м'],
  ];
  for (const [scene, id, expected] of cases) {
    const at = labCueById(scene, id)!.at;
    const before = labFormulaAt(scene, at - .001);
    assert.ok(!before?.includes(expected), `${scene}/${id} reveals early`);
    assert.ok(labFormulaAt(scene, at)!.includes(expected), `${scene}/${id} missing`);
    labFormulaAt(scene, 600);
    assert.equal(labFormulaAt(scene, at - .001), before);
  }
});
