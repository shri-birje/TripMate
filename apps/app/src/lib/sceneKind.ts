export type SceneKind = 'mountain' | 'hills' | 'coast' | 'desert' | 'lake' | 'forest';
export const SCENE_KINDS: readonly SceneKind[] = ['mountain', 'hills', 'coast', 'desert', 'lake', 'forest'];

/**
 * Picks a destination illustration for a trip. TripMate stores no artwork per trip, so the scene is chosen from the
 * destination/name words (beach, hill, lake, desert ...) and otherwise from a stable hash of the trip id, so a given
 * trip always shows the same picture. Nothing is invented about the trip: it is only a picture.
 */
export function sceneFor(seed: string, hint = ''): SceneKind {
  const t = hint.toLowerCase();
  if (/\b(beach|coast|goa|gokarna|island|bay|sea|ocean|marina|kovalam|varkala)\b/.test(t)) return 'coast';
  if (/\b(lake|river|backwater|dal|pangong|pond|falls)\b/.test(t)) return 'lake';
  if (/\b(desert|dune|jaisalmer|rann|hampi|sand)\b/.test(t)) return 'desert';
  if (/\b(forest|jungle|wildlife|park|safari|trek|camp)\b/.test(t)) return 'forest';
  if (/\b(coorg|estate|munnar|ooty|plantation|tea|coffee|hill|hills)\b/.test(t)) return 'hills';
  if (/\b(mount|mountain|himalaya|peak|spiti|ladakh|valley|manali|snow|pass)\b/.test(t)) return 'mountain';
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return SCENE_KINDS[h % SCENE_KINDS.length]!;
}

