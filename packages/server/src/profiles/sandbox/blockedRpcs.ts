/**
 * RPCs the sandbox refuses even though a handler (often a replay) exists, so
 * the client shows the "Not implemented" dialog and returns home instead of
 * opening a screen the sandbox does not support: the entry calls of the
 * unimplemented home-screen buttons and the accessory screens.
 */
export const SANDBOX_BLOCKED_RPCS: ReadonlySet<string> = new Set([
  // Entry call of the home LIVE page (quests, contests, PvP, towers...).
  'Quest:Top',
  // Entry call of the home Shop page.
  'Shop:List',
  // Home Roulette button.
  'Roulette:Top',
  // Home Login Bonus button.
  'LoginBonus:List',
  // Home Task (missions) button.
  'Mission:List',
  // Home VENUS UNION (guild) button.
  'Guild:Top',
  'Guild:List',
  // Home Manager Training button.
  'Exercise:Top',
  // Home Invite Code button.
  'Invite:Top',
  // Home Exchange button.
  'Exchange:List',
  // Accessory screens (accessories are removed from the sandbox inventory).
  'Accessory:Enhance',
  'Accessory:LimitBreak',
  'Accessory:Sell',
  // Lv Assist.
  'Card:SetSupport',
  // Renewal.
  'Card:Reset',
  // Showcase goods shop (sandbox players own every toy) and the gallery.
  'Shop:ListItem',
  'Shop:Purchase',
  'Showcase:GalleryTop',
]);
