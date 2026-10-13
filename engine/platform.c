/*
 * Copyright (C) 2026 Ralph Bibera.
 * SPDX-License-Identifier: GPL-3.0-only
 * This program comes WITHOUT ANY WARRANTY. See ../LICENSE.
 * Hibi platform adapter written 2026-10-13.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include "doomgeneric.h"
#include "doomkeys.h"
#include "doomstat.h"
#include "i_system.h"
#include "m_argv.h"
#include "m_controls.h"
#include "net_client.h"
#include "d_event.h"

extern void D_DoomMain(void);

boolean net_client_connected = false;
boolean drone = false;

__attribute__((import_module("hibi"), import_name("clock_ms")))
extern uint32_t host_clock_ms(void);
__attribute__((import_module("hibi"), import_name("sleep_ms")))
extern void host_sleep_ms(uint32_t ms);
__attribute__((import_module("hibi"), import_name("draw_indexed")))
extern void host_draw_indexed(const unsigned char *indices,
                              const unsigned char *palette_rgb);

static uint16_t keys[64];
static unsigned int key_read, key_write, key_count;
static int snapshot[16];
static int pending_mouse;
extern int mousex, mousey;

int doom_mouse(int delta)
{
    if (delta < -2048 || delta > 2048) return -1;
    pending_mouse += delta;
    if (pending_mouse > 2048) pending_mouse = 2048;
    else if (pending_mouse < -2048) pending_mouse = -2048;
    return 0;
}

void doom_mouse_reset(void)
{
    pending_mouse = mousex = mousey = 0;
}

void DG_PollMouse(void)
{
    if (!pending_mouse) return;
    event_t event = { ev_mouse, 0, pending_mouse, 0, 0 };
    pending_mouse = 0;
    D_PostEvent(&event);
}

int system(const char *command)
{
    (void) command;
    errno = ENOSYS;
    return -1;
}

void DG_Init(void) {}
void DG_SetWindowTitle(const char *title) { (void) title; }
uint32_t DG_GetTicksMs(void) { return host_clock_ms(); }
void DG_SleepMs(uint32_t ms) { host_sleep_ms(ms); }

void DG_DrawIndexedFrame(const unsigned char *indices,
                        const unsigned char *palette_rgb)
{
    host_draw_indexed(indices, palette_rgb);
}

int DG_GetKey(int *pressed, unsigned char *key)
{
    if (!key_count) return 0;
    uint16_t event = keys[key_read];
    key_read = (key_read + 1) % 64;
    key_count--;
    *pressed = event >> 8;
    *key = event & 255;
    return 1;
}

int doom_key(int pressed, unsigned int key)
{
    if ((pressed != 0 && pressed != 1) || key > 255 || key_count == 64)
        return -1;
    keys[key_write] = (pressed << 8) | key;
    key_write = (key_write + 1) % 64;
    key_count++;
    return 0;
}

void doom_init(void)
{
    static char *args[] = { "hibi-doom", "-iwad", "doom1.wad", "-mb", "8",
                            "-nojoy" };
    puts("Hibi Doom engine. Copyright id Software, Simon Howard, and contributors.");
    puts("GNU GPL version 3 only. ABSOLUTELY NO WARRANTY.");
    puts("Redistribution permitted under GPL. License and complete source accompany this engine.");
    myargc = sizeof(args) / sizeof(args[0]);
    myargv = args;
    DG_Init();
    D_DoomMain();
    key_fire = KEY_RCTRL;
    key_use = ' ';
    key_strafeleft = ',';
    key_straferight = '.';
}

void doom_tick(void) { doomgeneric_Tick(); }

int *doom_snapshot(void)
{
    player_t *p = &players[consoleplayer];
    snapshot[0] = gamestate;
    snapshot[1] = gameepisode;
    snapshot[2] = gamemap;
    snapshot[3] = gametic;
    snapshot[4] = p->mo ? p->mo->x : 0;
    snapshot[5] = p->mo ? p->mo->y : 0;
    snapshot[6] = p->mo ? p->mo->angle : 0;
    snapshot[7] = p->ammo[am_clip];
    snapshot[8] = p->health;
    snapshot[9] = p->readyweapon;
    snapshot[10] = p->attackdown;
    snapshot[11] = menuactive;
    snapshot[12] = demoplayback;
    snapshot[13] = leveltime;
    snapshot[14] = key_count;
    snapshot[15] = 0;
    return snapshot;
}
