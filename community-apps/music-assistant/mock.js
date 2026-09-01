'use strict';

// Demo-data client: identical surface to MAClient.create() so app.js and
// library.js carry no mock branches beyond the constructor pick.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MAMock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ARTISTS = ['Led Zeppelin', 'The Beach Boys', 'Prince', 'Janis Joplin', 'Steely Dan', 'Black Sabbath',
    'Fleetwood Mac', 'Pink Floyd', 'Queen', 'David Bowie', 'The Who', 'Aretha Franklin'];
  const ALBUMS = [['Physical Graffiti', 'Led Zeppelin'], ['Pet Sounds', 'The Beach Boys'], ['Purple Rain', 'Prince'],
    ['Pearl', 'Janis Joplin'], ['Pretzel Logic', 'Steely Dan'], ['Paranoid', 'Black Sabbath'],
    ['Rumours', 'Fleetwood Mac'], ['Wish You Were Here', 'Pink Floyd'], ['A Night at the Opera', 'Queen'],
    ['Hunky Dory', 'David Bowie'], ['Quadrophenia', 'The Who'], ['Lady Soul', 'Aretha Franklin']];
  const TRACKS = [['Ten Years Gone', 'Led Zeppelin', 392], ['Kashmir', 'Led Zeppelin', 508],
    ['In My Time of Dying', 'Led Zeppelin', 664], ['Houses of the Holy', 'Led Zeppelin', 242],
    ['Trampled Under Foot', 'Led Zeppelin', 337], ['God Only Knows', 'The Beach Boys', 173],
    ['When Doves Cry', 'Prince', 352], ['Me and Bobby McGee', 'Janis Joplin', 269],
    ['Rikki Don’t Lose That Number', 'Steely Dan', 270], ['War Pigs', 'Black Sabbath', 478],
    ['Dreams', 'Fleetwood Mac', 257], ['Shine On You Crazy Diamond', 'Pink Floyd', 811],
    ['Bohemian Rhapsody', 'Queen', 355], ['Life on Mars?', 'David Bowie', 236]];

  function mediaTrack(i) {
    const t = TRACKS[i % TRACKS.length];
    const album = ALBUMS.find(a => a[1] === t[1]);
    return {
      media_type: 'track', item_id: 'trk' + i, provider: 'library', uri: 'library://track/' + i,
      name: t[0], duration: t[2], artists: [{ name: t[1] }], album: album ? { name: album[0] } : undefined,
      favorite: i % 5 === 0, metadata: {},
    };
  }

  function create(opts) {
    opts = opts || {};
    const preset = opts.mockState || 'playing';
    const subs = [];
    const client = { status: 'idle', serverInfo: { server_version: 'demo', schema_version: 30 }, connect, close, request, on };
    let timer = null;

    const players = [
      { player_id: 'living', display_name: 'Living Room', available: true, powered: true, volume_level: 62, volume_muted: false, group_childs: [] },
      { player_id: 'kitchen', display_name: 'Kitchen', available: true, powered: true, volume_level: 35, volume_muted: false, group_childs: [] },
      { player_id: 'office', display_name: 'Office', available: true, powered: false, volume_level: 20, volume_muted: false, group_childs: [] },
    ];
    const queueItems = TRACKS.slice(0, 12).map((t, i) => ({
      queue_item_id: 'qi' + i, name: t[0] + ' - ' + t[1], duration: t[2], media_item: mediaTrack(i),
    }));
    const queues = [
      { queue_id: 'living', display_name: 'Living Room', active: true, state: 'playing', shuffle_enabled: false,
        repeat_mode: 'all', dont_stop_the_music_enabled: true, current_index: 1, elapsed_time: 192,
        items: queueItems.length, current_item: queueItems[1] },
      { queue_id: 'kitchen', display_name: 'Kitchen', active: false, state: 'idle', shuffle_enabled: false,
        repeat_mode: 'off', dont_stop_the_music_enabled: false, current_index: 0, elapsed_time: 0, items: 0, current_item: null },
      { queue_id: 'office', display_name: 'Office', active: false, state: 'idle', shuffle_enabled: false,
        repeat_mode: 'off', dont_stop_the_music_enabled: false, current_index: 0, elapsed_time: 0, items: 0, current_item: null },
    ];
    if (preset === 'paused') queues[0].state = 'paused';
    if (preset === 'idle' || preset === 'stopped') {
      queues[0].state = 'idle'; queues[0].current_item = null; queues[0].items = 0; queueItems.length = 0;
    }

    function setStatus(status, detail) {
      client.status = status;
      if (typeof opts.onStatus === 'function') { try { opts.onStatus(status, detail); } catch (e) {} }
    }

    function emit(event, objectId, data) {
      const msg = { event, object_id: objectId, data };
      for (const sub of subs.slice()) {
        if (sub.e !== '*' && sub.e !== event) continue;
        if (sub.o !== '*' && objectId && sub.o !== objectId) continue;
        try { sub.h(msg); } catch (e) {}
      }
    }

    function on(eventType, objectId, handler) {
      const sub = { e: eventType || '*', o: objectId || '*', h: handler };
      subs.push(sub);
      return function () { const i = subs.indexOf(sub); if (i >= 0) subs.splice(i, 1); };
    }

    function queue() { return queues[0]; }

    function tick() {
      if (queue().state !== 'playing' || !queue().current_item) return;
      queue().elapsed_time += 1;
      const dur = queue().current_item.duration || 0;
      if (dur && queue().elapsed_time >= dur) { queue().elapsed_time = 0; nextTrack(1); return; }
      emit('queue_time_updated', queue().queue_id, queue().elapsed_time);
    }

    function nextTrack(step) {
      const q = queue();
      if (!queueItems.length) return;
      q.current_index = (q.current_index + step + queueItems.length) % queueItems.length;
      q.current_item = queueItems[q.current_index];
      q.elapsed_time = 0;
      emit('queue_updated', q.queue_id, q);
    }

    function playerById(id) { return players.find(p => p.player_id === id); }

    function handle(command, args) {
      args = args || {};
      const q = queue();
      switch (command) {
        case 'players/all': return players;
        case 'player_queues/all': return queues;
        case 'player_queues/get_active_queue': return queues.find(x => x.queue_id === args.player_id) || q;
        case 'player_queues/items': return queueItems.slice(args.offset || 0, (args.offset || 0) + (args.limit || 500));
        case 'player_queues/play_pause':
          q.state = q.state === 'playing' ? 'paused' : 'playing';
          emit('queue_updated', q.queue_id, q); return null;
        case 'player_queues/play': case 'player_queues/resume':
          q.state = 'playing'; emit('queue_updated', q.queue_id, q); return null;
        case 'player_queues/pause': q.state = 'paused'; emit('queue_updated', q.queue_id, q); return null;
        case 'player_queues/stop': q.state = 'idle'; emit('queue_updated', q.queue_id, q); return null;
        case 'player_queues/next': nextTrack(1); return null;
        case 'player_queues/previous': nextTrack(-1); return null;
        case 'player_queues/seek': q.elapsed_time = Number(args.position) || 0; emit('queue_updated', q.queue_id, q); return null;
        case 'player_queues/play_index': {
          const i = queueItems.findIndex(x => x.queue_item_id === args.index || queueItems.indexOf(x) === args.index);
          q.current_index = i >= 0 ? i : 0; q.current_item = queueItems[q.current_index]; q.elapsed_time = 0; q.state = 'playing';
          emit('queue_updated', q.queue_id, q); return null;
        }
        case 'player_queues/delete_item': {
          const i = queueItems.findIndex(x => x.queue_item_id === args.item_id_or_index);
          if (i >= 0) queueItems.splice(i, 1);
          q.items = queueItems.length;
          emit('queue_items_updated', q.queue_id, q); return null;
        }
        case 'player_queues/move_item': {
          const i = queueItems.findIndex(x => x.queue_item_id === args.queue_item_id);
          const j = i + (Number(args.pos_shift) || 1);
          if (i >= 0 && j >= 0 && j < queueItems.length) queueItems.splice(j, 0, queueItems.splice(i, 1)[0]);
          emit('queue_items_updated', q.queue_id, q); return null;
        }
        case 'player_queues/move_item_end': {
          const i = queueItems.findIndex(x => x.queue_item_id === args.queue_item_id);
          if (i >= 0) queueItems.push(queueItems.splice(i, 1)[0]);
          emit('queue_items_updated', q.queue_id, q); return null;
        }
        case 'player_queues/clear':
          queueItems.length = 0; q.items = 0; q.current_item = null; q.state = 'idle';
          emit('queue_updated', q.queue_id, q); emit('queue_items_updated', q.queue_id, q); return null;
        case 'player_queues/shuffle': q.shuffle_enabled = !!args.shuffle_enabled; emit('queue_updated', q.queue_id, q); return null;
        case 'player_queues/repeat': q.repeat_mode = args.repeat_mode || 'off'; emit('queue_updated', q.queue_id, q); return null;
        case 'player_queues/dont_stop_the_music':
          q.dont_stop_the_music_enabled = !!args.dont_stop_the_music_enabled; emit('queue_updated', q.queue_id, q); return null;
        case 'player_queues/transfer': return null;
        case 'player_queues/save_as_playlist': return null;
        case 'player_queues/play_media': {
          const item = { queue_item_id: 'qi' + Date.now(), name: 'Added item', duration: 240, media_item: mediaTrack(3) };
          if (args.option === 'replace' || args.option === 'play') { queueItems.length = 0; }
          queueItems.push(item);
          q.items = queueItems.length;
          if (args.option === 'play' || args.option === 'replace' || !q.current_item) {
            q.current_index = 0; q.current_item = queueItems[0]; q.state = 'playing'; q.elapsed_time = 0;
          }
          emit('queue_updated', q.queue_id, q); emit('queue_items_updated', q.queue_id, q); return null;
        }
        case 'players/add_currently_playing_to_favorites': return null;
        case 'music/search': {
          const needle = String(args.search_query || '').toLowerCase();
          const tracks = TRACKS.filter(t => (t[0] + ' ' + t[1]).toLowerCase().includes(needle));
          return {
            tracks: tracks.slice(0, 8).map((t, i) => mediaTrack(TRACKS.indexOf(t))),
            artists: ARTISTS.filter(a => a.toLowerCase().includes(needle)).slice(0, 5)
              .map((a, i) => ({ media_type: 'artist', item_id: 'a' + i, provider: 'library', uri: 'library://artist/' + i, name: a, metadata: {} })),
            albums: ALBUMS.filter(a => (a[0] + ' ' + a[1]).toLowerCase().includes(needle)).slice(0, 5)
              .map((a, i) => ({ media_type: 'album', item_id: 'al' + i, provider: 'library', uri: 'library://album/' + i, name: a[0], artists: [{ name: a[1] }], metadata: {} })),
            playlists: [], radio: [],
          };
        }
        case 'music/recently_played_items':
          return TRACKS.slice(0, args.limit || 10).map((t, i) => mediaTrack(i));
        case 'music/recommendations':
          return [
            { item_id: 'rec1', name: 'Top Picks for You', provider: 'library', enabled_by_default: true, items: [] },
            { item_id: 'rec2', name: 'Mixes For You', provider: 'plex', enabled_by_default: true, items: [] },
            { item_id: 'rec3', name: 'New Albums', provider: 'library', enabled_by_default: true, items: [] },
          ];
        case 'music/recommendations/items':
          return ALBUMS.slice(0, 8).map((a, i) => ({ media_type: 'album', item_id: 'al' + i, provider: 'library', uri: 'library://album/' + i, name: a[0], artists: [{ name: a[1] }], metadata: {} }));
        case 'music/favorites/add_item': case 'music/favorites/remove_item': return null;
        default: {
          const m = /^music\/(artists|albums|tracks|playlists|radios)\/library_items$/.exec(command);
          if (m) {
            const type = m[1];
            const offset = args.offset || 0;
            let all;
            if (type === 'artists') all = ARTISTS.map((a, i) => ({ media_type: 'artist', item_id: 'a' + i, provider: 'library', uri: 'library://artist/' + i, name: a, sort_name: a.replace(/^the /i, ''), metadata: {} }));
            else if (type === 'albums') all = ALBUMS.map((a, i) => ({ media_type: 'album', item_id: 'al' + i, provider: 'library', uri: 'library://album/' + i, name: a[0], sort_name: a[0], artists: [{ name: a[1] }], metadata: {} }));
            else if (type === 'tracks') all = TRACKS.map((t, i) => mediaTrack(i));
            else all = [];
            all.sort((x, y) => String(x.sort_name || x.name).localeCompare(String(y.sort_name || y.name)));
            return all.slice(offset, offset + (args.limit || 500));
          }
          if (/^music\/(artists|albums|playlists)\//.test(command)) return TRACKS.slice(0, 8).map((t, i) => mediaTrack(i));
          if (/^players\/cmd\//.test(command)) {
            const p = playerById(args.player_id) || players[0];
            const cmd = command.slice('players/cmd/'.length);
            if (cmd === 'volume_set') p.volume_level = Number(args.volume_level) || 0;
            if (cmd === 'volume_up') p.volume_level = Math.min(100, p.volume_level + 2);
            if (cmd === 'volume_down') p.volume_level = Math.max(0, p.volume_level - 2);
            if (cmd === 'volume_mute') p.volume_muted = !!args.muted;
            if (cmd === 'power') p.powered = !!args.powered;
            if (cmd === 'group') {
              const base = playerById(args.target_player) || players[0];
              if (!base.group_childs.includes(p.player_id)) base.group_childs.push(p.player_id);
              emit('player_updated', base.player_id, base);
            }
            if (cmd === 'ungroup') {
              players.forEach(b => { b.group_childs = b.group_childs.filter(id => id !== p.player_id); emit('player_updated', b.player_id, b); });
            }
            if (cmd === 'group_volume') p.volume_level = Number(args.volume_level) || p.volume_level;
            emit('player_updated', p.player_id, p);
            return null;
          }
          const err = new Error('unknown command');
          err.error_code = 400;
          throw err;
        }
      }
    }

    function request(command, args) {
      if (client.status !== 'ready') return Promise.reject(new Error('not connected'));
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          try { resolve(handle(command, args)); } catch (e) { reject(e); }
        }, 30);
      });
    }

    function connect() {
      setStatus('connecting');
      setTimeout(() => {
        if (preset === 'auth-failed') { setStatus('auth-failed', 'Invalid token (demo)'); return; }
        if (preset === 'unreachable') { setStatus('reconnecting'); return; }
        if (preset === 'setup') { setStatus('setup-required', 'Setup required (demo)'); return; }
        setStatus('ready');
        emit('connected');
        clearInterval(timer);
        timer = setInterval(tick, 1000);
      }, 300);
    }

    function close() { clearInterval(timer); setStatus('idle'); }

    return client;
  }

  return { create };
});
