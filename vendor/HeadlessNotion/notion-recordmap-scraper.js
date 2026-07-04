const LOAD_PAGE_CHUNK_URL = 'https://www.notion.so/api/v3/loadPageChunk';
const NOTION_CLIENT_VERSION = '23.13.20260607.0719';

function undashPageId(value) {
  return String(value || '').replace(/-/g, '').toLowerCase();
}

function dashPageId(value) {
  const compact = undashPageId(value);
  if (!/^[0-9a-f]{32}$/.test(compact)) return value;
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20)
  ].join('-');
}

function pageIdFromUrl(url) {
  const text = String(url || '');
  const matches = [...text.matchAll(/[0-9a-f]{32}/gi)];
  if (!matches.length) return '';
  return dashPageId(matches[matches.length - 1][0]);
}

function recordValue(record) {
  return record?.value?.value || record?.value || null;
}

function mergeRecordMap(target, source) {
  for (const [table, records] of Object.entries(source || {})) {
    if (table === '__version__') {
      target[table] = records;
      continue;
    }
    if (!records || typeof records !== 'object') continue;
    target[table] ||= {};
    Object.assign(target[table], records);
  }
}

async function loadPageChunk(pageId, attempt = 0) {
  const body = {
    pageId,
    limit: 100,
    cursor: { stack: [] },
    chunkNumber: 0,
    verticalColumns: false
  };
  let response;
  try {
    response = await fetch(LOAD_PAGE_CHUNK_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'notion-client-version': NOTION_CLIENT_VERSION
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    if (attempt >= 3) throw error;
    await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    return loadPageChunk(pageId, attempt + 1);
  }
  if (response.status === 429) {
    await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
    return loadPageChunk(pageId, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(`Notion loadPageChunk failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function loadFullRecordMap(rootId) {
  const loaded = new Set();
  const recordMap = {};

  async function load(id) {
    const dashed = dashPageId(id);
    if (!dashed || loaded.has(dashed)) return;
    loaded.add(dashed);
    const chunk = await loadPageChunk(dashed);
    mergeRecordMap(recordMap, chunk.recordMap || {});
  }

  await load(rootId);

  const blockTable = recordMap.block || {};
  const page = recordValue(blockTable[dashPageId(rootId)]);
  const topLevelIds = page?.content || [];
  for (const id of topLevelIds) {
    const block = recordValue(blockTable[id]);
    if (block?.type === 'sub_sub_header' && block.content?.length) {
      await load(id);
    }
  }

  return recordMap;
}

function richTextPlain(parts = []) {
  return parts.map(part => part?.[0] || '').join('');
}

function richTextCommentPlain(parts = []) {
  return parts.map(part => {
    const text = part?.[0] || '';
    const link = (part?.[1] || []).find(decoration => decoration?.[0] === 'a')?.[1];
    return link && /^https?:\/\//i.test(link) ? link : text;
  }).join('');
}

function titleOf(block) {
  return richTextPlain(block?.properties?.title || [])
    .replace(/\u00a0/g, ' ')
    .replace(/^\*+|\*+$/g, '')
    .trim();
}

function discussionIdsFromDecorations(decorations = []) {
  return decorations
    .filter(decoration => decoration?.[0] === 'm' && decoration[1])
    .map(decoration => decoration[1]);
}

function commentText(recordMap, discussionId) {
  const discussion = recordValue(recordMap.discussion?.[discussionId]);
  const commentIds = discussion?.comments || [];
  return commentIds
    .map(id => recordValue(recordMap.comment?.[id]))
    .filter(Boolean)
    .sort((a, b) => (a.created_time || 0) - (b.created_time || 0))
    .map(comment => richTextCommentPlain(comment.text || []).trim())
    .filter(Boolean);
}

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function formatComment(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (isUrl(text)) return text.replace(/\.+$/, '');
  return text.startsWith('/') ? text : `/${text.replace(/^\/+/, '').trim()}`;
}

function splitFirstSentence(text) {
  const value = String(text || '').trim();
  const match = value.match(/^(.+?[.!?…])(\s+.+)$/u);
  if (!match) return [value];
  return [match[1].trim(), match[2].trim()].filter(Boolean);
}

function consumeFollowingAndSentence(parts, index) {
  const next = String(parts[index + 1]?.[0] || '');
  const match = next.match(/^(\s+И(?=\s).+?[.!?…])(\s*)/u);
  if (!match) return '';
  parts[index + 1][0] = next.slice(match[0].length);
  return match[1];
}

function moveAccidentalTrailingLetterToNextPart(parts, index, paragraph) {
  const next = String(parts[index + 1]?.[0] || '');
  if (!/^\p{Ll}/u.test(next)) return paragraph;
  const match = String(paragraph || '').match(/^(.*[.!?…]\s+)(\p{L})$/u);
  if (!match) return paragraph;
  parts[index + 1][0] = `${match[2]}${next}`;
  return match[1].trimEnd();
}

function collectLastDiscussionOccurrences(blocks = []) {
  const last = new Map();
  blocks.forEach((block, blockIndex) => {
    if (!block?.properties?.title) return;
    (block.properties.title || []).forEach((part, partIndex) => {
      for (const discussionId of discussionIdsFromDecorations(part?.[1] || [])) {
        last.set(discussionId, { blockIndex, partIndex });
      }
    });
  });
  return last;
}

function renderRichTextBlock(block, recordMap, context = {}) {
  const parts = (block?.properties?.title || []).map(part => [part?.[0] || '', part?.[1] || []]);
  const lastDiscussionPartIndex = new Map();
  parts.forEach((part, index) => {
    for (const discussionId of discussionIdsFromDecorations(part?.[1] || [])) {
      lastDiscussionPartIndex.set(discussionId, index);
    }
  });
  const output = [];
  let paragraph = '';
  let splitNextTailAfterFirstSentence = false;

  function pushParagraph(value) {
    const text = String(value || '').trim();
    if (!text) return;
    if (splitNextTailAfterFirstSentence) {
      output.push(...splitFirstSentence(text));
      splitNextTailAfterFirstSentence = false;
      return;
    }
    output.push(text);
  }

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const text = String(part?.[0] || '').replace(/\u00a0/g, ' ');
    const discussionIds = discussionIdsFromDecorations(part?.[1] || []);
    paragraph += text;

    if (!discussionIds.length) continue;
    const readyDiscussionIds = discussionIds.filter(id => {
      if (lastDiscussionPartIndex.get(id) !== index) return false;
      const sectionLast = context.lastDiscussionOccurrences?.get(id);
      if (!sectionLast) return true;
      return sectionLast.blockIndex === context.blockIndex && sectionLast.partIndex === index;
    });
    if (!readyDiscussionIds.length) continue;
    if (parts[index + 1]?.[0]) {
      const punctuation = String(parts[index + 1][0]).match(/^\s*([.,!?…;:]+)/u);
      if (punctuation) {
        paragraph += punctuation[1];
        parts[index + 1][0] = String(parts[index + 1][0]).slice(punctuation[0].length);
      }
    }
    const comments = readyDiscussionIds.flatMap(id => commentText(recordMap, id)).map(formatComment).filter(Boolean);
    if (!comments.length) continue;
    const hasUrlComment = comments.some(isUrl);
    if (hasUrlComment) {
      paragraph += consumeFollowingAndSentence(parts, index);
      paragraph = moveAccidentalTrailingLetterToNextPart(parts, index, paragraph);
    }
    const before = paragraph.trim();
    if (before) pushParagraph(before);
    output.push(...comments);
    splitNextTailAfterFirstSentence = hasUrlComment && /,$/.test(before);
    paragraph = '';
  }

  const tail = paragraph.trim();
  if (tail) pushParagraph(tail);
  return output.join('\n\n').trim();
}

function renderHeadingRefs(block, recordMap) {
  const parts = block?.properties?.title || [];
  return parts
    .flatMap(part => discussionIdsFromDecorations(part?.[1] || []))
    .flatMap(id => commentText(recordMap, id))
    .map(formatComment)
    .filter(value => value && isUrl(value));
}

function shouldRenderAsPrelude(block) {
  return ['page', 'collection_view_page'].includes(block?.type);
}

function renderBlock(block, recordMap, context = {}) {
  if (!block) return '';
  if (['text', 'bulleted_list', 'numbered_list'].includes(block.type)) {
    return renderRichTextBlock(block, recordMap, context);
  }
  if (shouldRenderAsPrelude(block)) return titleOf(block);
  if (block.content?.length && ['column_list', 'column'].includes(block.type)) {
    return renderChildren(block, recordMap);
  }
  return '';
}

function renderChildren(block, recordMap) {
  const blockTable = recordMap.block || {};
  const children = (block?.content || [])
    .map(childId => recordValue(blockTable[childId]))
    .filter(Boolean);
  const lastDiscussionOccurrences = collectLastDiscussionOccurrences(children);
  const lines = [];
  for (let blockIndex = 0; blockIndex < children.length; blockIndex++) {
    const child = children[blockIndex];
    const rendered = renderBlock(child, recordMap, { blockIndex, lastDiscussionOccurrences });
    if (rendered) lines.push(rendered);
  }
  return lines.join('\n\n').trim();
}

function dedupePrelude(lines) {
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const key = line.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result;
}

export async function scrapeNotionRecordMapPage(url) {
  const rootId = pageIdFromUrl(url);
  if (!rootId) throw new Error('Could not parse Notion page id');
  const recordMap = await loadFullRecordMap(rootId);
  const blockTable = recordMap.block || {};
  const page = recordValue(blockTable[rootId]);
  if (!page) throw new Error('Could not load Notion page record');

  const output = [];
  output.push(`# ${titleOf(page)}`);

  const prelude = [];
  for (const childId of page.content || []) {
    const block = recordValue(blockTable[childId]);
    if (!block) continue;
    if (block.type === 'sub_sub_header') break;
    const rendered = renderBlock(block, recordMap);
    if (rendered) prelude.push(rendered);
  }
  output.push(...dedupePrelude(prelude));

  let index = 0;
  while (index < (page.content || []).length) {
    const childId = page.content[index];
    const block = recordValue(blockTable[childId]);
    if (!block) {
      index += 1;
      continue;
    }

    if (block.type !== 'sub_sub_header') {
      index += 1;
      continue;
    }

    const heading = titleOf(block);
    if (!heading) {
      index += 1;
      continue;
    }

    output.push(`### ${heading}`);
    const headingRefs = renderHeadingRefs(block, recordMap);
    if (headingRefs.length) output.push([...new Set(headingRefs)].join('\n\n'));

    const bodyParts = [];
    if (block.content?.length) {
      const renderedChildren = renderChildren(block, recordMap);
      if (renderedChildren) bodyParts.push(renderedChildren);
      index += 1;
    } else {
      index += 1;
      while (index < (page.content || []).length) {
        const nextBlock = recordValue(blockTable[page.content[index]]);
        if (!nextBlock || nextBlock.type === 'sub_sub_header') break;
        const rendered = renderBlock(nextBlock, recordMap);
        if (rendered) bodyParts.push(rendered);
        index += 1;
      }
    }
    if (bodyParts.length) output.push(bodyParts.join('\n\n'));
  }

  return output
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
