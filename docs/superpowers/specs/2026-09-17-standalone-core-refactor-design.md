# Standalone Core Refactor Design

## Goal

Refactor Simple Tab Groups into a self-contained Firefox extension focused on organizing, switching, and managing tab groups. Remove the internal plugin system, every cross-extension/external-system integration, cloud and native-host backup paths, and their maintenance burden while preserving core group behavior, local download backup/restore, and Tree Style Tab detection for opener restoration.

## Scope and Product Boundary

### Retained functionality

- Create, rename, switch, archive, restore, and delete tab groups.
- Move, hide, restore, and organize tabs across groups and browser windows.
- Existing container-aware group behavior, built-in menus, keyboard commands, local storage, and internal extension-page messaging.
- Backup export and restore through locally downloaded files.
- Automatic backups written through the Downloads API.
- Tree Style Tab enabled-state detection solely to decide whether saved tab opener relationships should be restored.

### Removed functionality

- The complete `plugins/` tree, including shared plugin modules and distribution scripts.
- All external runtime-message APIs: `runtime.onMessageExternal`, `runtime.sendMessage(extensionId, ...)`, sender allow-lists, outbound group-event fanout, and external-only request handlers.
- Compatibility with Gesturefy, Tridactyl, Tab Organizer, Panorama View, Sync Tab Groups, and every other external add-on or external system.
- Generic installed-extension inventory, add-on conflict detection, conflict warnings/help screens, remote add-on icon lookup, and container-reopen handling that relies on other add-on identities.
- Group Notes plugin migration and backup handling. No migration, warning, export, or attempt to modify Group Notes data is provided.
- GitHub Gist sync: its client, sync engine, UI, help pages, commands, alarms/retries, migrations, locale messages, and documentation.
- The Windows `host/` native-messaging companion, host backup destination/UI, native-messaging permission, and related source/documentation.

## Architecture

### Background application boundary

The background entry remains the runtime composition root. It initializes the extension, registers browser and internal runtime listeners, and routes messages originating from Simple Tab Groups itself. It must not expose a cross-extension protocol or contain recipient routing for external add-ons.

Cohesive behavior that currently makes the background entry difficult to maintain should be extracted only where it creates a clear ownership boundary. In particular:

- Tab restoration/creation owns its saved-tab reconstruction and opener restoration behavior.
- Local backup scheduling owns alarm-driven creation of downloadable backups.
- The background entry retains listener wiring and delegates to those focused behaviors.

This is a targeted refactor, not a rewrite of established group, tab, or window behavior.

### Tree Style Tab capability

Replace the broad extension-management registry with a narrow capability module. It knows only the supported Tree Style Tab extension IDs and asks `browser.management.get(id)` whether either is enabled.

The check is asynchronous and failure-safe: a missing extension, disabled extension, permission/API error, or unexpected management result means Tree Style Tab support is unavailable. Restoring tabs must still succeed; only opener-relationship restoration is skipped.

The manifest retains `management` exclusively for this capability. The new module must not enumerate installed extensions, subscribe to management events, load remote extension metadata/icons, or support arbitrary extension IDs.

### Core modules

- `groups.js`, `tabs.js`, `windows.js`, containers, menus, and internal Vue pages retain ownership of the current tab-group workflows.
- Integration-only group event/mapping code is deleted rather than retained as an empty abstraction.
- Internal `browser.runtime` messages continue to work between STG pages and background code, with an internal-sender check where required.
- Local import/export remains the only backup interchange. Automatic backups always target Downloads; no host or cloud destination remains.

## Data and Upgrade Behavior

Existing STG groups, tabs, containers, settings, and local exported backup files remain readable.

During startup/settings normalization, obsolete cloud- and host-only settings are removed or ignored, and any automatic-backup destination is normalized to Downloads. Cloud tokens, host paths, and sync state must not influence normal operation after upgrade.

Group Notes is intentionally outside the upgrade contract. The refactor silently removes the one-off Group Notes migration/backup exchange and never reads, transfers, deletes, or reports that separate extension's data.

Previously installed plugins and third-party callers stop receiving messages and cannot invoke STG actions through an external API.

## UI and Documentation

Remove plugin listings/status indicators, GitHub Gist configuration and help, native-host settings/help, conflict-extension screens, and documentation that advertises removed integrations or permissions.

Retain user-facing documentation for core group management, containers, local backup/restore, and Tree Style Tab behavior where relevant. Permissions documentation must reflect the reduced manifest; `management` is documented as Tree Style Tab detection only.

## Validation

1. Add a repository guard that fails when prohibited plugin, host, cloud-sync, or external-protocol files/tokens return.
2. Add focused tests for Tree Style Tab detection: enabled, disabled, missing, and management API failure.
3. Build the add-on and run the project’s lint/static validation.
4. Smoke-test core behavior: create/switch/move/archive/restore/delete groups, local export/import, and automatic backup download creation.
5. Smoke-test saved-tab restoration with Tree Style Tab enabled and disabled. In both cases tabs restore; opener relationships are restored only when Tree Style Tab is enabled.

## Explicit Non-goals

- Migrating Group Notes data into STG.
- Retaining backward compatibility for plugin or third-party external-message consumers.
- Retaining remote/cloud/native-host backup destinations.
- Broad architectural rewrites unrelated to simplifying these boundaries.
