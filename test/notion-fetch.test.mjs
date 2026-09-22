// notion-fetch.mjs - optional live capture of a Notion page into Markdown (guidelines layer).
// Pure parts are tested directly; the API driver is tested with an injected fetch (no network,
// no token). Degrade-safe: no token / bad response -> null (caller keeps the committed file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageIdFromUrl, blocksToMarkdown, fetchNotionMarkdown } from '../notion-fetch.mjs';

test('pageIdFromUrl extracts the dashed id from a Notion url (and a bare id)', () => {
  assert.equal(pageIdFromUrl('https://www.notion.so/team/Doc-Title-3bbebcef3937804f970dd600d624e9e9'),
    '3bbebcef-3937-804f-970d-d600d624e9e9');
  assert.equal(pageIdFromUrl('3bbebcef3937804f970dd600d624e9e9'), '3bbebcef-3937-804f-970d-d600d624e9e9');
  assert.equal(pageIdFromUrl(''), null);
  assert.equal(pageIdFromUrl('https://notion.so/no-id-here'), null);
});

test('blocksToMarkdown renders the common block types and nests children', () => {
  const md = blocksToMarkdown([
    { type: 'heading_2', heading_2: { rich_text: [{ plain_text: 'Buttons' }] } },
    { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Use primary for CTAs.' }] } },
    { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [{ plain_text: 'Not for navigation' }] },
      _children: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'use a link instead' }] } }] },
    { type: 'to_do', to_do: { checked: true, rich_text: [{ plain_text: 'audited' }] } },
  ]);
  assert.match(md, /## Buttons/);
  assert.match(md, /Use primary for CTAs\./);
  assert.match(md, /- Not for navigation/);
  assert.match(md, /  use a link instead/);       // child indented one level
  assert.match(md, /- \[x\] audited/);
});

test('fetchNotionMarkdown returns null without a token (degrade-safe)', async () => {
  const r = await fetchNotionMarkdown('https://notion.so/x-3bbebcef3937804f970dd600d624e9e9',
    { token: '', fetchImpl: () => { throw new Error('should not be called'); } });
  assert.equal(r, null);
});

test('fetchNotionMarkdown builds "# Title\\n\\n<md>" from the API (injected fetch)', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/pages/')) return { ok: true, json: async () => ({
      properties: { Name: { type: 'title', title: [{ plain_text: 'Manual' }] } } }) };
    if (url.includes('/children')) return { ok: true, json: async () => ({
      results: [
        { type: 'heading_1', heading_1: { rich_text: [{ plain_text: 'Buttons' }] }, has_children: false },
        { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Use primary for CTAs.' }] }, has_children: false },
      ], has_more: false }) };
    throw new Error('unexpected url ' + url);
  };
  const md = await fetchNotionMarkdown('https://notion.so/x-3bbebcef3937804f970dd600d624e9e9',
    { token: 'ntn_test', fetchImpl });
  assert.match(md, /^# Manual/);
  assert.match(md, /# Buttons/);
  assert.match(md, /Use primary for CTAs\./);
});

test('fetchNotionMarkdown returns null on an API error (kept committed file)', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  const r = await fetchNotionMarkdown('https://notion.so/x-3bbebcef3937804f970dd600d624e9e9',
    { token: 'ntn_test', fetchImpl });
  assert.equal(r, null);
});
