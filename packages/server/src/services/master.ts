import fs from 'node:fs';
import path from 'node:path';
import { register } from './handlers.ts';
import { config, DATA_DIR } from '../config.ts';
import { isSandbox } from '../profile.ts';
import { loadTitleVariants, titleMasterVersion, titleRotation } from '../profiles/sandbox/titleBackground.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

export const MASTER_BLOBS_DIR = path.join(DATA_DIR, 'phaseA2', 'blobs');
const MANIFEST_PATH = path.join(DATA_DIR, 'phaseA2', 'out', 'manifest.json');

type Partition = {
  type: string;
  fileName: string;
  fileSize: number;
  cryptoKey: string;
  downloadUrl: string;
};

type Manifest = { version: string; partitions: Partition[] };

let cached: Manifest | null = null;
export function loadManifest(): Manifest {
  if (!cached) cached = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  return cached;
}

/**
 * Serve the harvested master manifest, rewriting each partition's DownloadUrl to
 * point at this server so the client syncs its cached master to ours. Without
 * this the client falls back to a bundled/stale master and later looks up card
 * ids we created server-side that it has never heard of (gacha result NRE).
 */
register(
  'Master:Get',
  async () => {
    const m = loadManifest();
    // In sandbox, advertise the current title-screen variant as the master
    // version and as the TitleBackground partition. "FAQ" steps it.
    const variant = isSandbox() ? titleRotation.current(loadTitleVariants()) : null;
    return {
      __msg: 'Solis.Common.Proto.Api.MasterGetResponse',
      MasterTag: {
        __msg: 'Solis.Common.Proto.Transaction.MasterTag',
        Version: variant ? titleMasterVersion(m.version, variant) : m.version,
        MasterTagPacks: m.partitions.map((p) => {
          const title = p.type === 'TitleBackground' ? variant : null;
          const fileName = title ? title.fileName : p.fileName;
          return {
            __msg: 'Solis.Common.Proto.Transaction.MasterTagPack',
            Type: p.type,
            FileName: fileName,
            FileSize: title ? title.fileSize : p.fileSize,
            CryptoKey: p.cryptoKey,
            DownloadUrl: `${config.publicBaseUrl}/master/${p.type}/${fileName}`,
          };
        }),
      },
    } as Decoded;
  },
  { ownsState: true },
);

/**
 * Title menu "Account Recovery" fetches its form template here ("Contact Us"
 * uses built-in text and never calls). No template text: the form shows as is.
 */
register('Master:GetInquiryTemplate', async () => ({
  __msg: 'Solis.Common.Proto.Api.MasterGetInquiryTemplateResponse',
  Text: '',
} as Decoded));

/**
 * Title menu "FAQ" lists help categories from here. In sandbox the button
 * instead steps the title screen to the next variant and lists it as the one
 * category. The client compares titles before it reloads the master it just
 * downloaded, so the new title shows two logins later.
 */
register('Master:GetHelpCategory', async () => {
  const variants = isSandbox() ? loadTitleVariants() : [];
  const variant = variants.length ? titleRotation.next(variants) : null;
  if (!variant) return { __msg: 'Solis.Common.Proto.Api.MasterGetHelpCategoryResponse', HelpCategories: [] } as Decoded;
  const index = variants.indexOf(variant) + 1;
  const title = `Title screen set to ${variant.assetId} (${index} of ${variants.length})`;
  return {
    __msg: 'Solis.Common.Proto.Api.MasterGetHelpCategoryResponse',
    HelpCategories: [{
      __msg: 'Solis.Common.Proto.Master.HelpCategory',
      Id: 'sandbox-title-screen',
      Type: 1,
      Title: title,
      Order: 1,
      Contents: [{
        __msg: 'Solis.Common.Proto.Master.HelpContent',
        HelpContentId: 'sandbox-title-screen-01',
        Title: title,
        Text: 'Open FAQ again to pick the next title. The new title screen shows on ' +
          'your second login from now: the first login downloads it.',
        Order: 1,
      }],
    }],
  } as Decoded;
});
