// Core actions: chat, whispers, settings, player management, pings.
export default {
  name: 'core',

  init(state) {
    state.sessions = state.sessions || {};
    state.users = state.users || {};
    state.log = state.log || [];
    state.ui = state.ui || { announcement: null }; // GM banner shown to everyone
  },

  actions: {
    // payload: { text, to?: userId[] (whisper), as?: actorId (speak as character/NPC, GM or owner) }
    'chat/send': {
      role: 'any',
      handler(ctx, { text, to, as }) {
        const clean = String(text || '').trim().slice(0, 2000);
        if (!clean) ctx.fail('Message vide');
        let author = ctx.displayName();
        if (as && ctx.state.actors[as] && ctx.owns(as)) author = ctx.state.actors[as].name;
        const whisper = Array.isArray(to) && to.length ? [...new Set([...to, 'gm'])] : undefined;
        ctx.log({ kind: whisper ? 'whisper' : 'chat', userId: ctx.user.id, author, text: clean, to: whisper });
      },
    },
    'log/clear': {
      role: 'gm',
      handler(ctx) {
        ctx.state.log = [];
      },
    },
    'log/delete': {
      role: 'gm',
      handler(ctx, { id }) {
        ctx.state.log = ctx.state.log.filter((e) => e.id !== id);
      },
    },
    // payload: { campaignName?, gmPassword? }
    'config/update': {
      role: 'gm',
      handler(ctx, { campaignName, gmPassword }) {
        if (campaignName) ctx.state.config.campaignName = String(campaignName).slice(0, 80);
        if (gmPassword) ctx.state.config.gmPassword = String(gmPassword).slice(0, 80);
      },
    },
    // GM: give or remove a character from a player. payload: { userId, characterId, assign: bool }
    'users/assign': {
      role: 'gm',
      handler(ctx, { userId, characterId, assign }) {
        const u = ctx.state.users[userId];
        if (!u) ctx.fail('Joueur introuvable');
        u.characterIds = (u.characterIds || []).filter((id) => id !== characterId);
        if (assign) {
          for (const other of Object.values(ctx.state.users)) other.characterIds = (other.characterIds || []).filter((id) => id !== characterId);
          u.characterIds.push(characterId);
        }
      },
    },
    'users/remove': {
      role: 'gm',
      handler(ctx, { userId }) {
        delete ctx.state.users[userId];
        for (const [tok, id] of Object.entries(ctx.state.sessions)) if (id === userId) delete ctx.state.sessions[tok];
      },
    },
    'users/resetPin': {
      role: 'gm',
      handler(ctx, { userId }) {
        if (ctx.state.users[userId]) ctx.state.users[userId].pin = null;
      },
    },
    // Banner text shown on every screen (null to clear).
    'ui/announce': {
      role: 'gm',
      handler(ctx, { text }) {
        ctx.state.ui.announcement = text ? String(text).slice(0, 500) : null;
      },
    },
    // Transient "look here" ping on the map. payload: { mapId, x, y } (cell coords, may be fractional)
    'ui/ping': {
      role: 'any',
      handler(ctx, { mapId, x, y }) {
        ctx.emitTo('all', 'ping', { mapId, x, y, userId: ctx.user.id, name: ctx.displayName() });
      },
    },
  },
};
