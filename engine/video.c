/*
 * Copyright (C) 1993-1996 by id Software, Inc.
 * Copyright (C) 2026 Ralph Bibera.
 *
 * The Doom-derived portions retain their GNU GPL version 2 or later grant.
 * Hibi changes are licensed under GNU GPL version 3 only.
 * This program comes WITHOUT ANY WARRANTY. See ../LICENSE.
 *
 * Indexed host adapter derived from the pinned Doom Generic i_video.c.
 */
#include "config.h"
#include "v_video.h"
#include "d_event.h"
#include "d_main.h"
#include "i_video.h"
#include "i_system.h"
#include "z_zone.h"
#include "tables.h"
#include "doomgeneric.h"

byte *I_VideoBuffer = NULL;
boolean screensaver_mode = false;
boolean screenvisible;
int usemouse = 1;
int usegamma = 0;
float mouse_acceleration = 2.0;
int mouse_threshold = 10;

static byte palette_rgb[256 * 3];

extern void I_GetEvent(void);
extern void I_InitInput(void);

void I_InitGraphics(void)
{
    I_VideoBuffer = Z_Malloc(SCREENWIDTH * SCREENHEIGHT, PU_STATIC, NULL);
    screenvisible = true;
    I_InitInput();
}

void I_ShutdownGraphics(void) { Z_Free(I_VideoBuffer); }
void I_StartFrame(void) {}
void I_StartTic(void)
{
    I_GetEvent();
    DG_PollMouse();
}
void I_UpdateNoBlit(void) {}

void I_FinishUpdate(void)
{
    DG_DrawIndexedFrame(I_VideoBuffer, palette_rgb);
}

void I_ReadScreen(byte *screen)
{
    memcpy(screen, I_VideoBuffer, SCREENWIDTH * SCREENHEIGHT);
}

void I_SetPalette(byte *palette)
{
    for (int i = 0; i < 256 * 3; ++i)
        palette_rgb[i] = gammatable[usegamma][palette[i]];
}

/* The pinned RGB565 lookup table is never populated and returns index zero. */
int I_GetPaletteIndex(int r, int g, int b)
{
    (void) r;
    (void) g;
    (void) b;
    return 0;
}

void I_BeginRead(void) {}
void I_EndRead(void) {}
void I_SetWindowTitle(char *title) { DG_SetWindowTitle(title); }
void I_GraphicsCheckCommandLine(void) {}
void I_SetGrabMouseCallback(grabmouse_callback_t callback) { (void) callback; }
void I_EnableLoadingDisk(void) {}
void I_BindVideoVariables(void) {}
void I_DisplayFPSDots(boolean dots) { (void) dots; }
void I_CheckIsScreensaver(void) {}
