// Firebase Storage resumable-upload chunk tests. Unit-level only: they drive
// the per-session chunk accumulator directly, so no database, server or game
// data is required.
//
//   node --test src/firebaseStorage.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendPhotoUploadChunk,
  clearPhotoUploadChunk,
  photoUploadBytesReceived,
} from './firebaseStorage.ts';

const first = Buffer.from('first-chunk-');
const final = Buffer.from('final-chunk');

test('chunk(offset 0) + query + finalize(offset N) accumulates the full body', () => {
  const uploadId = `test-chunk-${Date.now()}`;

  const afterChunk = appendPhotoUploadChunk(uploadId, 0, first);
  assert.equal(afterChunk?.length, first.length);
  // `query` only reports the bytes received; it does not change them.
  assert.equal(photoUploadBytesReceived(uploadId), first.length);

  const afterFinal = appendPhotoUploadChunk(uploadId, photoUploadBytesReceived(uploadId), final);
  assert.ok(afterFinal);
  assert.equal(afterFinal.length, first.length + final.length);
  assert.equal(photoUploadBytesReceived(uploadId), first.length + final.length);
  assert.deepEqual(afterFinal, Buffer.concat([first, final]));

  clearPhotoUploadChunk(uploadId);
  assert.equal(photoUploadBytesReceived(uploadId), 0);
});

test('finalize with an empty body at the received offset keeps all chunks', () => {
  const uploadId = `test-empty-final-${Date.now()}`;

  assert.equal(appendPhotoUploadChunk(uploadId, 0, first)?.length, first.length);
  const finalBody = appendPhotoUploadChunk(uploadId, first.length, Buffer.alloc(0));
  assert.deepEqual(finalBody, first);
  assert.equal(photoUploadBytesReceived(uploadId), first.length);

  clearPhotoUploadChunk(uploadId);
});

test('a wrong offset is rejected without changing the received bytes', () => {
  const uploadId = `test-bad-offset-${Date.now()}`;

  assert.equal(appendPhotoUploadChunk(uploadId, 1, first), null);
  assert.equal(photoUploadBytesReceived(uploadId), 0);

  assert.equal(appendPhotoUploadChunk(uploadId, 0, first)?.length, first.length);
  assert.equal(appendPhotoUploadChunk(uploadId, first.length + 1, final), null);
  assert.equal(photoUploadBytesReceived(uploadId), first.length);

  clearPhotoUploadChunk(uploadId);
});

test('a non-numeric / negative offset is rejected', () => {
  const uploadId = `test-invalid-offset-${Date.now()}`;

  assert.equal(appendPhotoUploadChunk(uploadId, Number.NaN, first), null);
  assert.equal(appendPhotoUploadChunk(uploadId, -1, first), null);
  assert.equal(appendPhotoUploadChunk(uploadId, 1.5, first), null);
  assert.equal(photoUploadBytesReceived(uploadId), 0);
});
