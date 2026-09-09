import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWeixinLinks } from '../src/links.js';
import { splitText } from '../src/common.js';
import { fixture } from './helpers.js';

const web = 'https://cockpit.example.test';
const png = '/uploads/upload-v1-1788930036536-8e10e8bd51aab4c13ae344c6ce3c599a.png';

test('Markdown image and file references retain clickable original HTTPS URLs', () => {
  assert.equal(renderWeixinLinks(`![Logo](${png})`, web), `Logo（原文件链接）：\n${web}${png}\n`);
  assert.equal(renderWeixinLinks('[源图](/uploads/source.svg "下载")', web),
    `源图：\n${web}/uploads/source.svg\n`);
  assert.equal(renderWeixinLinks('[文件](</uploads/report.pdf>)', web),
    `文件：\n${web}/uploads/report.pdf\n`);
  assert.ok(renderWeixinLinks(`![Logo][original]\n\n[original]: ${png}`, web).includes(web + png));
  assert.ok(renderWeixinLinks('[下载][f]\n[f]: /uploads/test.zip', web).includes(web + '/uploads/test.zip'));
  assert.ok(renderWeixinLinks('[文件]\n\n[文件]: /uploads/report.pdf', web).includes(web + '/uploads/report.pdf'));
  assert.equal(renderWeixinLinks(`文件： ${png}`, web), `文件： ${web}${png}`);
  assert.equal(renderWeixinLinks('普通文本和中文🙂', web), '普通文本和中文🙂');
  assert.equal(renderWeixinLinks('[官网](https://example.test/page)', web),
    '官网：\nhttps://example.test/page\n');
});

test('unmatched Markdown delimiters do not cause quadratic scanning or remove plain text', () => {
  const value = '['.repeat(100000);
  const start = performance.now();
  assert.equal(renderWeixinLinks(value, web), value);
  assert.ok(performance.now() - start < 2000);
  assert.equal(renderWeixinLinks('[plain array]', web), '[plain array]');
  assert.throws(() => renderWeixinLinks('a'.repeat(1000001), web), { code: 'EMPTY_OR_OVERSIZED_REPLY' });
});

test('unsupported local, unsafe and malformed references downgrade without upload or local paths', () => {
  for (const path of ['/uploads/../secret', '/uploads/%2e%2e/secret', '/uploads/a/b.png',
    '/uploads/a.png?x=secret', 'file:///home/user/private.png', 'sandbox:/mnt/data/pic.png',
    '/home/user/pic.png', 'assets/logo.png', 'data:image/png;base64,SECRET', '//evil.test/pic.png',
    'javascript:alert(1)', 'https://cockpit.example.test/uploads/../secret',
    'https://user:password@example.test/a.png']) {
    const result = renderWeixinLinks(`![图片](${path})`, web);
    assert.ok(result.includes('暂不支持微信打开'), path);
    assert.ok(!result.includes(path), path);
  }
  assert.ok(renderWeixinLinks('![缺失][none]', web).includes('暂不支持'));
  assert.ok(!renderWeixinLinks('![/home/user/secret.png](/uploads/logo.png)', web).includes('/home/user'));
  assert.ok(renderWeixinLinks(`![Logo](${png})`, 'http://127.0.0.1:8771').includes('暂不支持'));
});

test('reply chunking never cuts the original file URL and refuses an oversized URL', () => {
  const url = web + png;
  const value = '中文🙂'.repeat(30) + '\n' + renderWeixinLinks(`![Logo](${png})`, web);
  const parts = splitText(value, 256, 20);
  assert.ok(parts.every(part => Buffer.byteLength(part) <= 256));
  assert.equal(parts.filter(part => part.includes(url)).length, 1);
  assert.equal(parts.map(part => part.replace(/^\[\d+\/\d+\] /u, '')).join(''), value);
  assert.throws(() => splitText('https://example.test/' + 'a'.repeat(200), 128, 20),
    { code: 'LINK_TOO_LONG_FOR_REPLY_PART' });
});

test('real HTTP mocks deliver native file links while preserving original history evidence and dedup', async t => {
  const f = await fixture(t, { repeatBatch: true });
  f.config.limits.textBytes = 256;
  await f.bridge.receive(); await f.bridge.step();
  const reply = `这是原图：\n[Logo原文件](${png})\n[SVG源文件](/uploads/logo.svg)`;
  f.finish(reply);
  await f.drain();
  assert.equal(f.store.jobs()[0].status, 'done');
  assert.equal(f.state.messages.at(-1).content, reply);
  assert.deepEqual(f.sent.map(row => row.msg.item_list[0].type), [1, 2, 4]);
  assert.equal(f.sent[2].msg.item_list[0].file_item.file_name, 'logo.svg');
  const count = f.sent.length;
  await f.bridge.receive(); await f.bridge.step();
  assert.equal(f.sent.length, count);
  assert.equal(f.prompts.length, 1);
  assert.ok(f.requests.some(request => request.url === '/intent/files/get'));
});
