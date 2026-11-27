// Local types of the combat folder (gaps of shared/types.ts are listed in the migration report).
import type { Actor } from '../../../shared/types.ts';

/**
 * Anything shaped like an actor sheet: a PC / spawned NPC, a bestiary template, the template editor's draft, the
 * chargen preview or an enemy generator preview. Every field may be missing.
 */
export type ActorLike = Partial<Actor> & { folder?: string; description?: string; tags?: string[]; unitName?: string };
