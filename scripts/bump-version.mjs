// 0.4.0 → 0.5.0：只改产品版本字段，绝不碰依赖包自带的版本号。
import {readFile, writeFile} from 'node:fs/promises';

const OLD = '0.4.0';
const NEW = '0.5.0';
const root = 'D:/XYP/whaleflow-v4/';
const report = [];

async function swap(file, transform) {
  const before = await readFile(root + file, 'utf8');
  const after = transform(before);
  if (after === before) { report.push(`${file}: 无改动`); return; }
  await writeFile(root + file, after);
  const count = before.split(OLD).length - 1;
  report.push(`${file}: ${count} 处候选 → 已替换`);
}

// 1. package.json：整份只有一处 version
await swap('package.json', text => text.replace(`"version": "${OLD}"`, `"version": "${NEW}"`));

// 2. package-lock.json：只动顶层与 packages[""] 的版本，依赖包版本保持原样
await swap('package-lock.json', text => {
  const lines = text.split('\n');
  let touched = 0;
  for (let index = 0; index < 12 && touched < 2; index++) {
    if (lines[index].includes(`"version": "${OLD}"`)) {
      lines[index] = lines[index].replace(`"version": "${OLD}"`, `"version": "${NEW}"`);
      touched++;
    }
  }
  return lines.join('\n');
});

// 3. 其余文件：整体替换产品版本字面量
for (const file of [
  'native-shell/server.mjs',
  'native-shell/WhaleFlow.cs',
  'tests/native-server.test.mjs',
  'scripts/v4-browser-integration.mjs',
  'scripts/release-desktop.mjs',
  'bin/wf-mcp.mjs',
]) {
  await swap(file, text => text.split(OLD).join(NEW));
}

console.log(report.join('\n'));
