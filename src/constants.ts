import type { ChatPermissions } from 'grammy/types';

/** Chance that a normal hit is upgraded to an ultra hit. */
export const ULTRA_HIT_CHANCE = 0.01;
export const ULTRA_CHARGE_STEPS = [0, 20, 40, 60, 80, 100] as const;
export const ULTRA_CHARGE_STEP_DELAY_MS = 650;

/** Chance that a `lef` command answers with a photo instead of the animation. */
export const LEF_IMAGE_CHANCE = 0.1;
export const LEF_ANIMATION_DELAY_MS = 1_000;

/** Escalating mute lengths (minutes) for repeat non-admin abusers. */
export const NON_ADMIN_MUTE_ESCALATION_MINUTES = [3, 5, 10, 15, 30] as const;

export const ADMIN_CACHE_TTL_MS = 60_000;
/** Abuse counter resets after this much silence. */
export const MODERATION_ABUSE_WINDOW_MS = 30 * 60 * 1_000;
/** Telegram caps mutes at 30 days. */
export const MAX_MUTE_MINUTES = 43_200;

/** Telegram only allows ordinary message deletion during the first 48 hours. */
export const MESSAGE_DELETE_WINDOW_SECONDS = 48 * 60 * 60;
/** Bound per-user message history kept only for ban cleanup. */
export const MAX_RECENT_MESSAGES_PER_USER = 1_000;

/** Full lockdown permissions applied on mute. */
export const MUTE_PERMISSIONS: ChatPermissions = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
  can_manage_topics: false,
};
