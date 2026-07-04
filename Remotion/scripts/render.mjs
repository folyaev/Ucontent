import {spawnSync} from 'node:child_process';
import path from 'node:path';

const presets = {
  // Legacy / 2x Resolution
  '2x1': {
    composition: 'Quote2x1',
    output: 'out/generated-2x1.mp4',
    args: ['--codec=h264', '--crf=16'],
  },
  '2x1-alpha': {
    composition: 'Quote2x1Alpha',
    output: 'out/generated-2x1-alpha.webm',
    args: ['--codec=vp8', '--pixel-format=yuva420p', '--image-format=png'],
  },
  '1x1': {
    composition: 'Quote1x1',
    output: 'out/generated-1x1.mp4',
    args: ['--codec=h264', '--crf=16'],
  },
  '1x1-alpha': {
    composition: 'Quote1x1Alpha',
    output: 'out/generated-1x1-alpha.webm',
    args: ['--codec=vp8', '--pixel-format=yuva420p', '--image-format=png'],
  },
  // Target / 1x Resolution (1920x960 and 960x960)
  'news-2x1': {
    composition: 'News2x1-Target',
    output: 'out/generated-news-2x1.mp4',
    args: ['--codec=h264', '--crf=16'],
  },
  'news-2x1-alpha': {
    composition: 'News2x1Alpha-Target',
    output: 'out/generated-news-2x1-alpha.webm',
    args: ['--codec=vp8', '--pixel-format=yuva420p', '--image-format=png'],
  },
  'news-1x1': {
    composition: 'News1x1-Target',
    output: 'out/generated-news-1x1.mp4',
    args: ['--codec=h264', '--crf=16'],
  },
  'news-1x1-alpha': {
    composition: 'News1x1Alpha-Target',
    output: 'out/generated-news-1x1-alpha.webm',
    args: ['--codec=vp8', '--pixel-format=yuva420p', '--image-format=png'],
  },
  'quote-2x1': {
    composition: 'Quote2x1-Target',
    output: 'out/generated-quote-2x1.mp4',
    args: ['--codec=h264', '--crf=16'],
  },
  'quote-2x1-alpha': {
    composition: 'Quote2x1Alpha-Target',
    output: 'out/generated-quote-2x1-alpha.webm',
    args: ['--codec=vp8', '--pixel-format=yuva420p', '--image-format=png'],
  },
  'quote-1x1': {
    composition: 'Quote1x1-Target',
    output: 'out/generated-quote-1x1.mp4',
    args: ['--codec=h264', '--crf=16'],
  },
  'quote-1x1-alpha': {
    composition: 'Quote1x1Alpha-Target',
    output: 'out/generated-quote-1x1-alpha.webm',
    args: ['--codec=vp8', '--pixel-format=yuva420p', '--image-format=png'],
  },
};

const [format, propsPath, outputPath] = process.argv.slice(2);
const preset = presets[format];

if (!preset || !propsPath) {
  console.error('Usage: npm run generate -- <2x1|2x1-alpha|1x1|1x1-alpha> <props.json> [output]');
  process.exit(1);
}

const output = outputPath || preset.output;
const command =
  process.platform === 'win32'
    ? path.join('node_modules', '.bin', 'remotion.cmd')
    : path.join('node_modules', '.bin', 'remotion');
const args = [
  'render',
  'src/index.ts',
  preset.composition,
  output,
  `--props=${path.normalize(propsPath)}`,
  ...preset.args,
];

const result = spawnSync(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
}

process.exit(result.status ?? 1);
