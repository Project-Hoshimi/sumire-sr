import Fastify from 'fastify';
import { buildServer } from './server.ts';
import { encrypt, decrypt } from './gateway/crypto.ts';
import { loadCorpus, listCorpusNames } from './services/replay/corpus.ts';
import { listNames } from './services/handlers.ts';
import { NOT_IMPLEMENTED_MESSAGE } from './services/errors.ts';
import { requireData } from './testing/requireData.ts';

await requireData({ captures: true });

const app = buildServer();
await app.listen({ port: 18099, host: '127.0.0.1' });

const corpus = loadCorpus();
console.log(`corpus endpoints: ${listCorpusNames().length}`);
await import('./services/all.ts');
console.log(`registered handlers: ${listNames().length}`);

// Unhandled-RPC contract: an endpoint that exists in endpoints.ts but has no
// handler (Activity:PromoteLesson is absent from handlers/corpus) must answer
// gRPC UNIMPLEMENTED (12) with the dialog + return-home metadata.
const unknown = await fetch('http://127.0.0.1:18099/api.Activity/PromoteLesson', { method: 'POST' });
const msgBin = unknown.headers.get('x-error-message-bin');
const decodedMsg = msgBin ? Buffer.from(msgBin, 'base64').toString('utf8') : null;
const unknownHeaders = {
  grpcStatus: unknown.headers.get('grpc-status'),
  errorCode: unknown.headers.get('x-error-code'),
  errorAction: unknown.headers.get('x-error-action'),
};
let unhandledOk = true;
if (
  unknownHeaders.grpcStatus === '12' &&
  unknownHeaders.errorCode === '3022' &&
  unknownHeaders.errorAction === 'home' &&
  decodedMsg === NOT_IMPLEMENTED_MESSAGE
) {
  console.log('ok   unhandled RPC replies gRPC 12 + FUNCTION_LOCKED + home dialog');
} else {
  console.log(`FAIL unhandled RPC headers: ${JSON.stringify(unknownHeaders)} message=${JSON.stringify(decodedMsg)}`);
  unhandledOk = false;
}

let pass = 0;
let fail = 0;
const DYNAMIC = new Set(['Auth:Login', 'User:Get', 'Deck:Save', 'Card:Enhance', 'Mission:Receive', 'LoginBonus:Receive', 'Gacha:List', 'Gacha:Draw', 'Gift:List', 'Gift:Receive', 'Shop:List', 'Shop:ListItem', 'Shop:Purchase', 'Market:ListItem', 'Market:Purchase', 'Costume:SetCostume', 'Costume:SetLiveCostume', 'Costume:CheckCostume', 'Costume:CheckBulk', 'Hair:CheckHair', 'Accessory:Sell', 'Profile:UpdateName', 'Profile:UpdateMessage', 'Profile:UpdateBackground', 'Profile:UpdateFavoriteCharacters', 'Profile:UpdateDecoration', 'Profile:UpdateEmblem', 'Profile:UpdateLayout', 'Profile:UpdateBuddyCard', 'Profile:UpdateBirthday']);
const SLICE13_DYNAMIC = [
  'Card:LimitBreak', 'Card:RankUp', 'Card:LiveAbilityEnhance', 'Card:ActivityAbilityEnhance',
  'Card:SkillEnhance', 'Card:SetSupport', 'Card:RemoveSupport', 'Card:ReleaseSupport',
  'Card:Reset', 'Card:UpdateDisplayType',
  'Photo:Enhance', 'Photo:ExtendLimit', 'Photo:Retouch', 'Photo:Reroll', 'Photo:Update',
  'Photo:SwitchLock', 'Photo:Delete', 'Photo:SaleRecipe', 'Photo:Report',
  'Photo:ListShooting', 'Photo:CheckShooting', 'Photo:CreateShootings', 'Photo:GetImageURL',
  'Photo:CheckExpressionShooting', 'Photo:CreateExpressionShootings',
  'Photo:CheckCardStoryShooting', 'Photo:CreateCardStoryShootings',
  'PhotoPanorama:List', 'PhotoPanorama:CheckShooting', 'PhotoPanorama:CreateShootings',
  'Shelf:Top', 'Shelf:AlbumTop', 'Shelf:CheckShooting', 'Shelf:SavePhoto', 'Shelf:SetPhoto', 'Shelf:CreateAlbumPhoto',
  'Accessory:Enhance', 'Accessory:LimitBreak',
];
for (const name of SLICE13_DYNAMIC) DYNAMIC.add(name);
const SLICE14_DYNAMIC = [
  'Story:Read', 'Story:ReleaseEpisode', 'Story:ListEvent', 'Story:ReadEvent',
  'Story:ListExtra', 'Story:ReadExtra', 'Story:ReadAnniversaryStory',
  'Story:ReadCharacterCompanyEnjoyStory',
];
for (const name of SLICE14_DYNAMIC) DYNAMIC.add(name);
const SLICE16_DYNAMIC = ['Home:Enter'];
for (const name of SLICE16_DYNAMIC) DYNAMIC.add(name);
for (const name of listCorpusNames()) {
  const entry = corpus.get(name)!;
  if (!entry.request) continue; // only entries with a matching captured request get verified end-to-end
  if (DYNAMIC.has(name)) continue; // dynamic handlers (DB-backed / new JWT) are verified by dbtest.ts
  const [service, method] = name.split(':');
  const resp = await fetch(`http://127.0.0.1:18099/api.${service}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf', 'x-auth-token': 't' },
    body: encrypt(entry.request, Buffer.from('0000000000000000')),
  });
  const body = Buffer.from(await resp.arrayBuffer());
  if (resp.status !== 200) {
    console.log(`FAIL ${name}: status ${resp.status}`);
    fail++;
    continue;
  }
  const round = decrypt(body);
  if (round.equals(entry.response)) {
    pass++;
  } else {
    console.log(`MISMATCH ${name}: got ${round.length}B expected ${entry.response.length}B`);
    fail++;
  }
}
console.log(`\nreplay boot test: ${pass} passed, ${fail} failed`);
await app.close();
process.exit(fail || !unhandledOk ? 1 : 0);
