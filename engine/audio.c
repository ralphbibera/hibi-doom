/*
 * Copyright (C) 1993-1996 id Software, Inc.
 * Copyright (C) 2005-2014 Simon Howard.
 * Copyright (C) 2026 Ralph Bibera.
 *
 * Doom-derived portions retain their GNU GPL version 2 or later grant.
 * Hibi's direct sound backend uses GNU GPL version 3 only.
 * This program comes WITHOUT ANY WARRANTY. See ../LICENSE.
 */
#include <stdint.h>
#include <stdio.h>
#include "doomtype.h"
#include "i_sound.h"
#include "i_video.h"
#include "m_argv.h"
#include "m_config.h"
#include "w_wad.h"

#define HOST(name, result, args) \
    __attribute__((import_module("hibi"), import_name(#name))) \
    extern result host_##name args

HOST(sfx_start, int, (int channel, int lump, int volume, int separation));
HOST(sfx_stop, void, (int channel));
HOST(sfx_params, void, (int channel, int volume, int separation));
HOST(sfx_playing, int, (int channel));
HOST(music_register, int, (const void *data, int length));
HOST(music_unregister, void, (int handle));
HOST(music_play, void, (int handle, int looping));
HOST(music_stop, void, (void));
HOST(music_pause, void, (void));
HOST(music_resume, void, (void));
HOST(music_volume, void, (int volume));
HOST(music_playing, int, (void));

int snd_samplerate = 44100;
int snd_cachesize = 64 * 1024 * 1024;
int snd_maxslicetime_ms = 28;
char *snd_musiccmd = "";
int snd_musicdevice = SNDDEVICE_SB;
int snd_sfxdevice = SNDDEVICE_SB;
static int snd_sbport, snd_sbirq, snd_sbdma, snd_mport;
static boolean effects_enabled, music_enabled, prefix_enabled;

static int bounded(int value, int maximum)
{
    return value < 0 ? 0 : value > maximum ? maximum : value;
}

void I_InitSound(boolean use_sfx_prefix)
{
    boolean enabled = !screensaver_mode && !M_CheckParm("-nosound");
    effects_enabled = enabled && snd_sfxdevice != SNDDEVICE_NONE && !M_CheckParm("-nosfx");
    music_enabled = enabled && snd_musicdevice != SNDDEVICE_NONE && !M_CheckParm("-nomusic");
    prefix_enabled = use_sfx_prefix;
}

void I_ShutdownSound(void)
{
    for (int channel = 0; channel < 8; ++channel) host_sfx_stop(channel);
    host_music_stop();
    effects_enabled = music_enabled = false;
}

int I_GetSfxLumpNum(sfxinfo_t *sfx)
{
    char name[16];
    if (sfx->link) sfx = sfx->link;
    snprintf(name, sizeof(name), "%s%.8s", prefix_enabled ? "ds" : "", sfx->name);
    return W_GetNumForName(name);
}

void I_UpdateSound(void) {}

void I_UpdateSoundParams(int channel, int volume, int separation)
{
    if (effects_enabled) host_sfx_params(channel, bounded(volume, 127), bounded(separation, 254));
}

int I_StartSound(sfxinfo_t *sfx, int channel, int volume, int separation)
{
    if (!effects_enabled) return -1;
    return host_sfx_start(channel, I_GetSfxLumpNum(sfx), bounded(volume, 127), bounded(separation, 254));
}

void I_StopSound(int channel) { if (effects_enabled) host_sfx_stop(channel); }
boolean I_SoundIsPlaying(int channel) { return effects_enabled && host_sfx_playing(channel); }
void I_PrecacheSounds(sfxinfo_t *sounds, int count) { (void) sounds; (void) count; }
void I_InitMusic(void) {}
void I_ShutdownMusic(void) { host_music_stop(); }
void I_SetMusicVolume(int volume) { host_music_volume(bounded(volume, 127)); }
void I_PauseSong(void) { if (music_enabled) host_music_pause(); }
void I_ResumeSong(void) { if (music_enabled) host_music_resume(); }
void *I_RegisterSong(void *data, int length)
{
    return music_enabled ? (void *) (uintptr_t) host_music_register(data, length) : NULL;
}
void I_UnRegisterSong(void *handle) { if (handle) host_music_unregister((uintptr_t) handle); }
void I_PlaySong(void *handle, boolean looping) { if (handle) host_music_play((uintptr_t) handle, looping); }
void I_StopSong(void) { if (music_enabled) host_music_stop(); }
boolean I_MusicIsPlaying(void) { return music_enabled && host_music_playing(); }

void I_BindSoundVariables(void)
{
    M_BindVariable("snd_musicdevice", &snd_musicdevice);
    M_BindVariable("snd_sfxdevice", &snd_sfxdevice);
    M_BindVariable("snd_sbport", &snd_sbport);
    M_BindVariable("snd_sbirq", &snd_sbirq);
    M_BindVariable("snd_sbdma", &snd_sbdma);
    M_BindVariable("snd_mport", &snd_mport);
    M_BindVariable("snd_maxslicetime_ms", &snd_maxslicetime_ms);
    M_BindVariable("snd_musiccmd", &snd_musiccmd);
    M_BindVariable("snd_samplerate", &snd_samplerate);
    M_BindVariable("snd_cachesize", &snd_cachesize);
}
