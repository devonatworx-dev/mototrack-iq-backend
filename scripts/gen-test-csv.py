#!/usr/bin/env python3
"""Generate a realistic RaceBox-style CSV: 5 laps around a small GPS loop with a
start/finish gate, ~10Hz, so the analyzer's GPS lap detection fires."""
import math, sys

# Simple oval near Calabogie-ish coords. Start/finish at the first point.
CX, CY = 45.2350, -76.8200
RX, RY = 0.0060, 0.0035  # deg radii (~600m x ~350m box)
HZ = 10
LAP_SECONDS = [168, 166, 165, 167, 164]  # 5 laps, varying
BASE_SPEED = 120  # km/h cruise

header = "Record,Time,Latitude,Longitude,Altitude,Speed,GForceX,GForceZ,Lap,LeanAngle,GyroX,GyroY,GyroZ"
rows = [header]

rec = 0
t = 0.0
for lap_idx, lap_len in enumerate(LAP_SECONDS):
    n = lap_len * HZ
    for i in range(n):
        frac = i / n
        ang = frac * 2 * math.pi
        lat = CY + RY * math.sin(ang)
        lon = CX + RX * math.cos(ang)
        # speed dips at "corners" (top/bottom of oval)
        corner = abs(math.sin(ang * 2))
        speed = BASE_SPEED + 60 * (1 - corner) - 30 * corner
        lean = 45 * math.cos(ang * 2)
        gx = round(1.2 * math.sin(ang * 2), 2)
        gz = round(0.9 * math.cos(ang * 2), 2)
        # ISO-ish time
        ms = int(t * 1000)
        hh = 14 + ms // 3600000
        mm = (ms // 60000) % 60
        ss = (ms // 1000) % 60
        milli = ms % 1000
        tstr = f"2026-06-28T{hh:02d}:{mm:02d}:{ss:02d}.{milli:03d}Z"
        rows.append(f"{rec},{tstr},{lat:.6f},{lon:.6f},220.0,{speed:.1f},{gx},{gz},{lap_idx+1},{lean:.1f},0,0,0")
        rec += 1
        t += 1.0 / HZ

sys.stdout.write("\n".join(rows) + "\n")
