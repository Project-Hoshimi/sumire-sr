/**
 * Master rows the real game client cannot resolve.
 *
 * The client (`game.qualiarts.idolypride` 6.0.3) feeds every owned
 * `UserCostume` / `UserHair` element from `User:Get` through
 * `Solis.Common.Master.<Type>Master.FindByKey(key)` while it initialises user
 * data. `FindByKey` special-cases rows whose master row has its
 * `IsDisableAdmin` flag set (`Costume` field 15, `Hair` field 13): it resolves
 * related master objects and throws `NullReferenceException` when one of them
 * is missing. The whole login aborts and the client bounces back to the title
 * screen.
 *
 * Evidence (bisect against the live emulator, see the sandbox-client-bisect
 * work log): seeding all 994 costumes reproduces
 * `NullReferenceException at CostumeMaster.FindByKey` ← `UserCostumeCollection.Add`
 * ← `UserDataManagerBase.InitializeUserData (UserGetResponse)`. Removing the
 * 18 `IsDisableAdmin` costumes makes the full 976-row set initialise.
 * `cos-ai-buny-00` alone reproduces the costume crash; `hair-ai-buny-00` alone
 * reproduces the identical crash one collection later, at `HairMaster.FindByKey`
 * ← `UserHairCollection.Add`.
 *
 * The flag is not a column in the harvested master tables
 * (`master_Costume` / `master_Hair` only keep the plain fields), so the affected
 * ids are listed explicitly here. Every entry below was decoded from the
 * `IsDisableAdmin` field of the served master protobuf rows
 * (`phaseA2/out/rows/<Type>.jsonl`); all 18 costumes are the `*-buny-00`
 * series plus `hair-kor-hair-00`.
 *
 * The SD-only outfits are listed too. The 親善大使 ("Goodwill Ambassador",
 * `sd-ambassador`) and 一日署長 ("One-day Police Chief", `sd-police`) costumes
 * and their matching hairs carry `IsUserUnavailable` in master: they exist only
 * as chibi models for Activity, so the client offers them in outfit pickers but
 * has no 3D body for them, and 360 LIVE throws `NullReferenceException` in
 * `Photography360Live3DPresenter.LoadActorListAsync` when one is picked.
 */
const SD_ONLY_CHARACTERS = [
  'ai', 'aoi', 'chs', 'hrk', 'kan', 'kkr', 'kor', 'ktn', 'mei', 'mhk',
  'ngs', 'rei', 'rio', 'rui', 'ski', 'skr', 'smr', 'suz', 'szk', 'yu',
];
const SD_ONLY_STYLES = ['sdam-00', 'sdpl-00'];
const sdOnlyIds = (prefix: string) =>
  SD_ONLY_CHARACTERS.flatMap((c) => SD_ONLY_STYLES.map((s) => `${prefix}-${c}-${s}`));

export const CLIENT_UNRESOLVABLE: Readonly<Record<string, readonly string[]>> = {
  Costumes: [
    ...sdOnlyIds('cos'),
    'cos-ai-buny-00',
    'cos-aoi-buny-00',
    'cos-chs-buny-00',
    'cos-hrk-buny-00',
    'cos-kkr-buny-00',
    'cos-ktn-buny-00',
    'cos-mei-buny-00',
    'cos-mna-buny-00',
    'cos-ngs-buny-00',
    'cos-rei-buny-00',
    'cos-rio-buny-00',
    'cos-rui-buny-00',
    'cos-ski-buny-00',
    'cos-skr-buny-00',
    'cos-smr-buny-00',
    'cos-suz-buny-00',
    'cos-szk-buny-00',
    'cos-yu-buny-00',
  ],
  Hairs: [
    ...sdOnlyIds('hair'),
    'hair-ai-buny-00',
    'hair-aoi-buny-00',
    'hair-chs-buny-00',
    'hair-hrk-buny-00',
    'hair-kkr-buny-00',
    'hair-kor-hair-00',
    'hair-ktn-buny-00',
    'hair-mei-buny-00',
    'hair-mna-buny-00',
    'hair-ngs-buny-00',
    'hair-rei-buny-00',
    'hair-rio-buny-00',
    'hair-rui-buny-00',
    'hair-ski-buny-00',
    'hair-skr-buny-00',
    'hair-smr-buny-00',
    'hair-suz-buny-00',
    'hair-szk-buny-00',
    'hair-yu-buny-00',
  ],
};

const BY_FIELD = new Map<string, ReadonlySet<string>>(
  Object.entries(CLIENT_UNRESOLVABLE).map(([field, ids]) => [field, new Set(ids)]),
);

/** Ids of `field` (a `User:Get` collection name) the client cannot resolve. */
export function clientUnresolvableIds(field: string): readonly string[] {
  return CLIENT_UNRESOLVABLE[field] ?? [];
}

/** Whether `id` of `field` is safe to seed for the real client. */
export function isClientResolvable(field: string, id: string): boolean {
  return !(BY_FIELD.get(field)?.has(id) ?? false);
}
