import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeMessages } from '../src/native-messages.js';
import { correlate } from '../src/cockpit.js';

const event = (id, type, data, fields = {}) => ({ id, type, data, ...fields });

test('native user event IDs and assistant message IDs retain their distinct public identities', () => {
  const messages = nativeMessages([
    event('user-event', 'user.message', { messageId: 'accepted-send-id', content: 'question' }),
    event('assistant-event', 'assistant.message', { messageId: 'assistant-message', content: 'answer' }),
  ]);
  assert.deepEqual(messages.map(message => message.id), ['user-event', 'assistant-message']);
});

test('native skill injections are context, not foreign conversational users', () => {
  const messages = nativeMessages([
    event('user', 'user.message', { content: 'authorized prompt' }),
    event('skill', 'user.message', { source: 'skill-work-owner', content: 'private skill instructions' }),
    event('reply', 'assistant.message', { messageId: 'answer', content: 'done' }),
  ]);
  assert.deepEqual(messages.map(message => message.id), ['user', 'answer']);
  assert.doesNotThrow(() => correlate({ prompt: 'authorized prompt' }, messages, { queue: [] }));
});

test('ephemeral content and child envelopes are not deliverable root replies', () => {
  const events = [
    event('delta', 'assistant.message_delta', { messageId: 'a', deltaContent: 'partial' }, { ephemeral: true }),
    event('child', 'assistant.message', { messageId: 'child', content: 'private child' }, { agentId: 'agent' }),
    event('legacy', 'assistant.message', { parentToolCallId: 'task', content: 'private legacy child' }),
    event('tool', 'tool.execution_complete', { toolCallId: 'internal', result: { content: 'private result' } }),
  ];
  assert.deepEqual(nativeMessages(events), []);
});

test('legacy user attachment guidance remains hidden and does not change the legacy fingerprint shape', () => {
  const [message] = nativeMessages([event('upload', 'user.message', {
    content: '<cockpit-attachment kind="image" name="sample.png" url="/uploads/sample.png"/>Read /private/native/path now.',
  })]);
  assert.deepEqual(message, {
    id: 'upload', role: 'user', content: '',
    attachment: { kind: 'image', name: 'sample.png', url: '/uploads/sample.png' },
  });
});

test('v2 attachment ordering survives while arbitrary paths and cross-origin links are not resolved', () => {
  const [message] = nativeMessages([event('files', 'user.message', {
    content: 'before<cockpit-attachment version="2" kind="file" name="a.txt" url="/uploads/a.txt"/>after',
  })]);
  assert.equal(message.content, 'beforeafter');
  assert.deepEqual(message.parts.map(part => part.type), ['text', 'file', 'text']);
  for (const url of ['/private/file', 'https://third-party.invalid/image', '/uploads/../private']) {
    const [unsafe] = nativeMessages([event('unsafe', 'assistant.message', {
      content: `<cockpit-attachment kind="image" url="${url}"/>`,
    })]);
    assert.equal(unsafe.attachment, undefined);
  }
});
