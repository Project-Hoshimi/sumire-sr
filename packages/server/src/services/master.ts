import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { register } from './handlers.ts';
import { config, DATA_DIR } from '../config.ts';
import { isSandbox } from '../profile.ts';
import { loadTitleVariants, titleMasterVersion, titleRotation } from '../profiles/sandbox/titleBackground.ts';
import type { Decoded } from '@sumire-sr/protocol/runtime/proto.ts';

export const MASTER_BLOBS_DIR = path.join(DATA_DIR, 'phaseA2', 'blobs');
const MANIFEST_PATH = path.join(DATA_DIR, 'phaseA2', 'out', 'manifest.json');

/**
 * Opt-in unknown-partition probe: `phaseA2/script/build_probe_raidquest.py`
 * writes a `RaidQuest` blob + manifest-shaped entry here, and with
 * `SUMIRE_MASTER_PROBE_RAIDQUEST=1` we advertise it as an extra MasterTagPack
 * the client has no protobuf type for. Off (and not even read) by default.
 */
export const MASTER_PROBE_DIR = path.join(DATA_DIR, 'phaseA2', 'blobs_probe');
const PROBE_RAIDQUEST_TYPE = 'RaidQuest';
const PROBE_RAIDQUEST_ENTRY = path.join(MASTER_PROBE_DIR, `${PROBE_RAIDQUEST_TYPE}.json`);

/** Manifest-shaped probe entry; `downloadUrl` is rewritten per response. */
type ProbePack = {
  type: string;
  fileName: string;
  fileSize: number;
  cryptoKey: string;
};

/** Read per call so tests (and a restart) can toggle the probe in one process. */
export function raidQuestProbeEnabled(): boolean {
  return process.env.SUMIRE_MASTER_PROBE_RAIDQUEST === '1';
}

/** The probe pack, or null while the flag is off or the probe was never built. */
export function loadRaidQuestProbe(): ProbePack | null {
  if (!raidQuestProbeEnabled() || !fs.existsSync(PROBE_RAIDQUEST_ENTRY)) return null;
  return JSON.parse(fs.readFileSync(PROBE_RAIDQUEST_ENTRY, 'utf8')) as ProbePack;
}

/** Version the client has not seen before, so it re-syncs the master on enable. */
export function raidQuestProbeVersion(version: string): string {
  return createHash('sha256').update(`${version}:probe-raidquest`).digest('hex');
}

/** Local blob path for `/master/RaidQuest/<file>`, or null when not serving it. */
export function raidQuestProbeBlobPath(type: string, file: string): string | null {
  const probe = loadRaidQuestProbe();
  if (!probe || type !== probe.type || file !== probe.fileName) return null;
  return path.join(MASTER_PROBE_DIR, probe.type);
}

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
  async (ctx) => {
    const m = loadManifest();
    // In sandbox, advertise the current title-screen variant as the master
    // version and as the TitleBackground partition. "FAQ" steps it.
    const variant = isSandbox() ? titleRotation.current(loadTitleVariants()) : null;
    const baseVersion = variant ? titleMasterVersion(m.version, variant) : m.version;
    const packs = m.partitions.map((p) => {
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
    });
    // Opt-in probe: one partition the client has no protobuf type for. Flag off
    // means the response above is untouched, byte for byte.
    const probe = loadRaidQuestProbe();
    if (probe) {
      ctx.fastifyReq.log.info(
        { type: probe.type, fileName: probe.fileName, fileSize: probe.fileSize },
        'master probe: advertising unknown partition',
      );
      packs.push({
        __msg: 'Solis.Common.Proto.Transaction.MasterTagPack',
        Type: probe.type,
        FileName: probe.fileName,
        FileSize: probe.fileSize,
        CryptoKey: probe.cryptoKey,
        DownloadUrl: `${config.publicBaseUrl}/master/${probe.type}/${probe.fileName}`,
      });
    }
    return {
      __msg: 'Solis.Common.Proto.Api.MasterGetResponse',
      MasterTag: {
        __msg: 'Solis.Common.Proto.Transaction.MasterTag',
        // The probe changes the version so the client cannot keep a cached
        // master that lacks the extra pack.
        Version: probe ? raidQuestProbeVersion(baseVersion) : baseVersion,
        MasterTagPacks: packs,
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
