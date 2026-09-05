export default class _SoundManager_WebAudio {
    constructor() {
        this.__actx = new AudioContext();
        // Master gain so every sound can be muted at once; mute state survives restarts.
        this.__masterGain = this.__actx.createGain();
        this.__masterGain.connect(this.__actx.destination);
        this.__sound_map = {};
        this.onLoad = (song_name, progress_percentage) => { };
        this.__progress = 0;
        this.loaded = false;
        this.muted = false;
        try { this.setMuted(localStorage.getItem("kitten-cannon-muted") === "1"); } catch (e) { }
    }

    setMuted(muted) {
        this.muted = !!muted;
        this.__masterGain.gain.value = this.muted ? 0 : 1;
        try { localStorage.setItem("kitten-cannon-muted", this.muted ? "1" : "0"); } catch (e) { }
    }

    toggleMuted() {
        this.setMuted(!this.muted);
        return this.muted;
    }
    addSound(sound_name, sound_url, volume = 1.0) {
        if (this.__sound_map[sound_name] != undefined) return this;
        this.__sound_map[sound_name] = {
            url: sound_url,
            audio_buffer: null, // audio buffer 
            source: this.__actx.createBufferSource(),
            vol: volume,
            play_count: 0,
            playing: false,
            start_time: 0,
        };
        return this;
    }

    async loadAll() {
        let proms = [];

        let sound_map_keys = Object.keys(this.__sound_map);
        let total_files = sound_map_keys.length;
        if (total_files == 0) return;
        sound_map_keys.forEach((sound_map_key) => {
            let sound_obj = this.__sound_map[sound_map_key];

            proms.push(new Promise((resolve, reject) => {
                fetch(sound_obj.url)
                    .then((res) => res.arrayBuffer())
                    .then(array_buffer => this.__actx.decodeAudioData(array_buffer))
                    .then(buffer => {
                        sound_obj.audio_buffer = buffer;
                        this.__progress++;
                        let percentage = (this.__progress / total_files) * 100;
                        this.onLoad(sound_map_key, percentage);
                        this.loaded = percentage >= 100;
                        resolve(sound_map_key);
                    })
                    .catch(err => { reject(err); });

            }));

        });

        await Promise.all(proms);
    }

    play(sound_name) {
        let sound_obj = this.__sound_map[sound_name];
        if (!sound_obj) return this;
        let buffer = sound_obj.audio_buffer;
        if (buffer == null) return this;

        this.__play(sound_obj);

        return sound_obj.source;
    }
    pause(sound_name) {
        let sound_obj = this.__sound_map[sound_name];
        if (!sound_obj) return this;
        let buffer = sound_obj.audio_buffer;
        if (buffer == null) return this;
        this.__pause(sound_obj);

        return sound_obj.source;
    }
    playOnce(sound_name) {
        let sound_obj = this.__sound_map[sound_name];
        if (!sound_obj) return this;
        let buffer = sound_obj.audio_buffer;
        if (buffer == null) return this;
        if (sound_obj.play_count > 0) return null;
        sound_obj.play_count++;


        this.__play(sound_obj);


        return sound_obj.source;
    }

    __play(sound_obj) {
        if (sound_obj.playing) {
            return;
        } else {
            sound_obj.source = this.__actx.createBufferSource();
            sound_obj.source.buffer = sound_obj.audio_buffer;
            sound_obj.source.connect(this.__masterGain);
            sound_obj.source.start();
            sound_obj.start_time = this.__actx.currentTime;
        }
        sound_obj.playing = true;
        sound_obj.source.addEventListener("ended", () => {
            sound_obj.playing = false;
        })
    }
    __pause(sound_obj) {
        sound_obj.source.connect(this.__masterGain);
        if (sound_obj.playing) {
            sound_obj.source.stop();
        }
        sound_obj.playing = false;
    }
    getCurrentTime(sound_name) {
        let sound_obj = this.__sound_map[sound_name];
        if (!sound_obj) return 0;

        return this.__actx.currentTime - sound_obj.start_time;
    }
}