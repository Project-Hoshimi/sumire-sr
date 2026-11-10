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
