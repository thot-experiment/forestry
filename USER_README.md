# Forestry
WoW Gameplay Logging Toolkit

## Install
On Windows, the runtimes should have come bundled in the `*.zip` just doubleclick `Forestry.bat`. On linux or for the no-deps version, you have to have `lua` or `lua54` @ `-v` == `5.4.x` and `node` @ `-v` >= `22.x.x` on `PATH`. If you do just run `./Forestry.sh`. If you don't good luck.

## Usage
Play WoW and leave the server on in the background, you can see your data at [localhost:3333](http://localhost:3333).
 
## Architecture
WoW doesn't have any APIs to exfiltrate data and I didn't want to do anything shady the way it works is it's just an addon like Auctioneer but it builds a database of all of your movements and casts and things. The size of this grows pretty quickly and it would start slowing down your WoW noticably after a few days of playtime accumulated. That's why there's a second part that runs outside of WoW and watches the /WTF/ folder. Every time you're logged out for more than a couple seconds the data is ingested into a database and then next load the addon garbage collects and deletes all the values that are confirmed to be in the external DB so you shouldn't lose data ever, and as long as you log off every once in a while and the server is on in the BG it should never log a problematic amount of stuff.

- **Lumberjack** - wow addon that logs data
  - `/lj help` 
- **Ranger** - wow addon that datamines strings for the UI
  - no interactivity, just runs alongside Lumberjack and updates the `internal_id -> english` dictionary so that any event you've seen has a human readable name
- **Sawmill** - main process that manages the database, archive, and ingest
  - has a built in visualization server that runs in the browser at localhost:3333
  - gives you a REST API for the data if you want to do things with it yourself

# Configuration
### `forestry.ini`
------------
```
[wow]    base_dir      — path to your WoW Anniversary install (the
                         folder containing Interface/, WTF/, Logs/)
[server] port          — HTTP port for the preview UI (default 3333)
[server] open_browser  — open browser on launch (true/false)
[paths]  db            — SQLite database file (see WSL note below)
[paths]  archive       — folder where raw captures are archived
```

WSL / Linux on a Windows drive
-------------------------------
If you are running Forestry.sh under WSL (Windows Subsystem for Linux)
and the install folder is on a Windows drive (/mnt/c, /mnt/d, etc.),
Forestry will automatically store the database and archive under
~/.local/share/forestry/ instead of next to Forestry.sh.

This is necessary because SQLite cannot reliably lock files on NTFS
mounts from inside WSL. If you leave the database on the Windows
filesystem you will see "disk I/O error" crashes when the UI tries to
query it.

If you move the install folder to a native Linux filesystem (e.g.
~/forestry/) the database will be placed next to Forestry.sh as normal.

You can always override both paths manually in forestry.ini.

Uninstall
---------
Delete this folder. Also delete Lumberjack and Ranger from
<your-wow>\Interface\AddOns\.

On WSL, also delete ~/.local/share/forestry/ if present.

Issues: github.com/thot-experiment/forestry 
