/*
 * Copyright (C) 2026 Ralph Bibera.
 * SPDX-License-Identifier: GPL-3.0-only
 * Hibi framebuffer interface written 2026-10-13.
 */
#ifndef HIBI_DOOM_FRAMEBUFFER_H
#define HIBI_DOOM_FRAMEBUFFER_H

#include <stdint.h>

#define DOOMGENERIC_RESX 640
#define DOOMGENERIC_RESY 400

extern uint32_t *DG_ScreenBuffer;

void DG_Init(void);
void DG_DrawFrame(void);
uint32_t DG_GetTicksMs(void);
void DG_SleepMs(uint32_t ms);
int DG_GetKey(int *pressed, unsigned char *key);
void DG_SetWindowTitle(const char *title);
void doomgeneric_Tick(void);

#endif
