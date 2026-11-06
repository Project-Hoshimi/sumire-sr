# もし恋 (MoshiKoi) route data

Route and catalog data ported from solis-server (https://github.com/vertesan/solis-server), AGPL-3.0.

The six event catalogs and six route maps were converted one-time from solis's
`internal/makino/moshikoi/catalogdata/*.yaml` and `routedata/*.yaml` to JSON so
the server needs no runtime YAML dependency. Field names and values are unchanged.
Choice indices are **1-based**, matching the wire protocol; the original
handwritten route maps number alternatives from zero.

In the route data, omitted fields keep their Go zero value: `best` is `0`
(unknown), and `scores`, `points`, `requires`, `all`, `outcomes`, `branches` are
empty, `next`/`ending` are empty strings. `minPoints`/`maxPoints` are only present
where solis uses a non-nil pointer.

## `catalog/<loveId>.json`

- `love-23-0514` — captured server-owned settings; end time is intentionally absent.
- `love-23-1114` — permanent Nagisa event. Entrance banner/groups follow the
  official round6 Home/Enter capture; start/unlock comes from mission conditions.
  The costume is used by `LoveHomeAction`; `Character.loveInfo` supplies the
  color. Unlock thresholds reuse the standard-series progression because master
  levels/episodes do not encode them.
- `love-24-0517` — permanent Mei event. Banner and mission groups follow
  `traffic/mixed/exercise/018-HomeEnterResponse.json`; start/unlock comes from the
  event's master conditions. Unlock thresholds reuse the standard progression.
- `love-24-1114` — permanent Yu event. Opening time and main-live gate come from
  `cd-date-event-mission-love-24-1114-normal`; the banner exists in the manifest.
  Unlock thresholds reuse the standard progression.
- `love-extra-25-0426` — permanent extra series. Metadata, heroine appearances,
  and level unlocks follow `traffic/mixed/love-extra` (TitleExtra012, Top013,
  HomeEnter009). The runtime event ID intentionally differs from its content/asset
  IDs. Successive responses select different heroines even on an unchanged route;
  the private-server policy is a uniform pick from the observed pool because the
  official weights are unknown. There is no present item in either master or
  captured `LoveItemInfo`.
- `love-26-0313` — permanent Rio event. Its master condition opens on March 18
  despite the March 13 series ID; the recorded timestamp is used rather than
  inferring from the ID. Unlock thresholds reuse the standard progression.

## `routes/<loveId>.json`

- `love-23-0514` — route connections come from `docs/love-23-0514-routemap.md`.
  Scores, condition branch indices, and first-ending bonuses are inferred from
  captured runs.
- `love-23-1114` — branches follow `docs/love-23-1114-routemap.md` and the
  `adv_love_2311` scripts. Favorability weights reuse the existing series' scale
  as a private-server approximation; no Nagisa response establishes the exact
  numeric awards. The TRUE end-roll follows the Rei asset convention.
- `love-24-0517` — branches follow `docs/love-24-0517-routemap.md` and the
  `adv_love_2405` scripts. Numeric favorability awards reuse the prior series'
  private-server scale; no Mei response establishes official weights. Both master
  Story rows play `love_2405_08_03`, so episode 7-bad is entered directly after
  episode 6, matching the map and story-count mission.
- `love-24-1114` — branches follow `docs/love-24-1114-routemap.md` and the
  `adv_love_2411` scripts. Favorability weights/ending awards reuse existing-series
  values as an approximation. Yu route points are separate from favorability and
  encoded by the four minimum point combinations in the file. The ending named
  `...003-bad` occurs in episode 4 despite its identifier. The legacy `004-bad`
  master row points to a missing script and is not part of the playable route.
- `love-extra-25-0426` — branches follow `docs/love-extra-25-0426-routemap.md`
  and the `adv_love_2505` scripts. The event, episode, and ending IDs intentionally
  have different prefixes, exactly as recorded in master data and traffic.
  Episode 1/4-Rui best choices are captured; +7 per best choice fits the observed
  49→63 delta and other weights are inferred. Endings have no permanent
  favorability award. Unlike the map, captured 026/027 sends unmatched Rui choices
  to her bad ending; that observed fallback was explicitly chosen over an unnamed
  reset.
- `love-26-0313` — branches and negative points follow
  `docs/love-26-0313-routemap.md` and the `adv_love_2603` scripts. Route points are
  separate from favorability; favorability weights/ending awards reuse the
  private-server scale and are not capture-verified. The TRUE end-roll association
  follows the established naming convention and is inferred.
