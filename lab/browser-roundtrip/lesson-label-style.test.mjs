import test from 'node:test';
import assert from 'node:assert/strict';
import { lessonLabelInk, LESSON_LABEL_BACKGROUND_OPACITY } from './lesson-label-style.mjs';
import { motionFixture } from './motion-benchmark-fixture.mjs';

const luminance = color => [color >>> 16 & 255, color >>> 8 & 255, color & 255]
  .map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
  .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);

test('bright authored hues have at least 4.5:1 contrast on opaque white; dark ink stays exact', () => {
  assert.equal(LESSON_LABEL_BACKGROUND_OPACITY, 1);
  for (const color of [0xffffff, 0xffff00, 0xff9900, 0x55ffbb, 0xff00ff, 0x888888, 0]) {
    const ink = lessonLabelInk(color);
    assert.ok(1.05 / (luminance(ink) + .05) >= 4.5);
    assert.equal(lessonLabelInk(ink), ink);
  }
  assert.equal(lessonLabelInk(0x303840), 0x303840);
  assert.equal(lessonLabelInk(0xff9900), 0x704300);
});

test('real figure and moving tether plates receive the same contrast policy', async () => {
  const h = await motionFixture();
  try {
    const [, tether] = h.registry.tetherRepresentations();
    const labels = [...h.figure.annotations(), tether].filter(repr => repr?.renderObjects.some(o => o.type === 'text'));
    assert.ok(labels.length > 1);
    for (const repr of labels) {
      assert.equal(repr.props.backgroundOpacity, 1);
      for (const object of repr.renderObjects.filter(o => o.type === 'text')) {
        assert.equal(object.values.uBackgroundOpacity.ref.value, 1);
        assert.equal(object.state.stereofoldLessonLabel, true);
        const v = object.values;
        const channels = v.dColorType.ref.value === 'uniform'
          ? Array.from(v.uColor.ref.value, c => Math.round(c * 255)) : v.tColor.ref.value.array;
        assert.ok(channels.every(c => c <= 112), 'the rendered ink uses the contrast mapping');
      }
    }
  } finally { await h.dispose(); }
});
