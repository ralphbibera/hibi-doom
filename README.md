# Play Doom in Hibi

Play the first episode of Doom in a tab beside your notes. Switch to a note to pause the game, then return to resume the same session.

The engine is included. The first **Play Doom** downloads unchanged Doom 1.9 shareware from a [separate feed](https://gist.github.com/ralphbibera/1a077d178d8544746423ddd84a2ca1ef). Later games use verified cached data, including offline.

## Install and play

Use a Hibi build with addon API version 2. This repository is private. Install a local package from its owner or use the prepared `addon/` folder in a checkout.

Install the prepared package in Hibi:

If the owner supplies a ZIP, extract it first.

1. Choose **Install addon…** from the command palette.
2. Select the prepared addon folder containing `hibi-addon.json`.
3. Review **Doom** and the trust notice, then confirm installation.
4. Enable **Doom** under **Settings > Addons**. Hibi installs the addon disabled.
5. Choose **Play Doom** from the command palette or app menu. With the [titlebar compatibility build](https://github.com/ralphbibera/hibi-doom/blob/main/docs/development.md#prepare-the-development-tools), click the skull immediately left of the document view button in the window's top bar.

Connect to the internet for the first game. Doom shows download progress and starts automatically. You do not need Git, Node.js, or a manual engine or game download.

**Settings > Addons > Install from URL** also accepts a public HTTPS addon ZIP. It cannot download this private repository.

When the title appears, click the game, press `Enter`, and choose **New Game**, the first episode, and a difficulty. Run **Play Doom** again to return to an open game.

The titlebar skull requires the supplied Hibi compatibility patch. Stock Hibi API version 2 still provides **Play Doom** through the command palette and app menu. In the compatibility build, the skull stays visible when the formatting toolbar is hidden or full. You can hide it or choose **Menu only** under **Settings > Appearance > Arrange toolbar actions**. Menu-only actions appear under **More titlebar actions** in the top bar. Disabling or removing Doom removes its button.

## Controls

Move the mouse horizontally while the game has focus to turn and aim. Left click fires, and right click opens doors or uses switches. Vertical mouse movement is ignored.

The cursor stays visible. Holding a game mouse button keeps the drag active outside the canvas, but the cursor cannot move past the screen edge. Escape releases the drag and opens Doom's menu. Change **Mouse sensitivity** in Doom's **Options** menu to adjust turning speed.

Use these keys while the game has focus:

| Key | Action |
| --- | --- |
| Up or W, Down or S | Move forward or backward. |
| Left or Right | Turn left or right. |
| A or comma, D or period | Strafe left or right. |
| F | Fire. |
| Space | Open a door or use a switch. |
| Shift | Run. |
| Enter | Select a menu item. |
| Escape | Open the game menu. |
| Tab | Show the map. |
| Shift+Tab | Leave the game and reach Hibi's controls. |

Use **Pause** or **Resume** above the game. Doom also pauses when the game loses focus or Hibi's window is hidden. Click the game to resume.

Sound starts when you click the game or press a game key. Use **Mute** and **Volume** above the game to control it. Effects use Doom's original sound samples. Episode music plays the original scores through an approximate synthesizer, so the instruments differ from DOS Doom.

Pause and focus loss silence the game immediately. Returning to the game resumes its music at the current game position.

Closing the Doom tab or quitting Hibi ends the session. Reopening a closed tab starts a fresh game. Doom has no saved games or custom game-data support.

## Update or remove the addon

To update Doom, install the new prepared package and review the replacement. Enable **Doom** again after the update. Hibi installs replacements disabled.

To disable Doom, turn it off under **Settings > Addons**. To uninstall it, use the addon's remove button.

Cached game data stays on this device after uninstall. To remove the data, open **License and source** and choose **Clear cached game data** before uninstalling. Clearing the cache does not end a running game. The next new game downloads the data again.

## Resolve problems

- If installation fails, check your connection and confirm that the ZIP is publicly accessible. Hibi's URL installer cannot use a private repository.
- If **Play Doom** is missing, enable **Doom** under **Settings > Addons**.
- If the download or game fails, close the Doom tab and run **Play Doom** again. Reinstall if Hibi reports incomplete or changed package resources.
- If Doom reports that Hibi could not save its data, you can play that session. The next new game needs a connection.
- If keys do not control the game, click the game to focus it. `Shift+Tab` returns to Hibi's controls.
- If the game is silent, click it or press a game key, then check **Mute** and **Volume**. Doom reports an unavailable audio context below the canvas.

Report addon problems in [Hibi Doom issues](https://github.com/ralphbibera/hibi-doom/issues). Include your Hibi version, addon version, error message, and steps to reproduce the problem.

## License and source

Hibi Doom project code and its bundled engine use GNU GPL version 3 only, `GPL-3.0-only`, and come with no warranty.

The shareware data has separate id Software terms and is downloaded free of charge. The addon package and source archive contain no shareware data.

Open **License and source** in the game, or run **Doom license and source** from the command palette, to read the license and third-party notices.

Choose **Save corresponding source** to export this version's editable code and build inputs. The archive is included with the addon and works offline without repository access. Choose a new filename if the destination exists.

Read the [complete notices](addon/LICENSES.md) while Doom is disabled. Contributors can follow the [build and verification guide](https://github.com/ralphbibera/hibi-doom/blob/main/docs/development.md).
