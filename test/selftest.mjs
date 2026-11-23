/* 纯函数自测：node test/selftest.mjs
 * 覆盖 SSE 分块解析、Markdown 语法与 XSS、旧版数据迁移。
 */

import assert from 'node:assert/strict';
import { createSSEParser } from '../public/js/sse.js';
import { renderMarkdown, renderInline, escapeHtml } from '../public/js/markdown.js';
import * as Store from '../public/js/store.js';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.error('  ✗ ' + name);
    console.error('    ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e));
    process.exitCode = 1;
  }
}

console.log('\nSSE 解析');
ok('跨分片 + 多行 data + CRLF + 注释', () => {
  const events = [];
  const p = createSSEParser((ev) => events.push(ev));
  p.push('data: {"type":"server.conne');
  p.push('cted","properties":{}}\n\n: keep-alive\n\n');
  p.push('data: {"type":"message.part.delta",\r\ndata: "properties":{"delta":"hi"}}\r\n\r\n');
  p.push('data: 不是 JSON\n\n');
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'server.connected');
  assert.equal(events[1].type, 'message.part.delta');
  assert.equal(events[1].properties.delta, 'hi');
});

ok('event: 行不影响 JSON type', () => {
  const events = [];
  const p = createSSEParser((ev) => events.push(ev));
  p.push('event: ping\ndata: {"type":"server.heartbeat","properties":{}}\n\n');
  assert.equal(events[0].type, 'server.heartbeat');
});

ok('无末尾空行时 flush 仍能解析', () => {
  const events = [];
  const p = createSSEParser((ev) => events.push(ev));
  p.push('data: {"type":"session.idle","properties":{}}');
  p.flush();
  assert.equal(events[0].type, 'session.idle');
});

console.log('\nMarkdown');
ok('标题 / 粗体 / 行内代码', () => {
  const html = renderMarkdown('# 标题\n\n**粗** 与 `code`');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /<strong>粗<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

ok('围栏代码块带语言与复制按钮', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2;\n```');
  assert.match(html, /class="md-code"/);
  assert.match(html, /class="language-js"/);
  assert.match(html, /const a = 1 &lt; 2;/);
  assert.match(html, /data-copy-code/);
});

ok('未闭合围栏在流式时标记 is-streaming', () => {
  const html = renderMarkdown('```js\nconst a = 1', { streaming: true });
  assert.match(html, /is-streaming/);
  assert.match(html, /const a = 1/);
});

ok('有序 / 无序 / 嵌套列表', () => {
  const html = renderMarkdown('- a\n  - b\n- c\n\n1. x\n2. y');
  assert.match(html, /<ul>/);
  assert.match(html, /<ol>/);
  assert.match(html, /<li>c<\/li>/);
  const nested = html.split('<ul>').length - 1;
  assert.ok(nested >= 2, '应有嵌套 ul');
});

ok('任务列表', () => {
  const html = renderMarkdown('- [x] 完成\n- [ ] 未完成');
  assert.match(html, /md-task on/);
  assert.match(html, /md-task"/);
});

ok('表格', () => {
  const html = renderMarkdown('| A | B |\n| --- | ---: |\n| 1 | 2 |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, />2<\/td>/);
});

ok('引用与分隔线', () => {
  const html = renderMarkdown('> 引用\n\n---');
  assert.match(html, /<blockquote>/);
  assert.match(html, /<hr>/);
});

ok('HTML 一律转义（XSS）', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.ok(!html.includes('<img'), '不应出现原始 img 标签');
  assert.match(html, /&lt;img/);
});

ok('javascript: 链接被拒绝', () => {
  const html = renderInline('[点我](javascript:alert(1))');
  assert.ok(!/href="javascript/i.test(html), '不应生成 javascript 链接');
});

ok('https 链接加 noopener', () => {
  const html = renderInline('[官网](https://example.com)');
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

ok('裸 URL 自动链接并剥离句末标点', () => {
  const html = renderInline('看 https://example.com/a。');
  assert.match(html, /href="https:\/\/example\.com\/a"/);
});

ok('escapeHtml 覆盖引号', () => {
  assert.equal(escapeHtml(`<a href="x">'`), '&lt;a href=&quot;x&quot;&gt;&#39;');
});

console.log('\n存储与迁移');
ok('旧版 lingee.* 迁移到 lg.*', () => {
  Store.writeJSON('lingee.sessions', [
    { id: 's1', title: '旧会话', updatedAt: 1000, messages: [{ role: 'user', text: 'hi', time: 1 }] },
  ]);
  Store.writeJSON('lingee.presets', [{ id: 'p1', name: '测试环境' }]);
  Store.writeJSON('lingee.activePreset', 'p1');
  const r = Store.migrateLegacy();
  assert.equal(r.migrated, true);
  const idx = Store.loadIndex();
  assert.equal(idx.length, 1);
  assert.equal(idx[0].title, '旧会话');
  const sess = Store.loadSession('s1');
  assert.equal(sess.messages.length, 1);
  const cfg = Store.loadConfig();
  assert.equal(cfg.presets.length, 1);
  assert.equal(cfg.activeId, 'p1');
});

ok('迁移只执行一次', () => {
  const r = Store.migrateLegacy();
  assert.equal(r.migrated, false);
});

ok('资源缓存键随环境变化', () => {
  const a = Store.resCacheKey({ base: 'https://a', tenant: 't', appId: 'x', mode: 'FIXED_PROXY' });
  const b = Store.resCacheKey({ base: 'https://a', tenant: 't', appId: 'x', mode: 'HEADER_USER', subType: 'mobile', subject: '13800000000' });
  const c = Store.resCacheKey({ base: 'https://b', tenant: 't', appId: 'x', mode: 'FIXED_PROXY' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

ok('会话按 sid 分键保存并可删除', () => {
  const s = {
    id: 'sess-a',
    title: '测试',
    createdAt: 1,
    updatedAt: 2,
    messages: [{ id: 'm1', role: 'user', text: 'hello', status: 'done', time: 1 }],
  };
  Store.saveSession(s);
  assert.equal(Store.loadSession('sess-a').messages[0].text, 'hello');
  assert.ok(Store.loadIndex().some((x) => x.id === 'sess-a'));
  Store.removeSession('sess-a');
  assert.equal(Store.loadSession('sess-a'), null);
  assert.ok(!Store.loadIndex().some((x) => x.id === 'sess-a'));
});

console.log('\n' + (process.exitCode ? '存在失败用例' : '全部通过：' + passed + ' 项') + '\n');