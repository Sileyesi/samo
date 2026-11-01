#!/usr/bin/env bash
# Screenshot only the Samo browser window (niri + grim). Usage: scripts/shot.sh out.png
out=${1:-shot.png}
geom=$(python3 - <<'PY'
import json, subprocess
q = lambda *a: json.loads(subprocess.check_output(["niri", "msg", "--json", *a]))
outs, wss = q("outputs"), {w["id"]: w for w in q("workspaces")}
pids = set(int(p) for p in subprocess.check_output(["pgrep", "-x", "samo"]).split())
for w in q("windows"):
    L = w["layout"]
    if w.get("pid") in pids and L.get("tile_pos_in_workspace_view"):
        o = outs[wss[w["workspace_id"]]["output"]]["logical"]
        x = o["x"] + L["tile_pos_in_workspace_view"][0] + L["window_offset_in_tile"][0]
        y = o["y"] + L["tile_pos_in_workspace_view"][1] + L["window_offset_in_tile"][1]
        print(f"{int(x)},{int(y)} {L['window_size'][0]}x{L['window_size'][1]}")
        break
PY
)
[ -z "$geom" ] && { echo "samo window not visible"; exit 1; }
grim -g "$geom" "$out" && echo "$out ($geom)"
