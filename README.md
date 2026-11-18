
# <img width="48" src="addon/src/icons/noun_babylon_polshin.png" alt="main-icon"> Tabylon

## Usage

```bash
cd addon
npm install
npm run build
```

### `npm run build`

Build the extension into `dist` folder for **development**.

### `npm run watch`

Watch for modifications then run `npm run build`.

### `npm run build-zip`

Build a zip file following this format `<name>-v<version>-(dev|prod).zip`, by reading `name` and `version` from `manifest.json` file.
Zip file is located in `dist-zip` folder.

## Description

Tabylon is the current Firefox add-on in this repository, maintained by **mrietveld**. It was forked from the former Simple Tab Groups add-on; this project is now called **Tabylon**.

[Tabylon source repository](https://github.com/mrietveld/tabylon)

Tabylon works across browser instances/windows too. If you select a group in another window, the selected window will jump to the foreground with the chosen group selected. You can even select the specific tab within that group in background browser windows. [GIF example](https://user-images.githubusercontent.com/7843031/33828871-806ccf6e-de76-11e7-9a0e-1ddfb97e878d.gif)

This allows for easy switching between active and pre-loaded tabs across multiple browser windows.

### Smart organize

Smart organize proposes new tab groups for related tabs. To set it up, open **Settings** → **Smart Organizer**, enter the HTTP or HTTPS URL of the organizer service, choose a minimum group size, and select a default scope. The default local service URL is `http://127.0.0.1:5050`.

Use **Smart organize** in the popup to open the organizer. You can organize ungrouped tabs in the current window, the current group, selected tabs from the popup, or all eligible tabs across browser windows. Pinned and unsupported tabs are skipped and left unchanged.

When a plan is generated, Tabylon sends the titles and URLs of tabs in the chosen scope to the configured organizer service. Review its proposed groups before applying: rename or remove proposed groups, drag tabs between them, or leave tabs unassigned. The page uses Tabylon's internal messaging only; it does not expose an external-extension messaging interface.

Selecting **Apply groups** first checks that the planned tabs have not changed window, URL, or group since the plan was generated. Tabylon then creates the approved groups and moves the assigned tabs. If the plan is stale, generate a fresh one. If an apply operation cannot complete, inspect the recovery details and your groups before trying again.

Open popup shortcut: `F8`. [You can change this hotkey](https://support.mozilla.org/kb/manage-extension-shortcuts-firefox)

Current list of functionality / development notes:

* Design like old add-on "Tab Groups"
* Added colored group icon
* Added the ability to import the backup groups of the old plug-in "Tab Groups"
* Added support of "Firefox Multi-Account Containers"
* Now fully supports multiple windows
* Saves last active tab after change group
* Show currently used group in addon icon (see screenshot)
* Specially NOT supported Private (Incognito) Mode
* Added close tab by middle mouse click
* Added simple switching between groups and tabs in search mode using the up, down, right and left keys
* "Manage groups" functional is here! (so far only "Grid")
* Added support Drag&Drop for tabs and groups in popup window
* Added support sorting groups (context menu in popup window)
* Added field for search/filter tabs in "Manage Groups"
* Added support to Backup/Restore tabs, groups and settings to/from json file
* Custom group icons, set group icon from tab icon (by context menu)
* Added undo remove group by context menu browser button (see in screenshots)
* Added support for catch tabs by containers (#76)
* Added dark theme
* Added support SideBar

Permissions used:

* **tabs**: for tab handling
* **tabHide**: for hide tabs
* **contextualIdentities & cookies**: for work with Firefox Multi-Account Containers
* **notifications**: for notification on move tab to group etc.
* **menus**: for creating tabs context menus
* **sessions**: for save session data (last used group, etc)
* **downloads**: for create auto backups
* **management**: for automatically detect the required addons
* **storage**: for saving groups localy
* **unlimitedStorage**: restore tabs after close window, there can be a lot of tabs
* **<all_urls>(Access your data for all websites)**: for tab thumbnails and catch/move/reopen tabs in needed containers/groups
* **webRequest** & **webRequestBlocking**: for catch/move/reopen tabs in needed containers/groups</li>
* **(optional) bookmarks**: access for create bookmarks

## License and Credits

This project is licensed under the terms of the [Mozilla Public License 2.0](LICENSE).
