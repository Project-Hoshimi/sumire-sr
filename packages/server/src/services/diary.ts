import { readFileSync } from 'node:fs';
import { register } from './handlers.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

const COMMON_RESPONSE_MSG = 'Solis.Common.Proto.Api.CommonResponse';
const UPDATED_DATA_MSG = 'Solis.Common.Proto.Api.UpdatedData';
const DELETED_DATA_MSG = 'Solis.Common.Proto.Api.DeletedData';
const DIARY_INFO_MSG = 'Solis.Common.Proto.Api.DiaryInfo';

type DiaryEntry = { id: string; year: number; month: number; day: number; assetId: string };

/**
 * Mana's diary pages. The client has no master table for them: the catalog
 * (id, date, asset id) comes from solis-server's diaries.yaml (AGPL-3.0).
 */
const DIARIES: DiaryEntry[] = JSON.parse(
  readFileSync(new URL('../data/diaries.json', import.meta.url), 'utf8'),
);
const DIARY_IDS = new Set(DIARIES.map((d) => d.id));

function commonResponse(): Decoded {
  return {
    __msg: COMMON_RESPONSE_MSG,
    UpdatedData: { __msg: UPDATED_DATA_MSG },
    DeletedData: { __msg: DELETED_DATA_MSG },
  } as Decoded;
}

/** Every page is listed and already read, so the diary opens with no NEW badges. */
register(
  'Diary:GetInfos',
  (ctx) => {
    ctx.fastifyReq.log.info({ count: DIARIES.length }, 'diary get infos');
    return {
      __msg: '',
      Infos: DIARIES.map(
        (d) =>
          ({
            __msg: DIARY_INFO_MSG,
            Id: d.id,
            Year: d.year,
            Month: d.month,
            Day: d.day,
            AssetId: d.assetId,
            IsRead: true,
          }) as Decoded,
      ),
      CommonResponse: commonResponse(),
    } as Decoded;
  },
  { ownsState: true },
);

/** Pages are always read, so there is no state to record; only the ids are checked. */
register(
  'Diary:Read',
  (ctx) => {
    const ids = ((ctx.request as Decoded | undefined)?.DiaryIds ?? []) as string[];
    if (ids.length === 0) throw new Error('Diary:Read: at least one DiaryId is required');
    const unknown = ids.find((id) => !DIARY_IDS.has(String(id)));
    if (unknown !== undefined) throw new Error(`Diary:Read: unknown diary id ${unknown}`);
    ctx.fastifyReq.log.info({ ids }, 'diary read');
    return { __msg: '', CommonResponse: commonResponse() } as Decoded;
  },
  { ownsState: true },
);
