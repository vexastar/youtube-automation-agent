const path = require('path');
const fs = require('fs');
const { AIVideoGenerator } = require('./utils/ai-video-generator');

(async () => {
  try {
    const gen = new AIVideoGenerator({});
    const tempDir = path.resolve(__dirname, 'temp', 'processing');
    const scene0 = path.join(tempDir, 'scene0.mp4');
    const scene1 = path.join(tempDir, 'scene1.mp4');
    const introAudio = path.join(tempDir, 'intro_audio.m4a');
    const outputDir = path.resolve(__dirname, 'data', 'shorts');
    const productionId = `test_${Date.now()}`;

    if (!fs.existsSync(scene0) || !fs.existsSync(scene1) || !fs.existsSync(introAudio)) {
      throw new Error('Required test assets missing in temp/processing');
    }

    console.log('Starting generateIntroShort test...');
    const result = await gen.generateIntroShort(
      introAudio,
      scene0,
      outputDir,
      productionId,
      [ { path: scene0 }, { path: scene1 } ]
    );

    console.log('generateIntroShort result:', result);
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
})();
