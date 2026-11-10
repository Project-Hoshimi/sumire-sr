// Converted from Solis internal/makino/live/npc_rosters.yaml.
// sumire-sr has no YAML dependency, so the embedded roster table is a typed literal.

export interface NpcRosterCard {
  CardId: string;
  Position: number;
  Level: number;
  Rarity: number;
  LightFanAmount: number;
  MiddleFanAmount: number;
  HeavyFanAmount: number;
  EvolutionLevel: number;
}

export interface NpcRoster {
  Name: string;
  ManagerLevel: number;
  Cards: NpcRosterCard[];
}

export const npcRosters: Readonly<Record<string, NpcRoster>> = {
  "qt-main-1-007-04": {
    Name: "対戦アイドル",
    ManagerLevel: 31,
    Cards: [
      { CardId: "card-skr-05-idol-00", Position: 1, Level: 31, Rarity: 5, LightFanAmount: 1162, MiddleFanAmount: 198, HeavyFanAmount: 110, EvolutionLevel: 0 },
      { CardId: "card-szk-03-schl-00", Position: 2, Level: 31, Rarity: 3, LightFanAmount: 1162, MiddleFanAmount: 198, HeavyFanAmount: 110, EvolutionLevel: 0 },
      { CardId: "card-rei-03-schl-00", Position: 3, Level: 31, Rarity: 3, LightFanAmount: 1162, MiddleFanAmount: 198, HeavyFanAmount: 110, EvolutionLevel: 0 },
      { CardId: "card-hrk-04-casl-00", Position: 4, Level: 31, Rarity: 4, LightFanAmount: 1162, MiddleFanAmount: 198, HeavyFanAmount: 110, EvolutionLevel: 0 },
      { CardId: "card-chs-04-casl-00", Position: 5, Level: 31, Rarity: 4, LightFanAmount: 1162, MiddleFanAmount: 198, HeavyFanAmount: 110, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-015-06": {
    Name: "対戦アイドル",
    ManagerLevel: 66,
    Cards: [
      { CardId: "card-ktn-05-idol-00", Position: 1, Level: 66, Rarity: 5, LightFanAmount: 11080, MiddleFanAmount: 1894, HeavyFanAmount: 1051, EvolutionLevel: 0 },
      { CardId: "card-ski-04-casl-00", Position: 2, Level: 66, Rarity: 4, LightFanAmount: 11080, MiddleFanAmount: 1894, HeavyFanAmount: 1051, EvolutionLevel: 0 },
      { CardId: "card-suz-05-idol-00", Position: 3, Level: 66, Rarity: 5, LightFanAmount: 11080, MiddleFanAmount: 1894, HeavyFanAmount: 1051, EvolutionLevel: 0 },
      { CardId: "card-ngs-03-schl-00", Position: 4, Level: 66, Rarity: 4, LightFanAmount: 11080, MiddleFanAmount: 1894, HeavyFanAmount: 1051, EvolutionLevel: 0 },
      { CardId: "card-mei-04-casl-00", Position: 5, Level: 66, Rarity: 4, LightFanAmount: 11080, MiddleFanAmount: 1894, HeavyFanAmount: 1051, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-025-07": {
    Name: "対戦アイドル",
    ManagerLevel: 91,
    Cards: [
      { CardId: "card-ai-05-idol-00", Position: 1, Level: 91, Rarity: 5, LightFanAmount: 27710, MiddleFanAmount: 4735, HeavyFanAmount: 2630, EvolutionLevel: 0 },
      { CardId: "card-rui-01-casl-00", Position: 2, Level: 91, Rarity: 5, LightFanAmount: 27710, MiddleFanAmount: 4735, HeavyFanAmount: 2630, EvolutionLevel: 0 },
      { CardId: "card-yu-05-idol-00", Position: 3, Level: 91, Rarity: 5, LightFanAmount: 27710, MiddleFanAmount: 4735, HeavyFanAmount: 2630, EvolutionLevel: 0 },
      { CardId: "card-rei-05-idol-00", Position: 4, Level: 91, Rarity: 5, LightFanAmount: 27710, MiddleFanAmount: 4735, HeavyFanAmount: 2630, EvolutionLevel: 0 },
      { CardId: "card-hrk-03-schl-00", Position: 5, Level: 91, Rarity: 5, LightFanAmount: 27710, MiddleFanAmount: 4735, HeavyFanAmount: 2630, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-031-08": {
    Name: "対戦アイドル",
    ManagerLevel: 122,
    Cards: [
      { CardId: "card-rio-05-idol-00", Position: 1, Level: 122, Rarity: 6, LightFanAmount: 57512, MiddleFanAmount: 9828, HeavyFanAmount: 5460, EvolutionLevel: 0 },
      { CardId: "card-skr-03-schl-00", Position: 2, Level: 122, Rarity: 6, LightFanAmount: 57512, MiddleFanAmount: 9828, HeavyFanAmount: 5460, EvolutionLevel: 0 },
      { CardId: "card-rui-05-idol-00", Position: 3, Level: 122, Rarity: 6, LightFanAmount: 57512, MiddleFanAmount: 9828, HeavyFanAmount: 5460, EvolutionLevel: 0 },
      { CardId: "card-smr-05-mizg-01", Position: 4, Level: 122, Rarity: 6, LightFanAmount: 57512, MiddleFanAmount: 9828, HeavyFanAmount: 5460, EvolutionLevel: 0 },
      { CardId: "card-ski-03-schl-00", Position: 5, Level: 122, Rarity: 6, LightFanAmount: 57512, MiddleFanAmount: 9828, HeavyFanAmount: 5460, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-037-08": {
    Name: "対戦アイドル",
    ManagerLevel: 134,
    Cards: [
      { CardId: "card-suz-05-idol-00", Position: 1, Level: 134, Rarity: 7, LightFanAmount: 67940, MiddleFanAmount: 11610, HeavyFanAmount: 6450, EvolutionLevel: 0 },
      { CardId: "card-skr-02-casl-00", Position: 2, Level: 134, Rarity: 7, LightFanAmount: 67940, MiddleFanAmount: 11610, HeavyFanAmount: 6450, EvolutionLevel: 0 },
      { CardId: "card-smr-05-idol-00", Position: 3, Level: 134, Rarity: 7, LightFanAmount: 67940, MiddleFanAmount: 11610, HeavyFanAmount: 6450, EvolutionLevel: 0 },
      { CardId: "card-chs-03-schl-00", Position: 4, Level: 134, Rarity: 7, LightFanAmount: 67940, MiddleFanAmount: 11610, HeavyFanAmount: 6450, EvolutionLevel: 0 },
      { CardId: "card-kkr-05-idol-00", Position: 5, Level: 134, Rarity: 7, LightFanAmount: 67940, MiddleFanAmount: 11610, HeavyFanAmount: 6450, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-043-08": {
    Name: "対戦アイドル",
    ManagerLevel: 151,
    Cards: [
      { CardId: "card-ai-05-idol-00", Position: 1, Level: 151, Rarity: 8, LightFanAmount: 81370, MiddleFanAmount: 13905, HeavyFanAmount: 7725, EvolutionLevel: 0 },
      { CardId: "card-aoi-04-casl-00", Position: 2, Level: 151, Rarity: 8, LightFanAmount: 81370, MiddleFanAmount: 13905, HeavyFanAmount: 7725, EvolutionLevel: 0 },
      { CardId: "card-rei-05-idol-00", Position: 3, Level: 151, Rarity: 8, LightFanAmount: 81370, MiddleFanAmount: 13905, HeavyFanAmount: 7725, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-mizg-01", Position: 4, Level: 151, Rarity: 8, LightFanAmount: 81370, MiddleFanAmount: 13905, HeavyFanAmount: 7725, EvolutionLevel: 0 },
      { CardId: "card-ski-05-idol-00", Position: 5, Level: 151, Rarity: 8, LightFanAmount: 81370, MiddleFanAmount: 13905, HeavyFanAmount: 7725, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-049-08": {
    Name: "対戦アイドル",
    ManagerLevel: 160,
    Cards: [
      { CardId: "card-rei-05-rock-00", Position: 1, Level: 160, Rarity: 8, LightFanAmount: 88480, MiddleFanAmount: 15120, HeavyFanAmount: 8400, EvolutionLevel: 0 },
      { CardId: "card-chs-05-idol-00", Position: 2, Level: 160, Rarity: 8, LightFanAmount: 88480, MiddleFanAmount: 15120, HeavyFanAmount: 8400, EvolutionLevel: 0 },
      { CardId: "card-smr-05-idol-00", Position: 3, Level: 160, Rarity: 8, LightFanAmount: 88480, MiddleFanAmount: 15120, HeavyFanAmount: 8400, EvolutionLevel: 0 },
      { CardId: "card-yu-05-idol-00", Position: 4, Level: 160, Rarity: 8, LightFanAmount: 88480, MiddleFanAmount: 15120, HeavyFanAmount: 8400, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-idol-00", Position: 5, Level: 160, Rarity: 8, LightFanAmount: 88480, MiddleFanAmount: 15120, HeavyFanAmount: 8400, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-055-08": {
    Name: "対戦アイドル",
    ManagerLevel: 170,
    Cards: [
      { CardId: "card-rio-05-idol-00", Position: 1, Level: 170, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
      { CardId: "card-ktn-05-idol-00", Position: 2, Level: 170, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
      { CardId: "card-rui-05-idol-00", Position: 3, Level: 170, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
      { CardId: "card-suz-05-mizg-01", Position: 4, Level: 170, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
      { CardId: "card-smr-05-mizg-01", Position: 5, Level: 170, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-061-08": {
    Name: "対戦アイドル",
    ManagerLevel: 188,
    Cards: [
      { CardId: "card-rio-05-halw-00", Position: 1, Level: 188, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
      { CardId: "card-ai-05-idol-00", Position: 2, Level: 188, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-mizg-01", Position: 3, Level: 188, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
      { CardId: "card-rei-05-idol-00", Position: 4, Level: 188, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
      { CardId: "card-ski-05-kifj-00", Position: 5, Level: 188, Rarity: 8, LightFanAmount: 96380, MiddleFanAmount: 16470, HeavyFanAmount: 9150, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-067-08": {
    Name: "対戦アイドル",
    ManagerLevel: 206,
    Cards: [
      { CardId: "card-rei-05-rock-00", Position: 1, Level: 200, Rarity: 9, LightFanAmount: 130120, MiddleFanAmount: 22235, HeavyFanAmount: 12353, EvolutionLevel: 0 },
      { CardId: "card-chs-05-idol-00", Position: 2, Level: 200, Rarity: 9, LightFanAmount: 130120, MiddleFanAmount: 22235, HeavyFanAmount: 12353, EvolutionLevel: 0 },
      { CardId: "card-suz-05-idol-00", Position: 3, Level: 200, Rarity: 9, LightFanAmount: 130120, MiddleFanAmount: 22235, HeavyFanAmount: 12353, EvolutionLevel: 0 },
      { CardId: "card-rio-01-casl-00", Position: 4, Level: 200, Rarity: 9, LightFanAmount: 130120, MiddleFanAmount: 22235, HeavyFanAmount: 12353, EvolutionLevel: 0 },
      { CardId: "card-szk-05-chna-00", Position: 5, Level: 200, Rarity: 9, LightFanAmount: 130120, MiddleFanAmount: 22235, HeavyFanAmount: 12353, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-075-08": {
    Name: "対戦アイドル",
    ManagerLevel: 223,
    Cards: [
      { CardId: "card-ktn-05-idol-00", Position: 1, Level: 200, Rarity: 9, LightFanAmount: 155205, MiddleFanAmount: 26523, HeavyFanAmount: 14734, EvolutionLevel: 0 },
      { CardId: "card-chs-04-casl-00", Position: 2, Level: 200, Rarity: 9, LightFanAmount: 155205, MiddleFanAmount: 26523, HeavyFanAmount: 14734, EvolutionLevel: 0 },
      { CardId: "card-skr-05-idol-00", Position: 3, Level: 200, Rarity: 9, LightFanAmount: 155205, MiddleFanAmount: 26523, HeavyFanAmount: 14734, EvolutionLevel: 0 },
      { CardId: "card-ski-03-schl-00", Position: 4, Level: 200, Rarity: 9, LightFanAmount: 155205, MiddleFanAmount: 26523, HeavyFanAmount: 14734, EvolutionLevel: 0 },
      { CardId: "card-hrk-05-idol-00", Position: 5, Level: 200, Rarity: 9, LightFanAmount: 155205, MiddleFanAmount: 26523, HeavyFanAmount: 14734, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-083-08": {
    Name: "対戦アイドル",
    ManagerLevel: 250,
    Cards: [
      { CardId: "card-kor-05-idol-00", Position: 1, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
      { CardId: "card-rei-05-rock-00", Position: 2, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
      { CardId: "card-smr-03-schl-00", Position: 3, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
      { CardId: "card-szk-05-chna-00", Position: 4, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
      { CardId: "card-ski-05-waso-00", Position: 5, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-089-08": {
    Name: "対戦アイドル",
    ManagerLevel: 265,
    Cards: [
      { CardId: "card-kkr-05-mizg-01", Position: 1, Level: 200, Rarity: 10, LightFanAmount: 208680, MiddleFanAmount: 35660, HeavyFanAmount: 19811, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-mizg-01", Position: 2, Level: 200, Rarity: 10, LightFanAmount: 208680, MiddleFanAmount: 35660, HeavyFanAmount: 19811, EvolutionLevel: 0 },
      { CardId: "card-szk-05-rock-00", Position: 3, Level: 200, Rarity: 10, LightFanAmount: 208680, MiddleFanAmount: 35660, HeavyFanAmount: 19811, EvolutionLevel: 0 },
      { CardId: "card-hrk-05-chna-00", Position: 4, Level: 200, Rarity: 10, LightFanAmount: 208680, MiddleFanAmount: 35660, HeavyFanAmount: 19811, EvolutionLevel: 0 },
      { CardId: "card-smr-05-mizg-01", Position: 5, Level: 200, Rarity: 10, LightFanAmount: 208680, MiddleFanAmount: 35660, HeavyFanAmount: 19811, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-095-08": {
    Name: "対戦アイドル",
    ManagerLevel: 280,
    Cards: [
      { CardId: "card-rio-05-fest-00", Position: 1, Level: 200, Rarity: 10, LightFanAmount: 219859, MiddleFanAmount: 37571, HeavyFanAmount: 20872, EvolutionLevel: 0 },
      { CardId: "card-hrk-05-onep-00", Position: 2, Level: 200, Rarity: 10, LightFanAmount: 219859, MiddleFanAmount: 37571, HeavyFanAmount: 20872, EvolutionLevel: 0 },
      { CardId: "card-ski-05-mizg-02", Position: 3, Level: 200, Rarity: 10, LightFanAmount: 219859, MiddleFanAmount: 37571, HeavyFanAmount: 20872, EvolutionLevel: 0 },
      { CardId: "card-smr-05-mizg-01", Position: 4, Level: 200, Rarity: 10, LightFanAmount: 219859, MiddleFanAmount: 37571, HeavyFanAmount: 20872, EvolutionLevel: 0 },
      { CardId: "card-szk-05-chna-00", Position: 5, Level: 200, Rarity: 10, LightFanAmount: 219859, MiddleFanAmount: 37571, HeavyFanAmount: 20872, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-098-08": {
    Name: "対戦アイドル",
    ManagerLevel: 283,
    Cards: [
      { CardId: "card-ski-05-waso-00", Position: 1, Level: 201, Rarity: 10, LightFanAmount: 222095, MiddleFanAmount: 37953, HeavyFanAmount: 21084, EvolutionLevel: 0 },
      { CardId: "card-rei-05-casl-02", Position: 2, Level: 201, Rarity: 10, LightFanAmount: 222095, MiddleFanAmount: 37953, HeavyFanAmount: 21084, EvolutionLevel: 0 },
      { CardId: "card-hrk-02-eve-03", Position: 3, Level: 201, Rarity: 10, LightFanAmount: 222095, MiddleFanAmount: 37953, HeavyFanAmount: 21084, EvolutionLevel: 0 },
      { CardId: "card-chs-05-flow-00", Position: 4, Level: 201, Rarity: 10, LightFanAmount: 222095, MiddleFanAmount: 37953, HeavyFanAmount: 21084, EvolutionLevel: 0 },
      { CardId: "card-smr-05-mizg-01", Position: 5, Level: 201, Rarity: 10, LightFanAmount: 222095, MiddleFanAmount: 37953, HeavyFanAmount: 21084, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-101-08": {
    Name: "対戦アイドル",
    ManagerLevel: 286,
    Cards: [
      { CardId: "card-ngs-05-yukt-00", Position: 1, Level: 202, Rarity: 10, LightFanAmount: 224330, MiddleFanAmount: 38335, HeavyFanAmount: 21297, EvolutionLevel: 0 },
      { CardId: "card-szk-05-yukt-00", Position: 2, Level: 202, Rarity: 10, LightFanAmount: 224330, MiddleFanAmount: 38335, HeavyFanAmount: 21297, EvolutionLevel: 0 },
      { CardId: "card-kkr-02-eve-00", Position: 3, Level: 202, Rarity: 10, LightFanAmount: 224330, MiddleFanAmount: 38335, HeavyFanAmount: 21297, EvolutionLevel: 0 },
      { CardId: "card-rio-05-wedd-00", Position: 4, Level: 202, Rarity: 10, LightFanAmount: 224330, MiddleFanAmount: 38335, HeavyFanAmount: 21297, EvolutionLevel: 0 },
      { CardId: "card-ski-05-poli-00", Position: 5, Level: 202, Rarity: 10, LightFanAmount: 224330, MiddleFanAmount: 38335, HeavyFanAmount: 21297, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-104-08": {
    Name: "対戦アイドル",
    ManagerLevel: 289,
    Cards: [
      { CardId: "card-kor-05-idol-03", Position: 1, Level: 204, Rarity: 10, LightFanAmount: 226566, MiddleFanAmount: 38717, HeavyFanAmount: 21509, EvolutionLevel: 0 },
      { CardId: "card-chs-05-yukt-00", Position: 2, Level: 204, Rarity: 10, LightFanAmount: 226566, MiddleFanAmount: 38717, HeavyFanAmount: 21509, EvolutionLevel: 0 },
      { CardId: "card-ktn-05-add-00", Position: 3, Level: 204, Rarity: 10, LightFanAmount: 226566, MiddleFanAmount: 38717, HeavyFanAmount: 21509, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-casl-02", Position: 4, Level: 204, Rarity: 10, LightFanAmount: 226566, MiddleFanAmount: 38717, HeavyFanAmount: 21509, EvolutionLevel: 0 },
      { CardId: "card-aoi-05-circ-00", Position: 5, Level: 204, Rarity: 10, LightFanAmount: 226566, MiddleFanAmount: 38717, HeavyFanAmount: 21509, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-107-08": {
    Name: "対戦アイドル",
    ManagerLevel: 292,
    Cards: [
      { CardId: "card-chs-05-flow-00", Position: 1, Level: 205, Rarity: 10, LightFanAmount: 228803, MiddleFanAmount: 39099, HeavyFanAmount: 21721, EvolutionLevel: 0 },
      { CardId: "card-kan-05-chna-00", Position: 2, Level: 205, Rarity: 10, LightFanAmount: 228803, MiddleFanAmount: 39099, HeavyFanAmount: 21721, EvolutionLevel: 0 },
      { CardId: "card-rei-05-casl-02", Position: 3, Level: 205, Rarity: 10, LightFanAmount: 228803, MiddleFanAmount: 39099, HeavyFanAmount: 21721, EvolutionLevel: 0 },
      { CardId: "card-ktn-05-circ-00", Position: 4, Level: 205, Rarity: 10, LightFanAmount: 228803, MiddleFanAmount: 39099, HeavyFanAmount: 21721, EvolutionLevel: 0 },
      { CardId: "card-szk-05-sail-00", Position: 5, Level: 205, Rarity: 10, LightFanAmount: 228803, MiddleFanAmount: 39099, HeavyFanAmount: 21721, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-110-08": {
    Name: "対戦アイドル",
    ManagerLevel: 295,
    Cards: [
      { CardId: "card-hrk-05-fest-00", Position: 1, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
      { CardId: "card-mei-05-casl-02", Position: 2, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
      { CardId: "card-mna-05-fest-02", Position: 3, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
      { CardId: "card-rui-05-yukt-00", Position: 4, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
      { CardId: "card-skr-05-anml-00", Position: 5, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-113-08": {
    Name: "対戦アイドル",
    ManagerLevel: 301,
    Cards: [
      { CardId: "card-rei-05-fest-01", Position: 1, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
      { CardId: "card-mhk-05-pajm-00", Position: 2, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
      { CardId: "card-kor-05-xmas-00", Position: 3, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
      { CardId: "card-ai-05-yukt-00", Position: 4, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
      { CardId: "card-smr-05-nurs-00", Position: 5, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-116-08": {
    Name: "対戦アイドル",
    ManagerLevel: 301,
    Cards: [
      { CardId: "card-ktn-05-poli-00", Position: 1, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
      { CardId: "card-kkr-05-mizg-02", Position: 2, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
      { CardId: "card-kan-05-chna-00", Position: 3, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
      { CardId: "card-yu-05-chna-00", Position: 4, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
      { CardId: "card-rio-05-fest-03", Position: 5, Level: 210, Rarity: 10, LightFanAmount: 235510, MiddleFanAmount: 40245, HeavyFanAmount: 22358, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-119-08": {
    Name: "対戦アイドル",
    ManagerLevel: 319,
    Cards: [
      { CardId: "card-mhk-05-fest-02", Position: 1, Level: 215, Rarity: 10, LightFanAmount: 248925, MiddleFanAmount: 42537, HeavyFanAmount: 23632, EvolutionLevel: 0 },
      { CardId: "card-chs-05-rock-00", Position: 2, Level: 215, Rarity: 10, LightFanAmount: 248925, MiddleFanAmount: 42537, HeavyFanAmount: 23632, EvolutionLevel: 0 },
      { CardId: "card-kkr-05-flow-00", Position: 3, Level: 215, Rarity: 10, LightFanAmount: 248925, MiddleFanAmount: 42537, HeavyFanAmount: 23632, EvolutionLevel: 0 },
      { CardId: "card-mei-05-casl-02", Position: 4, Level: 215, Rarity: 10, LightFanAmount: 248925, MiddleFanAmount: 42537, HeavyFanAmount: 23632, EvolutionLevel: 0 },
      { CardId: "card-skr-05-anml-00", Position: 5, Level: 215, Rarity: 10, LightFanAmount: 248925, MiddleFanAmount: 42537, HeavyFanAmount: 23632, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-122-08": {
    Name: "対戦アイドル",
    ManagerLevel: 328,
    Cards: [
      { CardId: "card-yu-05-vlnt-00", Position: 1, Level: 220, Rarity: 10, LightFanAmount: 255633, MiddleFanAmount: 43684, HeavyFanAmount: 24268, EvolutionLevel: 0 },
      { CardId: "card-mhk-05-pajm-00", Position: 2, Level: 220, Rarity: 10, LightFanAmount: 255633, MiddleFanAmount: 43684, HeavyFanAmount: 24268, EvolutionLevel: 0 },
      { CardId: "card-rui-05-fest-03", Position: 3, Level: 220, Rarity: 10, LightFanAmount: 255633, MiddleFanAmount: 43684, HeavyFanAmount: 24268, EvolutionLevel: 0 },
      { CardId: "card-ai-05-chna-01", Position: 4, Level: 220, Rarity: 10, LightFanAmount: 255633, MiddleFanAmount: 43684, HeavyFanAmount: 24268, EvolutionLevel: 0 },
      { CardId: "card-smr-05-maid-00", Position: 5, Level: 220, Rarity: 10, LightFanAmount: 255633, MiddleFanAmount: 43684, HeavyFanAmount: 24268, EvolutionLevel: 0 },
    ],
  },
  "qt-main-1-125-08": {
    Name: "対戦アイドル",
    ManagerLevel: 337,
    Cards: [
      { CardId: "card-chs-05-fest-03", Position: 1, Level: 221, Rarity: 10, LightFanAmount: 262340, MiddleFanAmount: 44830, HeavyFanAmount: 24905, EvolutionLevel: 0 },
      { CardId: "card-rio-05-pajm-00", Position: 2, Level: 221, Rarity: 10, LightFanAmount: 262340, MiddleFanAmount: 44830, HeavyFanAmount: 24905, EvolutionLevel: 0 },
      { CardId: "card-yu-05-casl-02", Position: 3, Level: 221, Rarity: 10, LightFanAmount: 262340, MiddleFanAmount: 44830, HeavyFanAmount: 24905, EvolutionLevel: 0 },
      { CardId: "card-ktn-05-poli-00", Position: 4, Level: 221, Rarity: 10, LightFanAmount: 262340, MiddleFanAmount: 44830, HeavyFanAmount: 24905, EvolutionLevel: 0 },
      { CardId: "card-rei-05-casl-02", Position: 5, Level: 221, Rarity: 10, LightFanAmount: 262340, MiddleFanAmount: 44830, HeavyFanAmount: 24905, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-050": {
    Name: "対戦アイドル",
    ManagerLevel: 58,
    Cards: [
      { CardId: "card-yu-04-casl-00", Position: 1, Level: 58, Rarity: 4, LightFanAmount: 7241, MiddleFanAmount: 1237, HeavyFanAmount: 687, EvolutionLevel: 0 },
      { CardId: "card-skr-03-schl-00", Position: 2, Level: 58, Rarity: 3, LightFanAmount: 7241, MiddleFanAmount: 1237, HeavyFanAmount: 687, EvolutionLevel: 0 },
      { CardId: "card-ngs-04-casl-00", Position: 3, Level: 58, Rarity: 4, LightFanAmount: 7241, MiddleFanAmount: 1237, HeavyFanAmount: 687, EvolutionLevel: 0 },
      { CardId: "card-ai-03-schl-00", Position: 4, Level: 58, Rarity: 3, LightFanAmount: 7241, MiddleFanAmount: 1237, HeavyFanAmount: 687, EvolutionLevel: 0 },
      { CardId: "card-mei-04-casl-00", Position: 5, Level: 58, Rarity: 4, LightFanAmount: 7241, MiddleFanAmount: 1237, HeavyFanAmount: 687, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-100": {
    Name: "対戦アイドル",
    ManagerLevel: 70,
    Cards: [
      { CardId: "card-ai-05-idol-00", Position: 1, Level: 70, Rarity: 5, LightFanAmount: 14457, MiddleFanAmount: 2471, HeavyFanAmount: 1372, EvolutionLevel: 0 },
      { CardId: "card-yu-03-schl-00", Position: 2, Level: 70, Rarity: 4, LightFanAmount: 14457, MiddleFanAmount: 2471, HeavyFanAmount: 1372, EvolutionLevel: 0 },
      { CardId: "card-ktn-04-casl-00", Position: 3, Level: 70, Rarity: 4, LightFanAmount: 14457, MiddleFanAmount: 2471, HeavyFanAmount: 1372, EvolutionLevel: 0 },
      { CardId: "card-hrk-03-schl-00", Position: 4, Level: 70, Rarity: 4, LightFanAmount: 14457, MiddleFanAmount: 2471, HeavyFanAmount: 1372, EvolutionLevel: 0 },
      { CardId: "card-skr-04-casl-00", Position: 5, Level: 70, Rarity: 4, LightFanAmount: 14457, MiddleFanAmount: 2471, HeavyFanAmount: 1372, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-150": {
    Name: "対戦アイドル",
    ManagerLevel: 84,
    Cards: [
      { CardId: "card-smr-05-idol-00", Position: 1, Level: 84, Rarity: 5, LightFanAmount: 24411, MiddleFanAmount: 4172, HeavyFanAmount: 2317, EvolutionLevel: 0 },
      { CardId: "card-mei-03-schl-00", Position: 2, Level: 84, Rarity: 5, LightFanAmount: 24411, MiddleFanAmount: 4172, HeavyFanAmount: 2317, EvolutionLevel: 0 },
      { CardId: "card-szk-03-schl-00", Position: 3, Level: 84, Rarity: 5, LightFanAmount: 24411, MiddleFanAmount: 4172, HeavyFanAmount: 2317, EvolutionLevel: 0 },
      { CardId: "card-yu-05-idol-00", Position: 4, Level: 84, Rarity: 5, LightFanAmount: 24411, MiddleFanAmount: 4172, HeavyFanAmount: 2317, EvolutionLevel: 0 },
      { CardId: "card-rio-01-casl-00", Position: 5, Level: 84, Rarity: 5, LightFanAmount: 24411, MiddleFanAmount: 4172, HeavyFanAmount: 2317, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-200": {
    Name: "対戦アイドル",
    ManagerLevel: 100,
    Cards: [
      { CardId: "card-rio-05-idol-00", Position: 1, Level: 100, Rarity: 6, LightFanAmount: 34010, MiddleFanAmount: 5812, HeavyFanAmount: 3228, EvolutionLevel: 0 },
      { CardId: "card-yu-04-casl-00", Position: 2, Level: 100, Rarity: 6, LightFanAmount: 34010, MiddleFanAmount: 5812, HeavyFanAmount: 3228, EvolutionLevel: 0 },
      { CardId: "card-ski-05-idol-00", Position: 3, Level: 100, Rarity: 6, LightFanAmount: 34010, MiddleFanAmount: 5812, HeavyFanAmount: 3228, EvolutionLevel: 0 },
      { CardId: "card-hrk-05-idol-00", Position: 4, Level: 100, Rarity: 6, LightFanAmount: 34010, MiddleFanAmount: 5812, HeavyFanAmount: 3228, EvolutionLevel: 0 },
      { CardId: "card-ngs-03-schl-00", Position: 5, Level: 100, Rarity: 6, LightFanAmount: 34010, MiddleFanAmount: 5812, HeavyFanAmount: 3228, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-250": {
    Name: "対戦アイドル",
    ManagerLevel: 114,
    Cards: [
      { CardId: "card-mei-05-idol-00", Position: 1, Level: 114, Rarity: 6, LightFanAmount: 47938, MiddleFanAmount: 8191, HeavyFanAmount: 4551, EvolutionLevel: 0 },
      { CardId: "card-suz-05-idol-00", Position: 2, Level: 114, Rarity: 6, LightFanAmount: 47938, MiddleFanAmount: 8191, HeavyFanAmount: 4551, EvolutionLevel: 0 },
      { CardId: "card-aoi-05-idol-00", Position: 3, Level: 114, Rarity: 6, LightFanAmount: 47938, MiddleFanAmount: 8191, HeavyFanAmount: 4551, EvolutionLevel: 0 },
      { CardId: "card-ktn-02-casl-00", Position: 4, Level: 114, Rarity: 6, LightFanAmount: 47938, MiddleFanAmount: 8191, HeavyFanAmount: 4551, EvolutionLevel: 0 },
      { CardId: "card-ski-05-idol-00", Position: 5, Level: 114, Rarity: 6, LightFanAmount: 47938, MiddleFanAmount: 8191, HeavyFanAmount: 4551, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-300": {
    Name: "対戦アイドル",
    ManagerLevel: 129,
    Cards: [
      { CardId: "card-smr-05-idol-00", Position: 1, Level: 129, Rarity: 7, LightFanAmount: 63990, MiddleFanAmount: 10935, HeavyFanAmount: 6075, EvolutionLevel: 0 },
      { CardId: "card-suz-05-idol-00", Position: 2, Level: 129, Rarity: 7, LightFanAmount: 63990, MiddleFanAmount: 10935, HeavyFanAmount: 6075, EvolutionLevel: 0 },
      { CardId: "card-szk-05-idol-00", Position: 3, Level: 129, Rarity: 7, LightFanAmount: 63990, MiddleFanAmount: 10935, HeavyFanAmount: 6075, EvolutionLevel: 0 },
      { CardId: "card-chs-05-idol-00", Position: 4, Level: 129, Rarity: 7, LightFanAmount: 63990, MiddleFanAmount: 10935, HeavyFanAmount: 6075, EvolutionLevel: 0 },
      { CardId: "card-yu-05-idol-00", Position: 5, Level: 129, Rarity: 7, LightFanAmount: 63990, MiddleFanAmount: 10935, HeavyFanAmount: 6075, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-350": {
    Name: "対戦アイドル",
    ManagerLevel: 144,
    Cards: [
      { CardId: "card-skr-05-idol-00", Position: 1, Level: 144, Rarity: 8, LightFanAmount: 75840, MiddleFanAmount: 12960, HeavyFanAmount: 7200, EvolutionLevel: 0 },
      { CardId: "card-ktn-05-idol-00", Position: 2, Level: 144, Rarity: 8, LightFanAmount: 75840, MiddleFanAmount: 12960, HeavyFanAmount: 7200, EvolutionLevel: 0 },
      { CardId: "card-rui-05-idol-00", Position: 3, Level: 144, Rarity: 8, LightFanAmount: 75840, MiddleFanAmount: 12960, HeavyFanAmount: 7200, EvolutionLevel: 0 },
      { CardId: "card-szk-05-idol-00", Position: 4, Level: 144, Rarity: 8, LightFanAmount: 75840, MiddleFanAmount: 12960, HeavyFanAmount: 7200, EvolutionLevel: 0 },
      { CardId: "card-ngs-03-schl-00", Position: 5, Level: 144, Rarity: 8, LightFanAmount: 75840, MiddleFanAmount: 12960, HeavyFanAmount: 7200, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-400": {
    Name: "対戦アイドル",
    ManagerLevel: 159,
    Cards: [
      { CardId: "card-ai-05-idol-00", Position: 1, Level: 159, Rarity: 8, LightFanAmount: 87690, MiddleFanAmount: 14985, HeavyFanAmount: 8325, EvolutionLevel: 0 },
      { CardId: "card-mei-05-idol-00", Position: 2, Level: 159, Rarity: 8, LightFanAmount: 87690, MiddleFanAmount: 14985, HeavyFanAmount: 8325, EvolutionLevel: 0 },
      { CardId: "card-aoi-05-idol-00", Position: 3, Level: 159, Rarity: 8, LightFanAmount: 87690, MiddleFanAmount: 14985, HeavyFanAmount: 8325, EvolutionLevel: 0 },
      { CardId: "card-ski-05-idol-00", Position: 4, Level: 159, Rarity: 8, LightFanAmount: 87690, MiddleFanAmount: 14985, HeavyFanAmount: 8325, EvolutionLevel: 0 },
      { CardId: "card-rei-05-idol-00", Position: 5, Level: 159, Rarity: 8, LightFanAmount: 87690, MiddleFanAmount: 14985, HeavyFanAmount: 8325, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-450": {
    Name: "対戦アイドル",
    ManagerLevel: 174,
    Cards: [
      { CardId: "card-suz-05-idol-00", Position: 1, Level: 174, Rarity: 8, LightFanAmount: 99540, MiddleFanAmount: 17010, HeavyFanAmount: 9450, EvolutionLevel: 0 },
      { CardId: "card-smr-05-idol-00", Position: 2, Level: 174, Rarity: 8, LightFanAmount: 99540, MiddleFanAmount: 17010, HeavyFanAmount: 9450, EvolutionLevel: 0 },
      { CardId: "card-chs-05-idol-00", Position: 3, Level: 174, Rarity: 8, LightFanAmount: 99540, MiddleFanAmount: 17010, HeavyFanAmount: 9450, EvolutionLevel: 0 },
      { CardId: "card-yu-05-idol-00", Position: 4, Level: 174, Rarity: 8, LightFanAmount: 99540, MiddleFanAmount: 17010, HeavyFanAmount: 9450, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-idol-00", Position: 5, Level: 174, Rarity: 8, LightFanAmount: 99540, MiddleFanAmount: 17010, HeavyFanAmount: 9450, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-500": {
    Name: "対戦アイドル",
    ManagerLevel: 200,
    Cards: [
      { CardId: "card-skr-05-idol-00", Position: 1, Level: 200, Rarity: 8, LightFanAmount: 120080, MiddleFanAmount: 20520, HeavyFanAmount: 11400, EvolutionLevel: 0 },
      { CardId: "card-rio-05-idol-00", Position: 2, Level: 200, Rarity: 8, LightFanAmount: 120080, MiddleFanAmount: 20520, HeavyFanAmount: 11400, EvolutionLevel: 0 },
      { CardId: "card-rui-05-idol-00", Position: 3, Level: 200, Rarity: 8, LightFanAmount: 120080, MiddleFanAmount: 20520, HeavyFanAmount: 11400, EvolutionLevel: 0 },
      { CardId: "card-szk-05-idol-00", Position: 4, Level: 200, Rarity: 8, LightFanAmount: 120080, MiddleFanAmount: 20520, HeavyFanAmount: 11400, EvolutionLevel: 0 },
      { CardId: "card-hrk-05-idol-00", Position: 5, Level: 200, Rarity: 8, LightFanAmount: 120080, MiddleFanAmount: 20520, HeavyFanAmount: 11400, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-550": {
    Name: "対戦アイドル",
    ManagerLevel: 209,
    Cards: [
      { CardId: "card-rio-05-halw-00", Position: 1, Level: 200, Rarity: 8, LightFanAmount: 134390, MiddleFanAmount: 22965, HeavyFanAmount: 12758, EvolutionLevel: 0 },
      { CardId: "card-rei-03-schl-00", Position: 2, Level: 200, Rarity: 8, LightFanAmount: 134390, MiddleFanAmount: 22965, HeavyFanAmount: 12758, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-mizg-01", Position: 3, Level: 200, Rarity: 8, LightFanAmount: 134390, MiddleFanAmount: 22965, HeavyFanAmount: 12758, EvolutionLevel: 0 },
      { CardId: "card-ski-05-kifj-00", Position: 4, Level: 200, Rarity: 8, LightFanAmount: 134390, MiddleFanAmount: 22965, HeavyFanAmount: 12758, EvolutionLevel: 0 },
      { CardId: "card-hrk-03-schl-00", Position: 5, Level: 200, Rarity: 8, LightFanAmount: 134390, MiddleFanAmount: 22965, HeavyFanAmount: 12758, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-600": {
    Name: "対戦アイドル",
    ManagerLevel: 222,
    Cards: [
      { CardId: "card-rei-05-rock-00", Position: 1, Level: 200, Rarity: 8, LightFanAmount: 153671, MiddleFanAmount: 26260, HeavyFanAmount: 14588, EvolutionLevel: 0 },
      { CardId: "card-smr-05-idol-00", Position: 2, Level: 200, Rarity: 8, LightFanAmount: 153671, MiddleFanAmount: 26260, HeavyFanAmount: 14588, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-idol-00", Position: 3, Level: 200, Rarity: 8, LightFanAmount: 153671, MiddleFanAmount: 26260, HeavyFanAmount: 14588, EvolutionLevel: 0 },
      { CardId: "card-szk-05-chna-00", Position: 4, Level: 200, Rarity: 8, LightFanAmount: 153671, MiddleFanAmount: 26260, HeavyFanAmount: 14588, EvolutionLevel: 0 },
      { CardId: "card-ski-04-casl-00", Position: 5, Level: 200, Rarity: 8, LightFanAmount: 153671, MiddleFanAmount: 26260, HeavyFanAmount: 14588, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-650": {
    Name: "対戦アイドル",
    ManagerLevel: 231,
    Cards: [
      { CardId: "card-ngs-05-flow-00", Position: 1, Level: 200, Rarity: 9, LightFanAmount: 167756, MiddleFanAmount: 28667, HeavyFanAmount: 15926, EvolutionLevel: 0 },
      { CardId: "card-rio-05-idol-00", Position: 2, Level: 200, Rarity: 9, LightFanAmount: 167756, MiddleFanAmount: 28667, HeavyFanAmount: 15926, EvolutionLevel: 0 },
      { CardId: "card-rui-05-idol-00", Position: 3, Level: 200, Rarity: 9, LightFanAmount: 167756, MiddleFanAmount: 28667, HeavyFanAmount: 15926, EvolutionLevel: 0 },
      { CardId: "card-hrk-05-idol-00", Position: 4, Level: 200, Rarity: 9, LightFanAmount: 167756, MiddleFanAmount: 28667, HeavyFanAmount: 15926, EvolutionLevel: 0 },
      { CardId: "card-smr-05-mizg-01", Position: 5, Level: 200, Rarity: 9, LightFanAmount: 167756, MiddleFanAmount: 28667, HeavyFanAmount: 15926, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-700": {
    Name: "対戦アイドル",
    ManagerLevel: 250,
    Cards: [
      { CardId: "card-rio-05-halw-00", Position: 1, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
      { CardId: "card-ai-05-idol-00", Position: 2, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
      { CardId: "card-yu-03-schl-00", Position: 3, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
      { CardId: "card-rei-05-idol-00", Position: 4, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-mizg-01", Position: 5, Level: 200, Rarity: 9, LightFanAmount: 197501, MiddleFanAmount: 33750, HeavyFanAmount: 18749, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-750": {
    Name: "対戦アイドル",
    ManagerLevel: 270,
    Cards: [
      { CardId: "card-aoi-05-vlnt-00", Position: 1, Level: 200, Rarity: 10, LightFanAmount: 212406, MiddleFanAmount: 36297, HeavyFanAmount: 20165, EvolutionLevel: 0 },
      { CardId: "card-rei-05-rock-00", Position: 2, Level: 200, Rarity: 10, LightFanAmount: 212406, MiddleFanAmount: 36297, HeavyFanAmount: 20165, EvolutionLevel: 0 },
      { CardId: "card-szk-05-chna-00", Position: 3, Level: 200, Rarity: 10, LightFanAmount: 212406, MiddleFanAmount: 36297, HeavyFanAmount: 20165, EvolutionLevel: 0 },
      { CardId: "card-smr-05-frut-00", Position: 4, Level: 200, Rarity: 10, LightFanAmount: 212406, MiddleFanAmount: 36297, HeavyFanAmount: 20165, EvolutionLevel: 0 },
      { CardId: "card-ski-05-mizg-02", Position: 5, Level: 200, Rarity: 10, LightFanAmount: 212406, MiddleFanAmount: 36297, HeavyFanAmount: 20165, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-800": {
    Name: "対戦アイドル",
    ManagerLevel: 290,
    Cards: [
      { CardId: "card-ski-05-waso-00", Position: 1, Level: 204, Rarity: 10, LightFanAmount: 227312, MiddleFanAmount: 38844, HeavyFanAmount: 21580, EvolutionLevel: 0 },
      { CardId: "card-szk-05-rock-00", Position: 2, Level: 204, Rarity: 10, LightFanAmount: 227312, MiddleFanAmount: 38844, HeavyFanAmount: 21580, EvolutionLevel: 0 },
      { CardId: "card-skr-05-idol-00", Position: 3, Level: 204, Rarity: 10, LightFanAmount: 227312, MiddleFanAmount: 38844, HeavyFanAmount: 21580, EvolutionLevel: 0 },
      { CardId: "card-mhk-05-poli-00", Position: 4, Level: 204, Rarity: 10, LightFanAmount: 227312, MiddleFanAmount: 38844, HeavyFanAmount: 21580, EvolutionLevel: 0 },
      { CardId: "card-mei-05-fest-00", Position: 5, Level: 204, Rarity: 10, LightFanAmount: 227312, MiddleFanAmount: 38844, HeavyFanAmount: 21580, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-825": {
    Name: "対戦アイドル",
    ManagerLevel: 295,
    Cards: [
      { CardId: "card-rei-05-fest-00", Position: 1, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
      { CardId: "card-ski-05-kifj-00", Position: 2, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
      { CardId: "card-aoi-05-idol-00", Position: 3, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
      { CardId: "card-suz-05-seik-00", Position: 4, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
      { CardId: "card-kkr-05-mizg-01", Position: 5, Level: 207, Rarity: 10, LightFanAmount: 231038, MiddleFanAmount: 39482, HeavyFanAmount: 21933, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-850": {
    Name: "対戦アイドル",
    ManagerLevel: 300,
    Cards: [
      { CardId: "card-kor-05-idol-03", Position: 1, Level: 209, Rarity: 10, LightFanAmount: 234765, MiddleFanAmount: 40118, HeavyFanAmount: 22287, EvolutionLevel: 0 },
      { CardId: "card-ktn-05-add-00", Position: 2, Level: 209, Rarity: 10, LightFanAmount: 234765, MiddleFanAmount: 40118, HeavyFanAmount: 22287, EvolutionLevel: 0 },
      { CardId: "card-ski-05-mizg-02", Position: 3, Level: 209, Rarity: 10, LightFanAmount: 234765, MiddleFanAmount: 40118, HeavyFanAmount: 22287, EvolutionLevel: 0 },
      { CardId: "card-szk-05-chna-00", Position: 4, Level: 209, Rarity: 10, LightFanAmount: 234765, MiddleFanAmount: 40118, HeavyFanAmount: 22287, EvolutionLevel: 0 },
      { CardId: "card-aoi-05-circ-00", Position: 5, Level: 209, Rarity: 10, LightFanAmount: 234765, MiddleFanAmount: 40118, HeavyFanAmount: 22287, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-875": {
    Name: "対戦アイドル",
    ManagerLevel: 305,
    Cards: [
      { CardId: "card-rio-05-fest-01", Position: 1, Level: 212, Rarity: 10, LightFanAmount: 238491, MiddleFanAmount: 40755, HeavyFanAmount: 22641, EvolutionLevel: 0 },
      { CardId: "card-rei-05-casl-02", Position: 2, Level: 212, Rarity: 10, LightFanAmount: 238491, MiddleFanAmount: 40755, HeavyFanAmount: 22641, EvolutionLevel: 0 },
      { CardId: "card-kan-05-chna-00", Position: 3, Level: 212, Rarity: 10, LightFanAmount: 238491, MiddleFanAmount: 40755, HeavyFanAmount: 22641, EvolutionLevel: 0 },
      { CardId: "card-chs-05-flow-00", Position: 4, Level: 212, Rarity: 10, LightFanAmount: 238491, MiddleFanAmount: 40755, HeavyFanAmount: 22641, EvolutionLevel: 0 },
      { CardId: "card-ktn-05-circ-00", Position: 5, Level: 212, Rarity: 10, LightFanAmount: 238491, MiddleFanAmount: 40755, HeavyFanAmount: 22641, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-900": {
    Name: "対戦アイドル",
    ManagerLevel: 310,
    Cards: [
      { CardId: "card-kkr-05-mizg-01", Position: 1, Level: 214, Rarity: 10, LightFanAmount: 242218, MiddleFanAmount: 41391, HeavyFanAmount: 22995, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-fest-02", Position: 2, Level: 214, Rarity: 10, LightFanAmount: 242218, MiddleFanAmount: 41391, HeavyFanAmount: 22995, EvolutionLevel: 0 },
      { CardId: "card-rio-05-wedd-00", Position: 3, Level: 214, Rarity: 10, LightFanAmount: 242218, MiddleFanAmount: 41391, HeavyFanAmount: 22995, EvolutionLevel: 0 },
      { CardId: "card-rei-05-chia-00", Position: 4, Level: 214, Rarity: 10, LightFanAmount: 242218, MiddleFanAmount: 41391, HeavyFanAmount: 22995, EvolutionLevel: 0 },
      { CardId: "card-suz-05-seik-00", Position: 5, Level: 214, Rarity: 10, LightFanAmount: 242218, MiddleFanAmount: 41391, HeavyFanAmount: 22995, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-925": {
    Name: "対戦アイドル",
    ManagerLevel: 315,
    Cards: [
      { CardId: "card-kor-05-nurs-00", Position: 1, Level: 217, Rarity: 10, LightFanAmount: 245944, MiddleFanAmount: 42028, HeavyFanAmount: 23349, EvolutionLevel: 0 },
      { CardId: "card-hrk-05-onep-00", Position: 2, Level: 217, Rarity: 10, LightFanAmount: 245944, MiddleFanAmount: 42028, HeavyFanAmount: 23349, EvolutionLevel: 0 },
      { CardId: "card-rei-05-fest-01", Position: 3, Level: 217, Rarity: 10, LightFanAmount: 245944, MiddleFanAmount: 42028, HeavyFanAmount: 23349, EvolutionLevel: 0 },
      { CardId: "card-ai-05-chna-01", Position: 4, Level: 217, Rarity: 10, LightFanAmount: 245944, MiddleFanAmount: 42028, HeavyFanAmount: 23349, EvolutionLevel: 0 },
      { CardId: "card-smr-05-maid-00", Position: 5, Level: 217, Rarity: 10, LightFanAmount: 245944, MiddleFanAmount: 42028, HeavyFanAmount: 23349, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-950": {
    Name: "対戦アイドル",
    ManagerLevel: 320,
    Cards: [
      { CardId: "card-hrk-05-pajm-00", Position: 1, Level: 219, Rarity: 10, LightFanAmount: 249671, MiddleFanAmount: 42665, HeavyFanAmount: 23702, EvolutionLevel: 0 },
      { CardId: "card-chs-05-maid-00", Position: 2, Level: 219, Rarity: 10, LightFanAmount: 249671, MiddleFanAmount: 42665, HeavyFanAmount: 23702, EvolutionLevel: 0 },
      { CardId: "card-ktn-05-poli-00", Position: 3, Level: 219, Rarity: 10, LightFanAmount: 249671, MiddleFanAmount: 42665, HeavyFanAmount: 23702, EvolutionLevel: 0 },
      { CardId: "card-kan-05-fest-02", Position: 4, Level: 219, Rarity: 10, LightFanAmount: 249671, MiddleFanAmount: 42665, HeavyFanAmount: 23702, EvolutionLevel: 0 },
      { CardId: "card-yu-05-chna-00", Position: 5, Level: 219, Rarity: 10, LightFanAmount: 249671, MiddleFanAmount: 42665, HeavyFanAmount: 23702, EvolutionLevel: 0 },
    ],
  },
  "qt-tower-975": {
    Name: "対戦アイドル",
    ManagerLevel: 325,
    Cards: [
      { CardId: "card-mna-05-msic-00", Position: 1, Level: 220, Rarity: 10, LightFanAmount: 253397, MiddleFanAmount: 43302, HeavyFanAmount: 24056, EvolutionLevel: 0 },
      { CardId: "card-skr-05-anml-00", Position: 2, Level: 220, Rarity: 10, LightFanAmount: 253397, MiddleFanAmount: 43302, HeavyFanAmount: 24056, EvolutionLevel: 0 },
      { CardId: "card-mhk-05-wedd-00", Position: 3, Level: 220, Rarity: 10, LightFanAmount: 253397, MiddleFanAmount: 43302, HeavyFanAmount: 24056, EvolutionLevel: 0 },
      { CardId: "card-ngs-05-fest-02", Position: 4, Level: 220, Rarity: 10, LightFanAmount: 253397, MiddleFanAmount: 43302, HeavyFanAmount: 24056, EvolutionLevel: 0 },
      { CardId: "card-rei-05-sail-00", Position: 5, Level: 220, Rarity: 10, LightFanAmount: 253397, MiddleFanAmount: 43302, HeavyFanAmount: 24056, EvolutionLevel: 0 },
    ],
  },
};
