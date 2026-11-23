/* 轻量 Markdown 渲染：离线、零依赖、先转义后排版（不放行原始 HTML）。
 * 支持：标题、粗/斜/删除线、行内代码、围栏代码块（语言 + 复制）、
 *       有序/无序/嵌套/任务列表、引用、表格、分隔线、链接、裸 URL。
 * 流式容忍：未闭合的围栏按代码块渲染。
 */

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, '&#96;');
}

function safeUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return '';
  if (/^(https?:|mailto:)/i.test(u)) return u;
  if (/^www\./i.test(u)) return 'https://' + u;
  return '';
}

const CODE_TOKEN = '\u0001';
const LINK_TOKEN = '\u0002';

export function renderInline(raw) {
  const codes = [];
  const links = [];
  let s = String(raw == null ? '' : raw);

  // 1) 行内代码先摘出，避免其内容被后续规则改写
  s = s.replace(/`([^`\n]+)`/g, (m, code) => {
    codes.push(code);
    return CODE_TOKEN + (codes.length - 1) + CODE_TOKEN;
  });

  // 2) 转义
  s = escapeHtml(s);

  // 3) 链接（Markdown 语法 + 裸 URL），生成后也用占位符保护
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+?)(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, url) => {
    const u = safeUrl(url);
    if (!u) return m;
    links.push('<a href="' + escapeAttr(u) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
    return LINK_TOKEN + (links.length - 1) + LINK_TOKEN;
  });

  s = s.replace(/(^|[\s(（])(https?:\/\/[^\s<]+)/g, (m, lead, url) => {
    let tail = '';
    const cleaned = url.replace(/[.,;:!?，。；：！？)\]】]+$/, (t) => {
      tail = t;
      return '';
    });
    const u = safeUrl(cleaned);
    if (!u) return m;
    links.push('<a href="' + escapeAttr(u) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(cleaned) + '</a>');
    return lead + LINK_TOKEN + (links.length - 1) + LINK_TOKEN + tail;
  });

  // 4) 强调
  s = s
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+?)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+?)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');

  // 5) 还原链接与代码
  s = s.replace(new RegExp(LINK_TOKEN + '(\\d+)' + LINK_TOKEN, 'g'), (m, n) => links[Number(n)] || '');
  s = s.replace(new RegExp(CODE_TOKEN + '(\\d+)' + CODE_TOKEN, 'g'), (m, n) => '<code>' + escapeHtml(codes[Number(n)] || '') + '</code>');
  return s;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

function codeBlock(code, lang, streaming) {
  const language = (lang || '').trim();
  const label = language || '文本';
  return (
    '<div class="md-code' + (streaming ? ' is-streaming' : '') + '">' +
    '<div class="md-code-head"><span class="md-lang">' + escapeHtml(label) + '</span>' +
    '<button type="button" class="md-copy" data-copy-code aria-label="复制代码">复制</button></div>' +
    '<pre><code' + (language ? ' class="language-' + escapeAttr(language) + '"' : '') + '>' +
    escapeHtml(code) +
    '</code></pre></div>'
  );
}

export function renderMarkdown(src, opts = {}) {
  const streaming = !!opts.streaming;
  const text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  if (!text) return '';

  const lines = text.split('\n');
  const out = [];
  const listStack = [];
  let para = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br>') + '</p>');
    para = [];
  };

  const closeLi = () => {
    const top = listStack[listStack.length - 1];
    if (top && top.openLi) {
      out.push('</li>');
      top.openLi = false;
    }
  };
  const closeList = () => {
    closeLi();
    const top = listStack.pop();
    if (top) out.push(top.ordered ? '</ol>' : '</ul>');
  };
  const closeAllLists = () => {
    while (listStack.length) closeList();
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ---- 围栏代码块 ----
    const fence = line.match(FENCE_RE);
    if (fence) {
      flushPara();
      closeAllLists();
      const marker = fence[1];
      const lang = fence[2] || '';
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        const close = lines[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) {
          closed = true;
          i++;
          break;
        }
        body.push(lines[i]);
        i++;
      }
      out.push(codeBlock(body.join('\n'), lang, !closed && streaming));
      continue;
    }

    // ---- 空行 ----
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    // ---- 标题 ----
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeAllLists();
      const level = heading[1].length;
      out.push('<h' + level + '>' + renderInline(heading[2].trim()) + '</h' + level + '>');
      i++;
      continue;
    }

    // ---- 分隔线 ----
    if (/^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/.test(line)) {
      flushPara();
      closeAllLists();
      out.push('<hr>');
      i++;
      continue;
    }

    // ---- 引用 ----
    if (/^\s{0,3}>\s?/.test(line)) {
      flushPara();
      closeAllLists();
      const quote = [];
      while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + renderMarkdown(quote.join('\n')) + '</blockquote>');
      continue;
    }

    // ---- 表格 ----
    if (line.includes('|') && i + 1 < lines.length) {
      const sep = lines[i + 1].match(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/);
      if (sep) {
        flushPara();
        closeAllLists();
        const head = splitRow(line);
        const aligns = splitRow(lines[i + 1]).map((c) => {
          const l = c.trim().startsWith(':');
          const r = c.trim().endsWith(':');
          return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
        });
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        let html = '<div class="md-table"><table><thead><tr>';
        head.forEach((c, idx) => {
          html += '<th' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' + renderInline(c.trim()) + '</th>';
        });
        html += '</tr></thead><tbody>';
        rows.forEach((row) => {
          html += '<tr>';
          head.forEach((_, idx) => {
            html += '<td' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' + renderInline((row[idx] || '').trim()) + '</td>';
          });
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        out.push(html);
        continue;
      }
    }

    // ---- 列表 ----
    const item = line.match(LIST_RE);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, '    ').length;
      const ordered = /\d/.test(item[2]);
      let content = item[3];

      while (listStack.length && indent < listStack[listStack.length - 1].indent) closeList();
      if (!listStack.length || indent > listStack[listStack.length - 1].indent) {
        const tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>');
        listStack.push({ indent, ordered, openLi: false });
      } else if (listStack[listStack.length - 1].ordered !== ordered) {
        closeList();
        const tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>');
        listStack.push({ indent, ordered, openLi: false });
      } else {
        closeLi();
      }

      let extra = '';
      const task = content.match(/^\[([ xX])\]\s+(.*)$/);
      if (task) {
        const checked = task[1].toLowerCase() === 'x';
        extra = '<span class="md-task' + (checked ? ' on' : '') + '" aria-hidden="true">' + (checked ? '✓' : '') + '</span>';
        content = task[2];
      }
      out.push('<li>' + extra + renderInline(content));
      listStack[listStack.length - 1].openLi = true;
      i++;
      continue;
    }

    // ---- 列表续行（缩进的普通行） ----
    if (listStack.length && /^\s{2,}\S/.test(line)) {
      out.push('<br>' + renderInline(line.trim()));
      i++;
      continue;
    }

    // ---- 段落 ----
    if (listStack.length) closeAllLists();
    para.push(line);
    i++;
  }

  flushPara();
  closeAllLists();
  return out.join('');
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // 不支持转义竖线，够用即可
  return s.split('|');
}