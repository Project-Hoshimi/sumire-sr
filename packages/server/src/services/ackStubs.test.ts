// Acknowledgement stubs: every stub is registered, names a real protocol
// endpoint, and answers with that endpoint's response message.
//
//   node --test src/services/ackStubs.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { endpoints } from '@sumire-sr/protocol/gen/endpoints.ts';
import { getHandler, hasHandler } from './handlers.ts';
import { ACK_STUBS } from './ackStubs.ts';

const endpointMap = endpoints as unknown as Record<string, Record<string, { response: string }>>;

for (const stub of ACK_STUBS) {
  test(`${stub.name} is registered and matches the protocol response`, async () => {
    assert.ok(hasHandler(stub.name));
    const [service, method] = stub.name.split(':');
    assert.equal(endpointMap[service]?.[method]?.response, stub.responseMsg);

    const out = (await getHandler(stub.name)({} as any)) as Record<string, any>;
    assert.equal(out.__msg, stub.responseMsg);
    if (stub.hasCommon) {
      assert.equal(out.CommonResponse.__msg, 'Solis.Common.Proto.Api.CommonResponse');
    } else {
      assert.equal(out.CommonResponse, undefined);
    }
  });
}

// Fire-and-forget telemetry: the decoded request fields carry no state change,
// so the stub must acknowledge with an empty CommonResponse and store nothing.
test('Quest:OutputLiveResultDetailLog acknowledges telemetry without state', async () => {
  const name = 'Quest:OutputLiveResultDetailLog';
  assert.ok(ACK_STUBS.some((stub) => stub.name === name));
  assert.ok(hasHandler(name));

  const ctx = { request: { LiveResultDetailLogId: 'log-1', Cleared: true, Score: 12345 } } as any;
  const out = (await getHandler(name)(ctx)) as Record<string, any>;
  assert.equal(out.__msg, 'Solis.Common.Proto.Api.OutputLiveResultDetailLogResponse');
  assert.equal(out.CommonResponse.__msg, 'Solis.Common.Proto.Api.CommonResponse');
  assert.deepEqual(out.CommonResponse.UpdatedData, { __msg: 'Solis.Common.Proto.Api.UpdatedData' });
  assert.deepEqual(out.CommonResponse.DeletedData, { __msg: 'Solis.Common.Proto.Api.DeletedData' });
});
